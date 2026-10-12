/**
 * 内核测试用的假通道 + 假 agent —— **故意用 TypeScript 写**。
 *
 * 假通道继承真实的 `ChannelService`、假 agent 继承真实的 `AgentService`，
 * 所以内核不只是"跑起来对"，还**对着 seam 的类型编译得过**。
 */
import z from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';
import type { InboundMessage, LocalFile, SendOpts, SendResult } from '@butler/seam-channel';
import { LinkService } from '@butler/seam-link';
import type { DeviceInfo, LinkRequestOpts, LinkSession } from '@butler/seam-link';
import { MemoryService } from '@butler/seam-memory';
import { ApprovalService } from '@butler/seam-approval';
import type { ApprovalBy, ApprovalDecision, ApprovalRequest } from '@butler/seam-approval';
import type { MemoryEntry, MemoryFilter, MemoryKind, MemoryMeta } from '@butler/seam-memory';
import { AgentService } from '@butler/seam-agent';
import type { AgentErrorCode, AgentRequest, AgentResult } from '@butler/seam-agent';

export class FakeChannel extends ChannelService {
  readonly id = 'fake';
  readonly sent: { to: string; text: string; opts?: SendOpts }[] = [];
  readonly sentFiles: { to: string; path: string; opts?: SendOpts }[] = [];
  readonly typing: { to: string; on: boolean }[] = [];
  started = false;
  startCount = 0;
  /** 让 start() 抛错，用来验证内核会不会把启动失败如实报出来 */
  startError: Error | null = null;
  /** 让发送失败，用来验证"发不出去"这条路 */
  sendError: Error | null = null;

  constructor(ctx: Context) {
    super(ctx);
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async sendText(to: string, text: string, opts?: SendOpts): Promise<SendResult> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ to, text, opts });
    return { chunks: 1 };
  }

  async sendFile(to: string, path: string, opts?: SendOpts): Promise<SendResult> {
    if (this.sendError) throw this.sendError;
    this.sentFiles.push({ to, path, opts });
    return { fileName: path.split('/').pop(), size: 7 };
  }

  override async setTyping(to: string, on: boolean): Promise<void> {
    this.typing.push({ to, on });
  }

  /** 测试用：模拟通道收到一条消息 */
  push(msg: Partial<Omit<InboundMessage, 'channel'>> = {}, files?: LocalFile[]): void {
    this.emitMessage({ channel: this.id, fromId: 'u1', contextToken: 'tk', ...msg, files });
  }

  /** 只看发出去的文本，方便断言 */
  texts(): string[] {
    return this.sent.map((s) => s.text);
  }

  /**
   * 等到通道上不再冒新回话为止（一小段安静期）。
   *
   * 一轮里可能不止一条：刚认下主人时管家会**先说一句**"我是你的管家"再说正事，
   * 长活儿中间还会插"还在处理"。所以"进一条就断言"的写法必须先等它安静下来 ——
   * 不然用例会在活儿还没干的时候就开始查状态，假红。
   */
  async settle(quietMs = 60, maxMs = 3000): Promise<void> {
    const until = Date.now() + maxMs;
    let last = this.sent.length;
    for (;;) {
      await new Promise((r) => setTimeout(r, quietMs));
      const now = this.sent.length;
      if (now === last) return;
      last = now;
      if (Date.now() > until) return;
    }
  }
}

export interface FakeAgentConfig {
  reply: string;
  error: string;
  code: string;
  delayMs: number;
  files: string[];
  /** 无条件 Promise，用来测"停机时不等它跑完" */
  hang: boolean;
  /** 开局就报一条进度，用来测内核会不会把它播报出去 */
  progress: string;
}

export class FakeAgent extends AgentService {
  static Config = z.object({
    reply: z.string().default('好的'),
    error: z.string().default(''),
    code: z.string().default(''),
    delayMs: z.number().default(0),
    files: z.array(z.string()).default([]),
    hang: z.boolean().default(false),
    progress: z.string().default(''),
  });

  readonly id = 'fake';
  override readonly label = '假 agent';
  override readonly cancellable = true;

  readonly seen: AgentRequest[] = [];
  /** 测试可以在加载后改它，按调用次数定制每一次的行为 */
  hook: ((req: AgentRequest, n: number) => AgentResult | void) | null = null;
  /** 被 abort 的次数 */
  aborted = 0;

