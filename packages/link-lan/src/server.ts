/**
 * 局域网链路的**节点侧** —— 那台"被遥控的电脑"上跑的东西。
 *
 * 它只做三件事：**认（认证）、派（分发到方法）、流（把进度和结果回传）**。
 * 它不认识 agent、不认识微信 —— 那些是注册进来的方法自己的事。
 *
 * @module @butler/link-lan
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostname, platform } from 'node:os';

import { newPairCode, newSecret, samePairCode } from './identity.js';
import { PROTOCOL_VERSION, encodeFrame, isServerFrame } from './protocol.js';
import type { RpcRequest, ServerFrame } from './protocol.js';

/** 一次调用里，方法能用的东西 */
export interface CallContext {
  /** 报一行给用户看的进度。中枢会把它转述到微信里 */
  emit(line: string): void;
  /** 调用方取消了（或断了）。**长任务应当尊重它** */
  signal: AbortSignal;
}

export type MethodHandler = (params: unknown, ctx: CallContext) => Promise<unknown>;

export interface LanNodeOptions {
  /** 稳定 id。**一旦定下就别改** —— 用户的「以后都放那台电脑上」指的是它 */
  id: string;
  /** 人给的名字，例如「家里那台」 */
  alias?: string;
  /**
   * 这台机器自己的密钥。
   *
   * **不传就当场生成一个**（见 `identity.ts`）。注意这里的变化：
   * 以前是"用户在两台机器的配置里各抄一份一样的密钥"，现在
   * **密钥由节点自己生成、存在自己的状态目录里、靠配对码交给中枢** ——
   * 用户全程看不见它，也就抄不错。
   *
   * 但它**永远不为空**：局域网是共享介质，同一个咖啡馆 WiFi 上任何人
   * 都够得着这个端口，没有认证的节点就是把"遥控这台电脑"敞开。
   */
  secret?: string;
  /** 监听端口。`0` = 让系统随便给一个（测试用） */
  port?: number;
  /** 监听地址。默认 `0.0.0.0`（局域网里别的机器才够得着） */
  host?: string;
  /** 这台机器能干什么，会随 `link.ping` 报出去 */
  capabilities?: string[];
  /** 配对码多久过期。默认 30 分钟 */
  pairTtlMs?: number;
}

/** 握手应答 —— 中枢靠它知道对面是谁 */
export interface PingResult {
  protocol: string;
  id: string;
  alias: string;
  os: string;
  capabilities: string[];
}

export class LanNode {
  readonly id: string;
  readonly alias: string;
  readonly capabilities: string[];

  /** 这台机器自己的密钥。配对时原样交给中枢，测试也要用，所以是公开的 */
  readonly secret: string;
  readonly pairTtlMs: number;

  private pairCode: string;
  private pairCodeAt: number;
  /**
   * 配对码的三种死法，分开记是因为**要跟用户说清楚是哪种**：
   * 已经用过了 / 试错太多次作废了 / 过期了 —— 用户接下来要做的事不一样。
   */
  private pairState: 'live' | 'used' | 'burned' = 'live';
  private pairFails = 0;

  private readonly wantPort: number;
  private readonly wantHost: string;
  private readonly methods = new Map<string, MethodHandler>();
  /** 正在进行的响应，stop() 时要一起收掉，否则测试会挂住 */
  private readonly open = new Set<ServerResponse>();
  private server: Server | null = null;
  private boundPort = 0;
  private started = false;

  /** 配对码试错几次就作废。留着不限次数等于留了个可以慢慢猜的口子 */
  static readonly MAX_PAIR_FAILS = 5;

  constructor(options: LanNodeOptions) {
    this.id = options.id;
    this.alias = options.alias ?? hostname();
    // 没给就自己生成 —— 见 identity.ts 开头那段：让用户手抄密钥就是让用户卡住
    this.secret = options.secret || newSecret();
    this.pairTtlMs = options.pairTtlMs ?? 30 * 60_000;
    this.pairCode = newPairCode();
    this.pairCodeAt = Date.now();
    this.wantPort = options.port ?? 41338;
    this.wantHost = options.host ?? '0.0.0.0';
    this.capabilities = options.capabilities ?? ['agent'];

    // 内置握手：中枢的 discover() 靠它判断"连得上"，不需要节点额外注册
    this.on('link.ping', async () => this.ping());
  }

  // ───────────────────────── 配对 ─────────────────────────

  /** 当前配对码（形如 `4A7-K2M`）。打印给用户看的就是它 */
  get pairingCode(): string {
    return this.pairCode;
  }

  /** 这个码什么时候过期（epoch ms） */
  get pairingExpiresAt(): number {
    return this.pairCodeAt + this.pairTtlMs;
  }

  /** 配对的现状，给 `butler node` 决定要不要打那一行 */
  get pairingState(): 'live' | 'used' | 'burned' {
    return this.pairState;
  }

  /** 换一个新码（`--pair` 重新配对，或者"作废了重来"） */
  refreshPairCode(): string {
    this.pairCode = newPairCode();
    this.pairCodeAt = Date.now();
    this.pairState = 'live';
    this.pairFails = 0;
    return this.pairCode;
  }

  /**
   * 拿一个配对码来换身份和密钥。
   *
   * 返回值是**结论**，不是人话 —— 人话由调用处拼（"在那台电脑上重启一次"这种话
   * 属于命令行，不属于这里）。
   */
  tryPair(got: string): 'ok' | 'wrong' | 'used' | 'expired' | 'burned' {
    if (this.pairState !== 'live') return this.pairState;
    if (Date.now() > this.pairingExpiresAt) return 'expired';

    if (samePairCode(got, this.pairCode)) {
      this.pairState = 'used';       // 一次性：换完这一把就作废
      return 'ok';
    }

    if (++this.pairFails >= LanNode.MAX_PAIR_FAILS) {
      this.pairState = 'burned';
      return 'burned';
    }
    return 'wrong';
  }