  constructor(ctx: Context, readonly config: FakeAgentConfig) {
    super(ctx);
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.seen.push(req);
    const n = this.seen.length;

    if (this.config.progress) req.onProgress?.(this.config.progress);

    if (this.config.hang) {
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) { this.aborted += 1; resolve(); return; }
        req.signal?.addEventListener('abort', () => { this.aborted += 1; resolve(); }, { once: true });
      });
      return { sessionId: null, text: '(被掐断了)' };
    }

    if (this.config.delayMs) {
      await new Promise((r) => { setTimeout(r, this.config.delayMs); });
    }

    const fromHook = this.hook?.(req, n);
    if (fromHook) return fromHook;

    return {
      sessionId: `s-${n}`,
      text: this.config.reply,
      error: this.config.error || null,
      ...(this.config.code ? { code: this.config.code as AgentErrorCode } : {}),
      files: this.config.files.map((p) => ({ path: p })),
    };
  }
}

/** 造一台设备（测试里少写点字） */
export function device(id: string, alias: string, online = true, lastSeen: number | null = null): DeviceInfo {
  return { id, alias, os: 'darwin', capabilities: ['agent'], lastSeen, online, link: 'lan' };
}

/**
 * 假链路：设备列表、连不上、远端进度、远端结果全由测试摆布。
 *
 * 继承真实的 `LinkService` —— 所以内核那段路由不只是"跑起来对"，
 * 还**对着 `ctx.link` 的类型编译得过**。
 */
export class FakeLink extends LinkService {
  readonly id = 'fake-link';

  readonly devices: DeviceInfo[] = [];
  discoverError: Error | null = null;
  /** 设了就连不上（模拟那台电脑关机） */
  connectError: Error | null = null;
  reply = '远端干完了';
  resultSessionId: string | null = 'r-1';
  resultError = '';
  /** 远端"在自己那台机器上"生成了几个文件 */
  filesOnNode = 0;
  /** 远端会报的进度行 */
  progress: string[] = [];
  /**
   * 远端"交出来"的附件：token → 内容。
   * `agent.run` 会把这些凭证报回来，中枢再拿 token 调 `file.read` 取字节。
   */
  readonly remoteFiles = new Map<string, { name: string; caption?: string; data: Buffer }>();
  /** 设了就每次 `file.read` 都失败（模拟取到一半那台电脑掉线） */
  readError: Error | null = null;
  /** 取件请求。用来验证**真的是分块取的**，而不是一口气读进内存 */
  readonly reads: { token: string; offset: number }[] = [];

  /** 测试关心的：链路到底有没有被调、用什么参数调的 */
  readonly calls: { deviceId: string; method: string; params: unknown }[] = [];
  closed = 0;

  constructor(ctx: Context) {
    super(ctx);
  }

  async discover(): Promise<DeviceInfo[]> {
    if (this.discoverError) throw this.discoverError;
    return this.devices;
  }

  async connect(deviceId: string): Promise<LinkSession> {
    if (this.connectError) throw this.connectError;
    const self = this;
    return {
      deviceId,
      async request(method: string, params: unknown, opts?: LinkRequestOpts): Promise<unknown> {
        self.calls.push({ deviceId, method, params });

        if (method === 'file.read') {
          const q = (params ?? {}) as { token?: string; offset?: number };
          const token = q.token ?? '';
          const offset = q.offset ?? 0;
          self.reads.push({ token, offset });
          if (self.readError) throw self.readError;
          const f = self.remoteFiles.get(token);
          if (!f) throw new Error('这个附件的取件凭证已经失效了');
          // 跟真实节点一样的块大小（512 KiB）
          const len = Math.max(0, Math.min(512 * 1024, f.data.length - offset));
          return {
            name: f.name,
            caption: f.caption,
            size: f.data.length,
            offset,
            eof: offset + len >= f.data.length,
            data: f.data.subarray(offset, offset + len).toString('base64'),
          };
        }

        if (method === 'file.drop') {
          self.remoteFiles.delete(((params ?? {}) as { token?: string }).token ?? '');
          return { ok: true };
        }

        for (const line of self.progress) opts?.onEvent?.({ type: 'progress', callId: 'c1', line });
        if (self.resultError) return { error: self.resultError, sessionId: null };
        const files = [...self.remoteFiles.entries()].map(([token, f]) => ({
          token, name: f.name, caption: f.caption,
        }));
        return {
          text: self.reply,
          sessionId: self.resultSessionId,
          ...(self.filesOnNode ? { filesOnNode: self.filesOnNode } : {}),
          ...(files.length ? { files } : {}),
        };
      },
      onClose: () => () => {},
      async close() { self.closed += 1; },
    };
  }
}

/**
 * 一个**支持配对**的链路。
 *
 * 分成两个假实现是故意的：名册由外部权威决定的链路（尾巴网络那种）
 * **本来就不该有 `pair`** —— 内核要能对着这种链路说"这条不用配对"。
 * 一个假实现包打天下的话，那条分支就永远测不到。
 */
export class FakePairingLink extends FakeLink {
  /** 收到的配对请求 —— 内核到底把什么参数递下来了 */
  readonly pairs: { host: string; port?: number; code: string }[] = [];
  /** 设了就配对失败（模拟"配对码不对"） */
  pairError: Error | null = null;
  /** `forget` 的结论，由测试摆布 */
  forgetVerdict: 'forgotten' | 'unknown' | 'static' = 'forgotten';
  readonly forgotten: string[] = [];

  override async pair(target: { host: string; port?: number; code: string }): Promise<DeviceInfo> {
    this.pairs.push(target);
    if (this.pairError) throw this.pairError;
    const d = device(`node-${this.pairs.length}`, '新收的那台', true, Date.now());
    this.devices.push(d);
    return d;
  }

  override async forget(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'> {
    this.forgotten.push(deviceId);
    if (this.forgetVerdict === 'forgotten') {
      const at = this.devices.findIndex((d) => d.id === deviceId);
      if (at >= 0) this.devices.splice(at, 1);
    }
    return this.forgetVerdict;
  }
}

/**
 * 全在内存里的假记忆 —— 用来验内核**有没有真的在用它**。
 *
 * 真实现（`@butler/memory-file`）自己有 9 条测试；这里要验的是另一件事：
 * 内核会不会把记忆贴给 agent、命令会不会真的落进记忆、记忆坏了会不会把消息卡住。
 *
 * `broken` 一设就抛，专门用来验最后那一条。
 */
export class FakeMemory extends MemoryService {
  readonly id = 'fake';
  readonly rows = new Map<string, {
    value: unknown;
    kind: MemoryKind;
    createdAt: string;
    updatedAt: string;
    seq: number;
  }>();
  /** 设了就抛 —— 用来验"记忆读不动也不能让消息发不出去" */
  broken: Error | null = null;
  private tick = 0;

  constructor(ctx: Context) {
    super(ctx);
  }

  private guard(): void {
    if (this.broken) throw this.broken;
  }

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }

  async get(key: string): Promise<unknown> {
    this.guard();
    return this.rows.get(key)?.value;
  }

  async set(key: string, value: unknown, meta?: MemoryMeta): Promise<void> {
    this.guard();
    const k = key.trim();
    const was = this.rows.get(k);
    const now = this.now();
    this.rows.set(k, {
      value,
      kind: meta?.kind ?? was?.kind ?? 'preference',
      createdAt: was?.createdAt ?? now,
      updatedAt: now,
      seq: (was?.seq ?? 0) + 1_000_000 + this.tick,   // 写上就变最新
    });
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    this.guard();
    const all = [...this.rows.entries()]
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([key, r]): MemoryEntry => ({
        key, value: r.value, kind: r.kind, createdAt: r.createdAt, updatedAt: r.updatedAt,
      }));
    const byKind = filter?.kind === undefined ? all : all.filter((e) => e.kind === filter.kind);
    return filter?.limit === undefined ? byKind : byKind.slice(0, filter.limit);
  }

  async forget(key: string): Promise<void> {
    this.guard();
    this.rows.delete(key);
  }
}

/**
 * 假审批 —— 只够跑"管家这一侧"的规矩：念清单、按编号批、清单变了不许硬猜。
 *
 * 真实现是 `approval-im`（文件和应答者那一套），它的规矩在自己的包里测。
 * 这里故意**不做**超时结算：内核不看超时，超时是"不许"由实现包负责。
 */
export class FakeApproval extends ApprovalService {
  readonly id = 'fake';
  /** 待批，旧的在前 */
  readonly pending: ApprovalRequest[] = [];
  /** 批过的记在这儿，用来断言"到底批了哪一件" */
  readonly answered: { id: string; decision: ApprovalDecision; by: ApprovalBy }[] = [];
  /** 打开它就让每个方法都炸，用来验"读不动要如实说" */
  broken: Error | null = null;

  private seq = 0;

  /** 挂一件事上去（dsh 那侧的应答者干的就是这件事） */
  ask(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
    this.seq += 1;
    const now = Date.now();
    const req: ApprovalRequest = {
      id: over.id ?? `a${this.seq}`,
      agent: over.agent ?? 'dsh',
      tool: over.tool ?? 'bash',
      reason: over.reason ?? '执行一条命令',
      createdAt: over.createdAt ?? new Date(now).toISOString(),
      expiresAt: over.expiresAt ?? new Date(now + 600_000).toISOString(),
      ...(over.displayReason === undefined ? {} : { displayReason: over.displayReason }),
      ...(over.callId === undefined ? {} : { callId: over.callId }),
    };
    this.pending.push(req);
    return req;
  }

  async list(): Promise<ApprovalRequest[]> {
    if (this.broken) throw this.broken;
    return [...this.pending];
  }

  async answer(id: string, decision: ApprovalDecision, by: ApprovalBy = 'owner'): Promise<boolean> {
    if (this.broken) throw this.broken;
    const i = this.pending.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    this.answered.push({ id, decision, by });
    return true;
  }
}