  /** 配对成功时交出去的东西：我是谁 + 我的密钥 */
  pairPayload(): PingResult & { secret: string } {
    return { ...this.ping(), secret: this.secret };
  }

  /** 这个节点是谁。`link.ping` 的返回，也可以直接被 doctor 用 */
  ping(): PingResult {
    return {
      protocol: PROTOCOL_VERSION,
      id: this.id,
      alias: this.alias,
      os: platform(),
      capabilities: [...this.capabilities],
    };
  }

  /** 注册一个能被远程调用的方法 */
  on(method: string, handler: MethodHandler): void {
    this.methods.set(method, handler);
  }

  /** 实际监听的端口（`port: 0` 时由系统分配，所以要听完了才知道） */
  get port(): number {
    return this.boundPort;
  }

  /** 中枢该连过来的地址 */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}/butler/call`;
  }

  async start(): Promise<void> {
    if (this.started) return;                  // 幂等：重复调用不该起两个
    const server = createServer((req, res) => { void this.handle(req, res); });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      server.once('error', onError);
      server.listen(this.wantPort, this.wantHost, () => {
        server.off('error', onError);
        const addr = server.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.wantPort;
        resolve();
      });
    });
    this.started = true;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.started = false;
    if (!server) return;

    // 先把挂着的响应收掉，再关监听 —— 否则 in-flight 的 SSE 会让 close 一直等
    for (const res of [...this.open]) {
      try { res.end(); } catch { /* 已经断了就算了 */ }
    }
    this.open.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.startsWith('/butler/call')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '没有这个接口' }));
      return;
    }

    // 配对是**唯一**一个"还没有密钥也能进来"的请求：凭据是那串一次性配对码。
    // 注意认证仍然在**读第一个字节之前**做完 —— 只是这里换一个凭据来认，
    // 不是"先读请求再判断"。
    const pairHeader = req.headers['x-butler-pair'];
    if (typeof pairHeader === 'string' && pairHeader) {
      const verdict = this.tryPair(pairHeader);
      if (verdict !== 'ok') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: PAIR_FAIL_TEXT[verdict] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(encodeFrame({ type: 'done', result: this.pairPayload() }));
      return;
    }

    // 认证在**读第一个字节之前**做完。不做流式鉴权 —— 那样未授权的请求
    // 已经能把数据写进来了，只是回不回给你而已。
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '密钥不对' }));
      return;
    }

    let body: RpcRequest;
    try {
      body = JSON.parse(await readBody(req)) as RpcRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
      return;
    }

    if (body?.protocol !== PROTOCOL_VERSION) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: `协议版本对不上：我这边是 ${PROTOCOL_VERSION}，你那边是 ${String(body?.protocol)}。两边的 butler 得升到同一版`,
      }));
      return;
    }

    const handler = this.methods.get(String(body.method));
    if (!handler) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(encodeFrame({ type: 'error', message: `这个节点不认识方法 ${String(body.method)}`, code: 'NO_METHOD' }));
      return;
    }

    // ── 从这里开始是流 ──
    const ctrl = new AbortController();
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    this.open.add(res);

    let ended = false;
    const write = (frame: ServerFrame) => {
      if (ended || !isServerFrame(frame)) return;
      try { res.write(encodeFrame(frame)); } catch { ended = true; }
    };

    req.on('aborted', () => { ctrl.abort(); ended = true; });
    res.on('close', () => {
      this.open.delete(res);
      if (!ended) { ended = true; ctrl.abort(); }   // 对面断了 = 取消，别让长任务白跑
    });

    try {
      const result = await handler(body.params, { emit: (line) => write({ type: 'progress', line }), signal: ctrl.signal });
      write({ type: 'done', result: result ?? null });
    } catch (error) {
      // 失败必须说，而且要说得像人话（错误原文可能就是人话，原样转述）
      const message = error instanceof Error ? error.message : String(error);
      write({ type: 'error', message, code: (error as { code?: string })?.code });
    } finally {
      ended = true;
      this.open.delete(res);
      try { res.end(); } catch { /* 对面早走了 */ }
    }
  }

  /**
   * 常量时间比较密钥。
   *
   * 用 `timingSafeEqual` 而不是 `===`：`===` 会在第一个不同的字符上返回，
   * 逐字节试就能把密钥试出来。局域网里攻击者离得近，这种时间侧信道是现实的。
   */
  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const got = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(got);
    const b = Buffer.from(this.secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/**
 * 配对失败时回给中枢的话。
 *
 * 这几句会被中枢原样转述到微信里，所以**要说清楚下一步做什么**：
 * "码不对"和"码过期了"用户要做的事完全不同（重看一眼 vs 重起那台机器）。
 */
const PAIR_FAIL_TEXT: Record<'wrong' | 'used' | 'expired' | 'burned', string> = {
  wrong: '配对码不对。对着那台电脑屏幕上的那一串再抄一次（横线和空格无所谓）',
  used: '这个配对码已经用过了。配对码是一次性的，在那台电脑上重新起一次 butler node 会给出新的',
  expired: '这个配对码过期了。在那台电脑上重新起一次 butler node 会给出新的',
  burned: '这个配对码试错太多次，已经作废。在那台电脑上重新起一次 butler node 会给出新的',
};

/** 读完整个请求体，带上限 —— 不设上限的话一个坏客户端能把内存吃光 */
function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
