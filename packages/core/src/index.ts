/**
 * AI 管家的**内核** —— 把 `ctx.channel` 收到的消息交给 `ctx.agent`，再把结果发回去。
 *
 * ── 它在整个系统里的位置 ─────────────────────────────────────────
 *
 *     手机 ──微信──> ctx.channel ──> 本内核 ──> ctx.agent ──> 这台电脑
 *                                      │
 *                                      ├── ctx.link ──> 别的电脑（你 @ 了才走）
 *                                      └── 认人、认路、排队、进度、回话
 *
 * 内核**只认两个能力位**，不认微信、也不认 dsh：
 * 换通道、换大脑都不需要改这里一行代码。
 *
 * ── 它负责的五件事 ──────────────────────────────────────────────
 *
 * 1. **认人（安全边界）。** 只有主人能让这台电脑干活。名单配置了就用名单，
 *    没配置就**第一次说话的人认主**（只认一次，不能被顶掉）。
 *    通道里那个 `allowFrom` 只是粗筛，**这里才是真正的门**。
 * 2. **排队。** agent 是"一问一答"，前面没跑完不会跑下一条；
 *    排队时说清楚"前面还有几条"，积压太多就明确拒收而不是悄悄丢。
 * 3. **让等待可见。** agent 一跑可能几分钟。不发"正在输入"、不报进度的话，
 *    用户看到的就是"没反应"。每隔一段时间会把**最近一条 agent 进度**一起报出去。
 * 4. **如实回话。** 出错就说错在哪，没出结果就说没出结果——静默失败是禁止的。
 * 5. **认路（默认本机）。** 只有 `@别名` 才跨设备；没 `@` 就在这台电脑上办。
 *    见 `route.ts` —— 那里解释了为什么**故意不做**"话里提到就送过去"的隐式猜测。
 *
 * ── 生命周期 ────────────────────────────────────────────────────
 *
 * 加载 ≠ 上线。构造函数只做接线（订阅通道消息），
 * 由外部显式调用 `start()` 才会真的开始收信。
 *
 * @module @butler/core
 */

import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import { existsSync, accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { HealthCheck, InboundMessage, LocalFile } from '@butler/seam-channel';
import type { AgentResult, OutboundFile } from '@butler/seam-agent';
import type { DeviceInfo, LinkSession } from '@butler/seam-link';
import type { MemoryService } from '@butler/seam-memory';
import { addGrant, grantsFileOf, kindOf, liveGrants, parseGrantWindow, readGrants, readGrantsOr, removeGrant, type Grant } from './grants.js';
import { butlerOnPathCheck } from './butler-path.js';
import { butlerHome } from './home.js';
import { welcomeText } from './welcome.js';
import {
  collectSelfCheck, formatSelfCheck, formatSelfCheckBroke,
  type Checkable, type SelfCheckReport,
} from './selfcheck.js';
import type { ApprovalRequest, ApprovalService } from '@butler/seam-approval';
import { SessionStore } from './sessions.js';
import { commandHelp, describeForUser, findDevice, osName, parseCommand } from './commands.js';
import {
  MEMORY_PREAMBLE_MAX,
  formatAutoRememberAck,
  formatForgotten,
  formatMemoryList,
  formatNoSuchMemory,
  formatRememberAck,
  memoryLine,
  memoryPreamble,
  parseMemoryMark,
} from './memory.js';
import {
  formatAllowed,
  formatAlreadyGone,
  formatApprovalAsk,
  formatApprovalBroken,
  formatDenied,
  formatNeedIndex,
  formatNoApproval,
  formatNoSuchPending,
  formatNothingWaiting,
  formatPending,
  formatGranted, formatGrants, formatGrantsBroken, formatGrantWindowUnclear, formatNoSuchGrant, formatRevoked,
} from './approval.js';
import { describeDevices, parseAddress } from './route.js';
import { quotedMedia } from '@butler/seam-channel';
import { defaultPrompt, errText, filesHint, quoteContext } from './text.js';

export * from './text.js';
export * from './route.js';
export * from './commands.js';
export * from './selfcheck.js';
export * from './home.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    core: ButlerCore;
  }
}

export interface CoreConfig {
  /** agent 在哪干活。空 = 进程当前目录 */
  workspace: string;
  /** 谁能遥控这台电脑。**空数组 = 第一次说话的人认主** */
  allowFrom: string[];
  /** 账本落到哪（主人 + 会话）。空 = 只记内存，重启就忘 */
  stateFile: string;
  /** 最多积压几条。超了明确拒收，不静默丢 */
  maxQueue: number;
  /** 长任务每隔多久报一次"还在处理"。0 = 不报 */
  progressIntervalMs: number;
  /** 回话时带一行"这是在回哪句" */
  quoteReply: boolean;
  /** 发"正在输入" */
  typing: boolean;
  /** 管家在回答里写 `[[记住: …]]` 就自动记下 */
  autoMemory: boolean;
  /** 每隔多久看一眼有没有"要动你电脑"的事在等主人。0 = 不看（一律按不许） */
  approvalIntervalMs: number;
}

/**
 * 管家的内核。
 *
 * 它注册成 `ctx.core` —— 注意这**不是**那 5 个能力位之一
 * （`ctx.channel` / `ctx.agent` / `ctx.link` / `ctx.approval` / `ctx.memory`
 * 是"可替换的能力"）。`ctx.core` 是**应用自己**：一个进程里只有一个，
 * 注册成服务是为了让命令行、`doctor` 这些地方能拿到它问状态、叫它启停。
 */
export class ButlerCore extends Service {
  /** 只认这两个能力位 —— 换通道、换大脑都不用改这个文件 */
  static inject = ['channel', 'agent'];

  static Config = z.object({
    workspace: z.string().default(''),
    allowFrom: z.array(z.string()).default([]),
    stateFile: z.string().default(''),
    maxQueue: z.number().default(5),
    progressIntervalMs: z.number().default(40_000),
    quoteReply: z.boolean().default(true),
    typing: z.boolean().default(true),
    approvalIntervalMs: z.number().default(2_000),
    // 管家在回答里写 [[记住: …]] 就自动记下（说了什么就记什么，不替主人猜）
    autoMemory: z.boolean().default(true),
  });

  readonly config: CoreConfig;
  private readonly log: (msg: string) => void;
  private readonly sessions: SessionStore;
  /** 长期授权记在哪（`state/grants.json`，跟状态文件同一个目录） */
  private readonly grantsFile: string;
  /** 主人**看过**的那份待批清单（编号以它为准）。空 = 还没念过 */
  private approvalPrinted: string[] = [];
  /** 盯着待批目录的定时器 */
  private approvalTimer: NodeJS.Timeout | null = null;
  /** 刚刚认下的那个人（还没跟他说开场白）。`allow()` 是同步的，只能说一声放这儿 */
  private newOwner: string | null = null;
  /** 最近一条来信：审批是它引出来的，推送就用它的会话令牌 */
  private lastInbound: InboundMessage | null = null;
  private readonly onInbound: (msg: InboundMessage) => void;

  private queue: InboundMessage[] = [];
  private started = false;

  /** 从别的电脑取回来的附件暂时落在这儿（发完就删，停机清空） */
  private remote: string | null = null;
  private stopping = false;
  private worker?: Promise<void>;
  private wake: (() => void) | null = null;
  private current: AbortController | null = null;
  private lastProgress: string | null = null;
  /** 此刻有没有一轮正在跑。用来算"前面排了几条"——在跑的那条也算一条 */
  private busy = false;

  constructor(ctx: Context, config: CoreConfig) {
    super(ctx, 'core');
    this.config = config;
    this.log = (m) => ctx.logger?.info?.(`[core] ${m}`);
    this.sessions = new SessionStore(config.stateFile);
    this.grantsFile = grantsFileOf(config.stateFile, butlerHome());

    this.onInbound = (msg) => {
      // ⚠️ `.catch` 不是装饰：`onMessage` 是 async，而接缝的 `emitMessage` 只接得住
      //    **同步**抛错（见 seam-channel/src/index.ts 那句注释）。这里漏出去会变成
      //    unhandled rejection —— Node 默认把它升级成进程退出，也就是"某条消息入队时
      //    出错，整个管家没了"。
      //    注意分工：agent **干活**那条路另有保护（`loop()` 里 try/catch，还会回用户一句
      //    "我这边出错了"）；这里兜的是**入队**这一步 —— 认主、写状态文件都可能在这一步失败。
      void this.onMessage(msg).catch((error) => {
        this.log(`收信这一步出错了（这条先丢掉）：${errText(error)}`);
      });
    };
    ctx.channel.onMessage(this.onInbound);

    ctx.effect(() => () => {
      ctx.channel.offMessage(this.onInbound);
      return this.stop();
    }, 'core.stop');
  }

  /** agent 干活的地方 */
  get cwd(): string {
    return this.config.workspace || process.cwd();
  }

  /** 当前主人。没认领过就是 null */
  get owner(): string | null {
    return this.sessions.getOwner();
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  /**
   * 自检 —— 内核这一层能看到别人看不到的三件事：
   * **工作目录通不通**、**这台机器认了谁当主人**，以及
   * **管家自己的 PATH 里有没有 `butler`**（见 `butler-path.ts`：只有这个进程
   * 知道自己的 PATH，所以这条判据只能落在这儿）。
   *
   * 认主这条是"我发消息它不理我"的头号原因：管家只认第一个跟它说话的人，
   * 认了就不再改。换个微信号发消息，它会一声不吭 —— 这行为是对的（安全），
   * 但用户完全看不出来，所以自检必须把它说出来。
   *
   * PATH 那条是"在微信里跟它说一句、让它自己做"的前提：管家干活在子 shell 里，
   * 那里继承的就是这个进程的 PATH。它报 ✗ 时，"让它自己设开机自启"这条路是断的。
   */
  check(): HealthCheck[] {
    const out: HealthCheck[] = [];

    const dir = this.cwd;
    if (!existsSync(dir)) {
      out.push({
        name: '工作目录',
        ok: false,
        detail: `${dir} 不存在`,
        fix: '把这个目录建出来，或者把配置里的 workspace 改成别的目录',
      });
    } else {
      try {
        accessSync(dir, constants.W_OK);
        out.push({ name: '工作目录', ok: true, detail: `${dir}（agent 就在这儿干活）` });
      } catch {
        out.push({
          name: '工作目录',
          ok: false,
          detail: `${dir} 写不进去`,
          fix: '检查目录权限 —— agent 要在里面建文件',
        });
      }
    }

    const owner = this.sessions.getOwner();
    if (this.config.allowFrom.length) {
      out.push({
        name: '谁能指挥它',
        ok: true,
        detail: `名单里的 ${this.config.allowFrom.length} 个 id（配置里写死了 allowFrom）`,
      });
    } else if (owner) {
      // ⚠️ 第 64 轮：这一行原来只说"已认主"，**不打是谁**。而手册第十二节是让用户跑来 doctor
      //    确认认主的（它原来写的是"doctor 会显示成 `主人=<你的 id>`"—— 那个措辞 doctor 里
      //    从来就没有过，只有 `butler run` 的启动日志里有；手册那句已按这里的真实输出改掉）。
      //    用户想钉死认主、或想换人时都得先知道这个 id 是什么，所以补上。
      //    打 id 不是打凭据：`ou_…`/`wxid_…` 是标识符，手册本来就教用户从探针那段 JSON 里
      //    抄它。（真正算凭据的是 `consoleUrl` 那种签了名的一次性链接，那个哪儿都不打。）
      out.push({
        name: '谁能指挥它',
        ok: true,
        detail: this.config.stateFile
          ? `已认主（第一个跟它说话的人）：${owner}。别人发消息它会一声不吭`
          : `已认主（第一个跟它说话的人）：${owner} —— ⚠️ 但这次认主**没落盘**：重启之后第一个说话的人又会成为主人`,
        fix: this.config.stateFile
          ? `换人用的话：把配置里的 allowFrom 写上新的 id，或者删掉 ${this.config.stateFile} 重新认主`
          : '想钉死：给 core 这一行加 `stateFile`（例如 <管家目录>/state/state.json）—— 加上之后重启也认这个主人',
      });
    } else {
      out.push({
        name: '谁能指挥它',
        ok: true,
        detail: this.config.stateFile
          ? '还没认主 —— 第一个给它发消息的人就是主人'
          : '还没认主 —— 第一个给它发消息的人就是主人（⚠️ core 没配 stateFile，认主不会保留到重启）',
        ...(this.config.stateFile ? {} : { fix: '想钉死：给 core 这一行加 `stateFile`（例如 <管家目录>/state/state.json）' }),
      });
    }

    // 管家自己的 PATH 里有没有 butler —— 见 butler-path.ts 顶上那段：
    // 只有这个进程知道自己的 PATH，所以这条只能在这儿问（doctor 与微信自检共用它）。
    out.push(butlerOnPathCheck());

    return out;
  }

  /**
   * 「自检」—— 把这一圈能力位挨个问一遍，用人话回给主人。
   *
   * 这是 `check()` 的**对话版**：`butler doctor` 问的是同一批 `check()`，
   * 但那要开终端、要会抄命令 —— 而恰恰是出事的时候，不懂技术的主人只有微信。
   *
   * 整段包在 try 里：自检自己挂了也必须说话，而且**绝不说"都正常"**。
   */
  private async selfCheck(msg: InboundMessage, quote?: string): Promise<boolean> {
    let report: SelfCheckReport;
    try {
      const targets: Checkable[] = [
        { label: '内核', instance: this },
        { label: '收发消息', instance: this.ctx.channel, missing: '没有它，你说的话我根本收不到' },
        { label: '干活的大脑', instance: this.ctx.agent, missing: '没有它，我收到了话也没人干' },
        { label: '记忆', instance: this.ctx.memory, missing: '没有它，我记不住你说过的事' },
        { label: '动你电脑前先问你', instance: this.ctx.approval, missing: '没有它，要动你电脑的事我一律不动' },
        { label: '够到别的电脑', instance: this.ctx.link, missing: '没有它，我就只管这一台电脑' },
      ];
      report = await collectSelfCheck(targets);
    } catch (error) {
      await this.say(msg, formatSelfCheckBroke(errText(error)), quote);
      return true;
    }
    await this.say(msg, formatSelfCheck(report), quote);
    return true;
  }

  async start(): Promise<void> {
    if (this.started) return;             // 幂等
    this.started = true;
    this.stopping = false;
    this.log(
      `内核启动：通道=${this.ctx.channel.id} agent=${this.ctx.agent.id} `
      + `工作目录=${this.cwd} 主人=${this.owner ?? '(还没认主，第一条来信认主)'}`,
    );
    this.worker = this.loop();            // 先起 worker，免得通道一开就有消息进来却没人接
    await this.ctx.channel.start();
    this.watchApprovals();
    // 名单里已经写好主人的（回头客）：启动时说一句。**一辈子只说一次**（见 greet）。
    // 放在这儿、不能放进 watchApprovals —— 那句开场白跟装没装审批插件没关系，
    // 放错地方的表现是：没装审批的人永远收不到那句"成了"。
    if (this.owner) await this.greet(this.owner);
  }

  /**
   * 停机。
   *
   * **不等在跑的那一轮跑完**——agent 一跑可能几分钟，用户按了 Ctrl-C
   * 就是要现在停。正在跑的那轮会被 `signal` 掐断。
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.stopping = true;
    if (this.approvalTimer) { clearInterval(this.approvalTimer); this.approvalTimer = null; }
    this.current?.abort();
    this.wake?.();
    await Promise.allSettled([this.ctx.channel.stop(), this.worker]);
    this.cleanRemoteDir();
  }

  // ───────────────────────── 把远端文件搬回来 ─────────────────────────

  /**
   * 对面交出来的附件，一个一个取回本机。
   *
   * 一个失败**不连累**后面的，但每一个都要如实记下来 ——
   * "用户以为发了三个文件、实际只到了一个"是最坏的情况，不能静默少一个。
   */
  private async collectFiles(
    session: LinkSession, wanted: RemoteFile[], device: DeviceInfo, signal: AbortSignal,
  ): Promise<{ files: OutboundFile[]; failures: string[] }> {
    const files: OutboundFile[] = [];
    const failures: string[] = [];
    if (!wanted.length) return { files, failures };

    const dir = this.remoteDir();
    for (const f of wanted) {
      try {
        files.push({
          path: await this.pullFile(session, f, dir, signal),
          name: f.name,
          caption: f.caption,
        });
      } catch (error) {
        this.log(`📎 从「${device.alias}」取不回 ${f.name}：${errText(error)}`);
        failures.push(`${f.name}：${errText(error)}`);
        await this.dropRemote(session, f.token);
      }
    }
    return { files, failures };
  }

  /**
   * 一个文件：按块要，边收边落盘。
   *
   * 为什么不一口气要整个文件？因为那要把整个文件在两边都读进内存，
   * 而 agent 会产出多大东西谁也不知道。按块还顺手换来一个好处：
   * 传输过程可以播报"正在取回 xx（63%）"，用户不会以为卡死了。
   */
  private async pullFile(session: LinkSession, f: RemoteFile, dir: string, signal: AbortSignal): Promise<string> {
    // 展示名是对面给过来的，落盘前先抹平：**这里不该相信对面**。
    // 分隔符、控制字符、超长名字都会让落盘跑到计划外的地方去。
    const safe = f.name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 80) || 'attachment';
    const target = join(dir, `${Date.now().toString(36)}-${safe}`);
    const handle = await open(target, 'w');
    let offset = 0;
    try {
      for (;;) {
        const res = (await session.request('file.read', { token: f.token, offset }, { signal })) as {
          data?: unknown; eof?: unknown; size?: unknown;
        } | null;

        const size = typeof res?.size === 'number' ? res.size : 0;
        if (offset === 0 && size > MAX_REMOTE_FILE) {
          throw new Error(`那台电脑上的这个文件有 ${Math.round(size / 1048576)}MB，超过现在能传的上限（100MB）`);
        }

        const chunk = typeof res?.data === 'string' && res.data ? Buffer.from(res.data, 'base64') : Buffer.alloc(0);
        if (chunk.length) await handle.write(chunk);
        offset += chunk.length;

        if (res?.eof || !chunk.length) break;
        if (size > 0) {
          const pct = Math.min(99, Math.round((offset / size) * 100));
          this.lastProgress = `正在取回 ${f.name}（${pct}%）`;
        }
      }
    } catch (error) {
      await handle.close();
      await rm(target, { force: true });   // 半截的文件比没有更坏：发出去用户会以为文件是好的
      throw error;
    }
    await handle.close();
    await this.dropRemote(session, f.token);
    return target;
  }

  /** 取完就让对面把凭证丢掉（丢不掉也不影响什么，那边有十分钟的自动作废） */
  private async dropRemote(session: LinkSession, token: string): Promise<void> {
    try {
      await session.request('file.drop', { token });
    } catch { /* 尽力而为 */ }
  }

  /** 中转目录：放刚从别的电脑取回来的文件，发完就删 */
  private remoteDir(): string {
    this.remote ??= mkdtempSync(join(tmpdir(), 'butler-remote-'));
    return this.remote;
  }

  private cleanRemoteDir(): void {
    if (!this.remote) return;
    try { rmSync(this.remote, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    this.remote = null;
  }

  // ───────────────────────── 收信与排队 ─────────────────────────

  /** 通道每来一条消息都会走这里。**先认人，再排队** */
  async onMessage(msg: InboundMessage): Promise<void> {
    if (this.stopping) return;

    if (!this.allow(msg.fromId)) {
      // 静默丢弃：不回话，免得这台机器变成"这号背后是不是有个 AI"的探测工具
      this.log(`忽略不属于主人的来信 from=${msg.fromId}`);
      return;
    }

    // 刚认下这个人：**先自我介绍一句**再干活。
    // 他刚扫完码，微信里一片安静 —— 安静是最容易被理解成"没装好"的
    if (this.newOwner === msg.fromId) {
      this.newOwner = null;
      await this.greet(msg.fromId);
    }

    if (this.queue.length >= this.config.maxQueue) {
      this.log(`积压到上限（${this.queue.length}），拒收 from=${msg.fromId}`);
      await this.say(
        msg,
        `前面还有 ${this.queue.length} 条没处理完，这条先不接了。等我缓过来再发一次吧。`,
        this.quoteOf(msg),
      );
      return;
    }

    // ⚠️ **先占位、再说话。** 反过来的话就有个竞态：两条消息几乎同时进来，
    // 前一条还卡在下面那句 await 上、还没入队，后一条就把 maxQueue 检查穿过去了
    // —— 上限形同虚设。（这是写测试时抓到的真 bug，不是假想。）
    this.queue.push(msg);
    this.wake?.();

    // "前面还有几条"要把**正在跑的那条**也算上：否则 agent 跑着的时候新消息进来，
    // 队列是空的，用户连"排上了"都收不到 —— 发出去像石沉大海。
    const ahead = (this.queue.length - 1) + (this.busy ? 1 : 0);
    if (ahead > 0) {
      await this.say(msg, `收到。前面还有 ${ahead} 条，排上了。`);
    }
  }

  /**
   * 真正的门。
   *
   * 配了名单就按名单；没配就认主（**只认一次**）。
   * 认主这个设计是为了小白：不用先去翻自己的微信 id 填进配置文件，
   * 打开就是你的，第二个人来了也进不来。
   */
  private allow(userId: string): boolean {
    if (this.config.allowFrom.length) return this.config.allowFrom.includes(userId);
    if (this.sessions.getOwner() === userId) return true;
    if (this.sessions.claimOwner(userId)) {
      this.log(`🔑 认主：${userId} 成了这台管家唯一的主人`);
      this.newOwner = userId;      // 认下之后要**先跟他打个招呼**（见 greet）
      return true;
    }
    return false;   // 已经有主人了，别人不行
  }

  private async loop(): Promise<void> {
    while (!this.stopping || this.queue.length) {
      const msg = this.queue.shift();
      if (!msg) {
        await this.waitForWork();
        continue;
      }
      this.busy = true;
      try {
        await this.handle(msg);
      } catch (error) {
        // 单条消息处理崩了不该把 worker 打死——否则管家从此装死
        this.log(`单条处理崩了: ${errText(error)}`);
        await this.say(msg, `（我这边出错了：${errText(error)}）`, this.quoteOf(msg));
      } finally {
        this.busy = false;
      }
    }
  }

  // ───────────────────────── 跑一轮 ─────────────────────────

  private async handle(msg: InboundMessage): Promise<void> {
    const started = Date.now();
    this.log(`→ 开始处理 from=${msg.fromId} : ${(msg.text ?? '').slice(0, 60)}`);

    this.lastInbound = msg;
    await this.setTyping(msg, true);
    const ac = new AbortController();
    this.current = ac;
    const ticker = this.startProgress(msg, started, ac.signal);

    try {
      // ⓪ 先看是不是**命令**（配对、设备列表、忘掉）。认不出来就原样往下走，
      //    所以加了这一层之后，用户说别的话的行为一点没变。
      if (await this.command(msg)) return;

      // ① 这句是发给谁的。默认本机 —— 只有显式 @ 了才去问设备列表（见 route.ts）
      const route = await this.route(msg);
      if (route.kind === 'error') {
        await this.refuse(msg, route.text);
        return;
      }

      const scope = route.kind === 'remote' ? route.device.id : '';
      const sessionId = this.sessions.get(msg.fromId, scope);
      this.log(`  送到=${scope || '本机'} session=${sessionId ?? '(新)'}`);

      // ② 跑
      let attempt = await this.dispatch(msg, route, sessionId, ac.signal);
      if (attempt.kind === 'unreachable') {
        await this.refuse(msg, attempt.text);       // 重试一台关了的机器没有意义
        return;
      }
      let res = attempt.result;
      // 会话被别的进程占着 → 丢掉旧会话、开个新的重试一次，别让用户干等
      if (res.code === 'SESSION_LOCKED' && sessionId) {
        this.log('会话被占用，换新会话重试一次');
        this.sessions.set(msg.fromId, null, scope);
        attempt = await this.dispatch(msg, route, null, ac.signal);
        if (attempt.kind === 'unreachable') {
          await this.refuse(msg, attempt.text);
          return;
        }
        res = attempt.result;
      }
      if (res.sessionId) this.sessions.set(msg.fromId, res.sessionId, scope);

      // ③ 管家自己说"值得长期记住"的事：截下来，绝不让标记漏进微信
      res = await this.absorbMemory(res);
      await this.reply(msg, res, started);
    } finally {
      this.current = null;
      if (ticker) clearInterval(ticker);
      await this.setTyping(msg, false);
    }
  }

  // ───────────────────────── 命令 ─────────────────────────

  /**
   * 认一句命令并当场办掉。返回 `true` 表示"这条消息我处理完了"。
   *
   * 这些事**故意不交给 agent**：让 agent 去改自己的设备名册，等于把
   * 一句自然语言直接变成权限变更，而且做没做对都说不清。
   */
  private async command(msg: InboundMessage): Promise<boolean> {
    const cmd = parseCommand(msg.text ?? '');
    if (!cmd) return false;

    this.log(`⚙ 命令：${cmd.kind}`);

    // 命令结果是**终结性回复**（这条消息的事就办完了）→ 一样要引用。
    // 连着发几条时，用户得知道"忘掉家里那台"的回执对应的是哪一条。
    const andQuote = this.quoteOf(msg);

    if (cmd.kind === 'help') {
      await this.say(msg, commandHelp(), andQuote);
      return true;
    }

    if (cmd.kind === 'devices') {
      const link = this.ctx.link;
      if (!link) {
        await this.say(msg, '这台电脑还没接别的机器 —— 配置里没有链路（ctx.link）那部分。', andQuote);
        return true;
      }
      try {
        await this.say(msg, describeForUser(await link.discover()), andQuote);
      } catch (error) {
        await this.say(msg, `没问出来：${errText(error)}`, andQuote);
      }
      return true;
    }

    if (cmd.kind === 'pair') return await this.pair(msg, cmd);
    if (cmd.kind === 'remember') return await this.remember(msg, cmd.text, andQuote);
    if (cmd.kind === 'memory') return await this.showMemory(msg, andQuote);
    if (cmd.kind === 'forgetMemory') return await this.forgetMemory(msg, cmd.index, andQuote);
    if (cmd.kind === 'pending') return await this.showPending(msg, andQuote);
    if (cmd.kind === 'allow') return await this.decide(msg, 'allow', cmd.index, andQuote);
    if (cmd.kind === 'deny') return await this.decide(msg, 'deny', cmd.index, andQuote);
    if (cmd.kind === 'always') return await this.decide(msg, 'allow', cmd.index, andQuote, true, cmd.window);
    if (cmd.kind === 'selfcheck') return await this.selfCheck(msg, andQuote);
    if (cmd.kind === 'grants') return await this.showGrants(msg, andQuote);
    if (cmd.kind === 'revokeGrant') return await this.revokeGrant(msg, cmd.index, andQuote);
    if (cmd.kind === 'welcome') { await this.say(msg, welcomeText(), andQuote); return true; }
    if (cmd.kind === 'forget') return await this.forget(msg, cmd.name);
    return false;
  }

  // ── 记忆 ────────────────────────────────────────────────────────
  //
  // 理由跟"设备名册"那几条一模一样（见 commands.ts 文件头）：让 agent 去写
  // 自己的记忆，等于把一句自然语言直接变成"以后这类事不用问了"。所以记忆的
  // **写**由内核自己干，动作明确、结果明确。
  //
  // 而**读**不设门槛：反正每一轮请求都已经把记忆贴给它了（见 memoryPrefix）。

  /** 记忆服务在不在。不在就用一句人话回掉，返回 null */
  private async memoryOrSay(msg: InboundMessage, quote?: string): Promise<MemoryService | null> {
    const memory = this.ctx.memory;
    if (memory) return memory;
    await this.say(msg, '现在还没接记忆 —— 配置里少了 ctx.memory 那一块（把 memory-file 这个插件装上就有了）。', quote);
    return null;
  }

  /** 「记住 简历都放 Documents/简历/」 */
  private async remember(msg: InboundMessage, text: string, quote?: string): Promise<boolean> {
    const memory = await this.memoryOrSay(msg, quote);
    if (!memory) return true;
    try {
      // key 就用主人原话：同一句话再说一次是**覆盖**，不会越记越乱
      await memory.set(text, text, { kind: 'preference', source: 'owner' });
      this.log('⚙ 记住了 1 条');
      await this.say(msg, formatRememberAck(text), quote);
    } catch (error) {
      await this.say(msg, `没记住：${errText(error)}`, quote);
    }
    return true;
  }

  /** 「记忆」 */
  private async showMemory(msg: InboundMessage, quote?: string): Promise<boolean> {
    const memory = await this.memoryOrSay(msg, quote);
    if (!memory) return true;
    try {
      await this.say(msg, formatMemoryList(await memory.list()), quote);
    } catch (error) {
      await this.say(msg, `记忆读不动：${errText(error)}`, quote);
    }
    return true;
  }

  /** 「忘掉第 2 条」 */
  private async forgetMemory(msg: InboundMessage, index: number, quote?: string): Promise<boolean> {
    const memory = await this.memoryOrSay(msg, quote);
    if (!memory) return true;
    try {
      // 先取一份快照再删：编号和"删哪条"用的是同一次读，中间不会变
      const entries = await memory.list();
      const hit = entries[index - 1];
      if (!hit) {
        await this.say(msg, formatNoSuchMemory(index, entries.length), quote);
        return true;
      }
      await memory.forget(hit.key);
      this.log('⚙ 忘掉了 1 条');
      await this.say(msg, formatForgotten(memoryLine(hit)), quote);
    } catch (error) {
      await this.say(msg, `没忘掉：${errText(error)}`, quote);
    }
    return true;
  }

  /**
   * 交给 agent 之前，先把"我记得的事"贴在前面。
   *
   * ── 为什么不把记忆做成 agent 的一个工具 ──────────────────────────
   *
   * agent 后端不一定有工具调用（`agent-exec` 就是一句话进一句话出）。贴在
   * 前面这条路**所有后端都能用**，而且顺带解决了一件事："你记得我什么"
   * 这种随口一问，不用命中任何命令就能被答对 —— 那才是主人问它的方式。
   *
   * 代价是每次请求都带上记忆，所以它必须短（按条数封顶）、而且必须说清
   * "这不是本轮的新要求"，否则模型会把一条偏好当成刚下的命令。
   *
   * 没装记忆服务 = 一个字都不贴，行为跟以前一模一样。
   *
   * ⚠️ **只在本机贴。** 记忆现在没有记"这是哪台机器上的事"，而 `~/work`、
   * `Documents/简历/` 这种内容明显是某一台机器上的路径。把它发给另一台机器
   * 上的 agent，等于给它一条错误的路径 —— 等记忆能记"属于哪台"之后再说。
   */
  private async memoryPrefix(): Promise<string> {
    const memory = this.ctx.memory;
    if (!memory) return '';
    try {
      return memoryPreamble(await memory.list({ limit: MEMORY_PREAMBLE_MAX }));
    } catch (error) {
      // 记忆文件坏了**不能让这条消息卡住** —— 主人问的是别的事。
      this.log(`⚠ 记忆读不动，这条消息照常处理：${errText(error)}`);
      return '';
    }
  }

  /** 「配对 192.168.1.9:41338 4A7-K2M」 */
  private async pair(msg: InboundMessage, cmd: { host: string; port: number | null; code: string }): Promise<boolean> {
    const link = this.ctx.link;
    if (!link) {
      await this.refuse(msg, '这台电脑还没接别的机器 —— 配置里没有链路（ctx.link）那部分。');
      return true;
    }
    if (typeof link.pair !== 'function') {
      // 名册由外部权威决定的链路（尾巴网络）不需要配对：它本来就知道谁在
      await this.refuse(msg, `现在这条链路（${link.id}）不用配对 —— 它自己就知道有哪些设备。发「设备」看看。`);
      return true;
    }
    if (!cmd.host || !cmd.code) {
      await this.refuse(msg, [
        '配对要两样东西：那台电脑的地址，和它屏幕上的配对码。',
        '',
        '  配对 192.168.1.9:41338 4A7-K2M',
        '',
        '那一行在**那台电脑**上跑 butler node 时会打出来，照抄就行。',
      ].join('\n'));
      return true;
    }

    try {
      const info = await link.pair({ host: cmd.host, ...(cmd.port ? { port: cmd.port } : {}), code: cmd.code });
      await this.say(msg, [
        `收下了：${info.alias}（${osName(info.os)}）${info.capabilities.includes('agent') ? '' : ' —— 注意它没报 agent，可能干不了活'}`,
        '',
        `以后说「@${info.alias} 看看下载目录里有什么」就在那台电脑上干活。说「设备」看全部。`,
      ].join('\n'), this.quoteOf(msg));
    } catch (error) {
      // 失败原因原样转述：节点那句"配对码不对"比"配对失败"有用得多
      await this.refuse(msg, `没配成：${errText(error)}`);
    }
    return true;
  }

  /** 「忘掉 家里那台」 */
  private async forget(msg: InboundMessage, name: string): Promise<boolean> {
    const link = this.ctx.link;
    if (!link || typeof link.forget !== 'function') {
      await this.refuse(msg, '这台电脑还没接别的机器 —— 没有可忘掉的设备。');
      return true;
    }

    let devices: DeviceInfo[];
    try {
      devices = await link.discover();
    } catch (error) {
      await this.refuse(msg, `没问出来：${errText(error)}`);
      return true;
    }

    const hit = findDevice(name, devices);
    if (!hit) {
      await this.refuse(msg, `没有叫「${name}」的设备（或者有好几台都对得上）。我知道的是：${describeDevices(devices)}`);
      return true;
    }

    const verdict = await link.forget(hit.id);
    const text = verdict === 'forgotten'
      ? `忘掉「${hit.alias}」了。它的地址和密钥已经从这台机器上删掉。`
      : verdict === 'static'
        ? `「${hit.alias}」是写在配置文件里的，我忘不掉 —— 去那份配置里删掉那一行才行。`
        : `本来就不认识「${hit.alias}」。`;
    await this.say(msg, text, this.quoteOf(msg));
    return true;
  }

  // ───────────────────────── 认路：这句话发给哪台机器 ─────────────────────────

  /**
   * 没 `@` 就直接本机，**一次网络都不发**。只有看到 `@` 才去问
   * `ctx.link.discover()` —— 绝大多数消息走的是零开销那条路。
   */
  private async route(msg: InboundMessage): Promise<Route> {
    const raw = msg.text ?? '';
    const asked = parseAddress(raw, []);
    if (!asked) return { kind: 'local', text: raw };

    const link = this.ctx.link;
    if (!link) {
      return { kind: 'error', text:
        `你叫的是「${asked.name}」，但这台机器还没接设备 —— 没装链路（ctx.link）那部分。` };
    }

    let devices: DeviceInfo[];
    try {
      devices = await link.discover();
    } catch (error) {
      return { kind: 'error', text: `我列不出设备：${(error as Error).message}` };
    }

    const aliases = devices.map((d) => d.alias).filter((a): a is string => !!a);
    const addr = parseAddress(raw, aliases) ?? asked;
    if (!addr.known) {
      return { kind: 'error', text:
        `没有叫「${addr.name}」的设备。我知道的是：${describeDevices(devices)}` };
    }

    const device = devices.find((d) => d.alias === addr.name)!;
    if (!addr.text.trim() && !msg.files?.length) {
      return { kind: 'error', text: `你想让「${device.alias}」做什么？` };
    }
    if (msg.files?.length) {
      // 附件在中枢这台机器上。**不能只把话发过去** —— 那边的 agent 会拿到一个
      // 它根本不存在的路径，然后一本正经地失败。宁可现在说清楚。
      return { kind: 'error', text:
        `附件现在还送不到「${device.alias}」上（这个功能还没做）。` +
        '要么去掉附件，要么不加 @，我就在这台电脑上办。' };
    }

    return { kind: 'remote', device, text: addr.text };
  }

  private async dispatch(msg: InboundMessage, route: Route, sessionId: string | null, signal: AbortSignal): Promise<Attempt> {
    if (route.kind !== 'remote') {
      return { kind: 'result', result: await this.run(msg, route.text, sessionId, signal) };
    }
    return this.runRemote(route.device, route.text, sessionId, signal, msg.quote);
  }

  /**
   * 管家在回答里写的 `[[记住: …]]`：截下来存好，并把标记从要发出去的话里摘干净。
   *
   * 放在这里是因为**本机和远端、首次和重试都经过这一处** —— 记忆是主人的，
   * 不是某一台机器的：在哪台机器上办的事，值得记的都记在中枢这一份里。
   *
   * **软失败**：记忆写不进去绝不连累这次回答。主人要的是答案，不是一条
   * "记忆写不进去"的报错 —— 那种报错只会让他以为活也没干成。
   */
  private async absorbMemory(res: AgentResult): Promise<AgentResult> {
    const marked = parseMemoryMark(res.text ?? '');
    const stripped = { ...res, text: marked.text };
    // 认不下来的也**必须摘掉标记**：那是给内核看的内部约定，
    // 漏进微信主人只会看见一串黑话。
    if (!marked.fact) return marked.text === (res.text ?? '') ? res : stripped;
    if (!this.config.autoMemory) return stripped;

    const memory = this.ctx.memory;
    if (!memory) {
      this.log('⚠ 管家记了一条，但这台机器上没装记忆（这次只摘标记）');
      return stripped;
    }
    try {
      // key 用这句话本身：同一件事说两遍是**覆盖**，不会越记越乱
      await memory.set(marked.fact, marked.fact, { kind: 'preference', source: 'butler' });
      this.log(`⚙ 自己记住 1 条：${marked.fact.slice(0, 40)}`);
      return { ...stripped, text: `${marked.text}\n\n${formatAutoRememberAck(marked.fact)}` };
    } catch (error) {
      this.log(`⚠ 记忆没写进去：${errText(error)}`);
      return stripped;
    }
  }

  /** 本机：先贴上"我记得的事"，再交给 `ctx.agent` */
  private async run(msg: InboundMessage, text: string, sessionId: string | null, signal: AbortSignal): Promise<AgentResult> {
    return this.ctx.agent.run({
      text: (await this.memoryPrefix()) + this.promptFor(text, msg.files, msg.quote),
      files: msg.files,
      sessionId,
      cwd: this.cwd,
      signal,
      onProgress: (line) => {
        this.lastProgress = line;
        this.log(`  [${this.ctx.agent.id}] ${line}`);
      },
    });
  }

  /**
   * 别的机器：走 `ctx.link` 调对面的 `agent.run`。
   *
   * 三点值得说明：
   *  - **不给它 cwd。** 中枢的目录在那台机器上没有意义，让节点用自己配的那个。
   *  - **不预判在线。** `connect()` 本来就当场探活、当场抛人话；再自己判一次
   *    "离线"只会多一种误报（慢一点的局域网会被误判成关机）。
   *  - **一次一问一关。** 会话状态在对面是按 session id 存的，不靠这条连接，
   *    所以没必要为了省一次握手把连接一直挂着。
   */
  private async runRemote(
    device: DeviceInfo,
    text: string,
    sessionId: string | null,
    signal: AbortSignal,
    quote?: string,
  ): Promise<Attempt> {
    const link = this.ctx.link!;
    let session: LinkSession;
    try {
      session = await link.connect(device.id);
    } catch (error) {
      const why = (error as Error).message;
      // 链路实现说的人话里通常已经点了名（"连不上家里那台…"），
      // 那就别再套一层"「家里那台」连不上："，不然用户看到两遍同样的字。
      return { kind: 'unreachable', text: why.includes(device.alias) ? why : `「${device.alias}」连不上：${why}` };
    }

    try {
      const out = await session.request('agent.run', {
        text: this.promptFor(text, undefined, quote),
        sessionId,
        cwd: '',
      }, {
        signal,
        onEvent: (e) => {
          if (e.type !== 'progress' || !e.line) return;
          this.lastProgress = e.line;
          this.log(`  [${device.alias}] ${e.line}`);
        },
      });
      const reply = parseRemote(out, device.alias);
      // 附件要在**关掉会话之前**取回来 —— 凭证只在这次往来里有效
      const { files, failures } = await this.collectFiles(session, reply.files, device, signal);
      return { kind: 'result', result: { ...reply.result, text: withFileNotes(reply.result.text ?? '', failures), files } };
    } catch (error) {
      // 半路断了：这活在那台机器上没办成，**也不是本机 agent 的错**。
      // 说清楚是哪台、断在哪，别让用户去查本机的日志。
      return { kind: 'unreachable', text: `「${device.alias}」那边断了：${(error as Error).message}` };
    } finally {
      session.close();
    }
  }

  /**
   * 这活根本没送到 agent 手上时，如实说清楚。
   *
   * **故意不走 `reply()`** —— 那条路会写成"（agent 出错，0s）"，
   * 而这里 agent 连话都没听见。把路由问题说成 agent 出错，用户会去查错的地方。
   */
  private async refuse(msg: InboundMessage, text: string): Promise<void> {
    this.log(`✗ 没送出去：${text}`);
    await this.say(msg, text, this.quoteOf(msg));
  }

  /** 用户说的话；纯附件没文字时给一句起步提示；末尾附上本机路径兜底 */
  private promptFor(text: string, files?: LocalFile[], quote?: string): string {
    const body = text.trim() || defaultPrompt(files);
    return quoteContext(quote) + body + filesHint(files);
  }

  /**
   * 长任务的进度播报。
   *
   * 这里解决的是一个**真实发生过的问题**：agent 跑了两三分钟一句话都不说，
   * 用户那边看到的就是"没反应"。所以哪怕 agent 自己不报进度，
   * 也要定期说一句"还在处理"，并且把 agent 最近一条进度带上。
   */
  private startProgress(msg: InboundMessage, started: number, signal: AbortSignal): NodeJS.Timeout | null {
    const every = this.config.progressIntervalMs;
    if (!every || every <= 0) return null;
    return setInterval(() => {
      if (signal.aborted) return;
      const secs = Math.round((Date.now() - started) / 1000);
      const tail = this.lastProgress ? `\n最近：${this.lastProgress.slice(0, 80)}` : '';
      void this.say(msg, `还在处理…（已 ${secs}s）${tail}`);
    }, every);
  }

  // ── 审批 ────────────────────────────────────────────────────────
  //
  // 发问的那一头在 dsh 子进程里：应答者把"要动你的电脑"写进待批目录
  // （见 packages/approval-im）。这里管另一半：念给主人听、把答复落回去。
  //
  // 跟记忆比，这里有两条**明显更严**的规矩：
  //
  //   1. **超时 = 不许。** 到点没人答就是不许（由实现包结算），
  //      所以这里从不说"你先想着"，也绝不"先做了再说"。
  //   2. **编号只按主人看过的那份清单算。** 清单变了（过期了一件、又来了一件）
  //      就重新念一遍 —— 绝不拿一个旧编号去猜是哪一件。
  //      审批上错一位的代价是"允许了一次本来没打算允许的操作"。

  /** 盯着待批目录：有新问题就推给主人 */
  private watchApprovals(): void {
    const every = this.config.approvalIntervalMs;
    if (!this.ctx.approval || !every || every <= 0) return;
    this.approvalTimer = setInterval(() => { void this.pollApprovals(); }, every);
    this.approvalTimer.unref?.();          // 别让这个定时器把进程吊着
    void this.pollApprovals();             // 启动时先看一眼，不用等第一个间隔
  }

  /**
   * 主人给过长期授权的那几类，**先替他放行掉**，剩下的才念给他听。
   *
   * 顺序是重点：**先放行、再念清单**。反过来的话，念出来的编号里会混着
   * 已经被放行的，他回「允许 2」就会打到另一件事上。
   *
   * 授权记录读不动时：一条都不算数（退回"每次都问"）—— 宁可多问，不能少问。
   * 放行不成功（比如刚好到点结算了）也照常留在清单里给他看。
   */
  private async settleGranted(list: ApprovalRequest[], approval: ApprovalService): Promise<ApprovalRequest[]> {
    if (!list.length) return list;
    // **过点的不算**：限时授权一到点就自动回到"每次都问"，不用主人记着来收
    const granted = new Set(liveGrants(readGrants(this.grantsFile)).map((g) => g.kind));
    if (!granted.size) return list;

    const rest: ApprovalRequest[] = [];
    for (const req of list) {
      if (!granted.has(kindOf(req))) { rest.push(req); continue; }
      try {
        // 审计里写 `grant`：**不冒名**写成"主人当场点的头"。出了事，账本不能冤枉他
        await approval.answer(req.id, 'allow', 'grant');
      } catch (error) {
        this.log(`⚠ 授权放行没成功（照常问他）：${errText(error)}`);
        rest.push(req);
      }
    }
    return rest;
  }

  /**
   * 认下主人之后说的第一句。
   *
   * **发不出去就不记"说过了"** —— 下一轮启动再试。跟审批推送同一条规矩：
   * 别装作说过了。一个人永远等不到这句话，比晚一点收到糟得多。
   */
  private async greet(owner: string): Promise<void> {
    // 一辈子只说一次：说过了就再也不提（重启也不提）
    if (this.sessions.helloed()) return;
    try {
      await this.ctx.channel.sendText(owner, welcomeText());
      this.sessions.markHelloed();
      this.log('👋 跟主人说了第一句');
    } catch (error) {
      this.log(`⚠ 头一句没发出去（下次启动再试）：${errText(error)}`);
    }
  }

  private async pollApprovals(): Promise<void> {
    const approval = this.ctx.approval;
    const owner = this.owner;
    if (!approval || !owner) return;
    try {
      const list = await this.settleGranted(await approval.list(), approval);
      const ids = list.map((r) => r.id);
      const fresh = ids.some((id) => !this.approvalPrinted.includes(id));
      this.approvalPrinted = ids;
      if (!fresh || list.length === 0) return;
      this.log(`⏳ ${list.length} 件在等主人点头`);
      await this.pushApprovals(owner, list);
    } catch (error) {
      // 读不动不是主人的错。安全那一侧是自动的：事没人批 → 到点就是不许
      this.log(`⚠ 审批读不动：${errText(error)}`);
    }
  }

  /** 主动推给主人。用最近那条来信的会话令牌 —— 审批总是从一轮对话里冒出来的 */
  private async pushApprovals(owner: string, list: ApprovalRequest[]): Promise<void> {
    try {
      await this.ctx.channel.sendText(owner, formatApprovalAsk(list), {
        ...(this.lastInbound?.contextToken ? { contextToken: this.lastInbound.contextToken } : {}),
      });
    } catch (error) {
      this.log(`⚠ 审批没推出去：${errText(error)}`);
      // 推不出去就**别装作问过了** —— 当没念过，下一轮再试
      this.approvalPrinted = [];
    }
  }

  /** 「授权」：看看给过哪些长期授权（编号就是收回时用的那个） */
  private async showGrants(msg: InboundMessage, quote?: string): Promise<boolean> {
    const { grants, broken } = readGrantsOr(this.grantsFile);
    await this.say(msg, broken ? formatGrantsBroken(broken) : formatGrants(grants), quote);
    return true;
  }

  /** 「取消授权 N」：收回一条。写不成要说"它还在" —— 不能让他以为已经收回了 */
  private async revokeGrant(msg: InboundMessage, index: number, quote?: string): Promise<boolean> {
    const before = readGrantsOr(this.grantsFile);
    if (before.broken) {
      await this.say(msg, formatGrantsBroken(before.broken), quote);
      return true;
    }
    let r: { removed: Grant | null; grants: Grant[] };
    try {
      r = removeGrant(this.grantsFile, index);
    } catch (error) {
      await this.say(msg, `没收回成：${errText(error)}\n（所以它**还在**，这类事仍然不问你。）`, quote);
      return true;
    }
    await this.say(
      msg,
      r.removed ? formatRevoked(index, r.removed, r.grants.length) : formatNoSuchGrant(index, before.grants.length),
      quote,
    );
    return true;
  }

  /** 审批服务在不在。不在就用一句人话回掉，返回 null */
  private async approvalOrSay(msg: InboundMessage, quote?: string): Promise<ApprovalService | null> {
    const approval = this.ctx.approval;
    if (approval) return approval;
    await this.say(msg, formatNoApproval(), quote);
    return null;
  }

  /** 把清单念一遍，并把它记成"主人看过的那份" */
  private async printPending(list: ApprovalRequest[], quote?: string): Promise<void> {
    this.approvalPrinted = list.map((r) => r.id);
    const msg = this.lastInbound;
    if (msg) await this.say(msg, formatPending(list), quote);
  }

  /** 「待批」 */
  private async showPending(msg: InboundMessage, quote?: string): Promise<boolean> {
    const approval = await this.approvalOrSay(msg, quote);
    if (!approval) return true;
    try {
      const list = await this.settleGranted(await approval.list(), approval);
      this.approvalPrinted = list.map((r) => r.id);   // 念过之后，编号就以这份为准
      await this.say(msg, formatPending(list), quote);
    } catch (error) {
      await this.say(msg, formatApprovalBroken(error), quote);
    }
    return true;
  }

  /** 「允许」/「不许」（可带编号） */
  private async decide(
    msg: InboundMessage, decision: 'allow' | 'deny', index: number | null, quote?: string,
    alsoGrant = false, grantWindow?: string,
  ): Promise<boolean> {
    const approval = await this.approvalOrSay(msg, quote);
    if (!approval) return true;

    let list: ApprovalRequest[];
    try {
      list = await this.settleGranted(await approval.list(), approval);
    } catch (error) {
      await this.say(msg, formatApprovalBroken(error), quote);
      return true;
    }
    const total = list.length;
    if (total === 0) {
      await this.say(msg, formatNothingWaiting(), quote);
      return true;
    }

    // 主人没给编号：只有一件的时候才作数
    let at = index;
    if (at === null) {
      if (total > 1) {
        this.approvalPrinted = list.map((r) => r.id);
        await this.say(msg, formatPending(list), quote);
        await this.say(msg, formatNeedIndex(total), quote);
        return true;
      }
      at = 1;
    }

    // 还没念过清单：先念，别拿一个编号去猜
    if (this.approvalPrinted.length === 0) {
      this.approvalPrinted = list.map((r) => r.id);
      await this.say(msg, formatPending(list), quote);
      await this.say(msg, '上面就是现在在等的事 —— 照它的编号回「允许 1」这样就行。', quote);
      return true;
    }
    // 清单变了：主人手里那个编号已经对不上现在这件事了，重新念
    const stale = this.approvalPrinted.length !== total
      || list.some((r, i) => this.approvalPrinted[i] !== r.id);
    if (stale) {
      this.approvalPrinted = list.map((r) => r.id);
      await this.say(msg, formatAlreadyGone(at), quote);
      await this.say(msg, formatPending(list), quote);
      return true;
    }
    if (at < 1 || at > total) {
      this.approvalPrinted = list.map((r) => r.id);
      await this.say(msg, formatNoSuchPending(at, total), quote);
      await this.say(msg, formatPending(list), quote);
      return true;
    }

    const req = list[at - 1];
    if (!req) {
      // 上面刚判过范围，理论上到不了这儿 —— 真到了就当"没有这件"，绝不硬着头皮批
      await this.say(msg, formatNoSuchPending(at, total), quote);
      return true;
    }
    let ok: boolean;
    try {
      ok = await approval.answer(req.id, decision);
    } catch (error) {
      await this.say(msg, formatApprovalBroken(error), quote);
      return true;
    }
    // 「以后这类都行」：这一件照办之后，才把这一类记下来。
    // **只在真的批成了之后记** —— 批不成（比如刚好到点结算了）就不记，
    // 不然账上会出现"库里有授权，可主人从没说过"这种事。
    if (ok && alsoGrant && decision === 'allow') {
      const kind = kindOf(req);
      // 写了期限就先读懂它。**读不懂一条都不记** —— 没看懂就当"永远"，是最坏的一种猜法
      const win = grantWindow === undefined ? null : parseGrantWindow(grantWindow);
      if (win && !win.ok) {
        await this.say(msg, formatGrantWindowUnclear(kind, win.why), quote);
      } else {
        const until = win?.ok ? win.until : undefined;
        try {
          addGrant(this.grantsFile, kind, new Date(), until);
          await this.say(msg, formatGranted(kind, until), quote);
        } catch (error) {
          await this.say(
            msg,
            `这件我照办了，但**长期授权没记下来**：${errText(error)}\n（所以以后还会问你。）`,
            quote,
          );
        }
      }
    }
    if (!ok) {
      // 落在"读的时候还在、批的时候没了"的缝里（多半刚好到点结算了）
      await this.say(msg, formatAlreadyGone(at), quote);
      return true;
    }
    // 批完之后清单少了一件 → 让编号以新清单为准，别让下一次再对不上
    this.approvalPrinted = (await approval.list()).map((r) => r.id);
    this.log(`⚙ 审批：第 ${at} 条 → ${decision}`);
    await this.say(msg, decision === 'allow' ? formatAllowed(at, req) : formatDenied(at, req), quote);
    return true;
  }

  // ───────────────────────── 回话 ─────────────────────────

  private async reply(msg: InboundMessage, res: AgentResult, started: number): Promise<void> {
    const secs = Math.round((Date.now() - started) / 1000);

    if (res.error) {
      // 出错也是**这条消息的终结性回复** —— 和正常答复一样引用，用户才分得清是哪条挂了
      this.log(`→ 出错（${secs}s）：${res.error}`);
      await this.say(msg, `（agent 出错，${secs}s）\n${res.error}`, this.quoteOf(msg));
      return;
    }

    const body = res.text?.trim()
      || `任务中止了（跑了 ${secs}s 没出结果）。可能是中途被掐断或超时——换个说法，或者把事拆小一点再试。`;

    this.log(`→ 回话（${secs}s，${res.files?.length ?? 0} 个附件）：${body.slice(0, 80)}`);

    // "回的是哪句"只作为**一个字段**交给通道，由它决定怎么显示：
    // 微信顶一行 `↩ …`，Telegram 走原生引用回复。内核不替它们决定。
    await this.ctx.channel.sendText(msg.fromId, body, {
      contextToken: msg.contextToken,
      quote: this.quoteOf(msg),
    });

    for (const f of res.files ?? []) await this.sendFile(msg, f);
  }

  private async sendFile(msg: InboundMessage, f: OutboundFile): Promise<void> {
    try {
      if (f.caption) await this.say(msg, f.caption, this.quoteOf(msg));
      // 附件也是这次答复的一部分 —— 引用一起带上（Telegram 会把它挂成原生引用，
      // 微信协议里文件带不了引用行，那边就自然忽略）
      const sent = await this.ctx.channel.sendFile(msg.fromId, f.path, {
        contextToken: msg.contextToken,
        quote: this.quoteOf(msg),
      });
      this.log(`📎 已发送附件 ${sent.fileName ?? f.path}（${sent.size ?? '?'} 字节）`);
    } catch (error) {
      // 附件发失败必须说：用户以为发出去了、其实没有，是最坏的情况
      this.log(`📎 发附件失败 ${f.path}: ${errText(error)}`);
      await this.say(msg, `附件发送失败：${f.path}\n${errText(error)}`, this.quoteOf(msg));
    }
  }

  /**
   * 回话时该引用哪句 —— **规则只有一句**：
   *
   *     终结性回复 → `this.quoteOf(msg)`；过程性消息 → 不传。
   *
   * "终结性"= 这条消息的事就此了结：答复、出错、拒收、命令结果、附件/配文。
   * "过程性"= 还在路上：进度播报、队列回执（它们不是"在回答某句话"，
   * 每收到一条"还在处理…"都被引用一次，看着很吵）。
   *
   * 只发了附件没说话时，引用退回一句附件描述 —— "回的是哪个文件"才是用户关心的。
   */
  private quoteOf(msg: InboundMessage): string | undefined {
    if (!this.config.quoteReply) return undefined;
    const said = msg.text?.trim();
    if (said) return said;
    const f = msg.files?.[0];
    if (!f) return undefined;
    // 图片/语音的名字是我们自己起的，给用户看没意义；只有"文件"那份名字是用户自己的
    return quotedMedia(f.kind, f.kind === 'file' ? f.name : undefined);
  }

  /**
   * 发一句话，失败只记日志（回话本身失败不该再抛出去）。
   *
   * `quote` 见 `quoteOf` 的规则：终结性回复传 `this.quoteOf(msg)`，过程性消息不传。
   */
  private async say(msg: InboundMessage, text: string, quote?: string): Promise<void> {
    try {
      await this.ctx.channel.sendText(msg.fromId, text, { contextToken: msg.contextToken, quote });
    } catch (error) {
      this.log(`发送失败: ${errText(error)}`);
    }
  }

  /** "正在输入"是 best-effort：失败绝不能影响真正的回复 */
  private async setTyping(msg: InboundMessage, on: boolean): Promise<void> {
    if (!this.config.typing) return;
    try {
      await this.ctx.channel.setTyping(msg.fromId, on, { contextToken: msg.contextToken });
    } catch (error) {
      this.log(`正在输入发送失败（忽略）: ${errText(error)}`);
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => { this.wake = () => { this.wake = null; resolve(); }; });
  }
}

/**
 * 一次尝试的结果。
 *
 * **"没送到"和"办了但没办成"是两件事**，回话方式也不同：
 * 前者不该被写成"（agent 出错）"—— agent 连话都没听见，那样说会把用户引到错的地方去查。
 */
type Attempt =
  | { kind: 'result'; result: AgentResult }
  | { kind: 'unreachable'; text: string };

/** 这句话要送到哪儿 */
type Route =
  | { kind: 'local'; text: string }
  | { kind: 'remote'; device: DeviceInfo; text: string }
  | { kind: 'error'; text: string };

/**
 * 节点回过来的东西 → 内核认识的 `AgentResult`。
 *
 * 对面可能多带一个 `filesOnNode`：它在自己那台机器上生成了文件，
 * 但**那边的文件现在还传不回来**（见 `link-lan` 的 README）。
 * 这里如实转述，绝不能让用户以为附件在路上。
 */
/**
 * 对面回来的东西 → 一半是答复，一半是**待取的附件**。
 *
 * 附件这一半不是路径而是凭证（见 `@butler/link-lan/node` 的文件头）：
 * 那台机器上的路径在这台机器上不存在，透传过来只会让微信去读一个不存在的文件。
 */
function parseRemote(out: unknown, alias: string): { result: AgentResult; files: RemoteFile[] } {
  const r = (out ?? {}) as {
    text?: unknown; sessionId?: unknown; error?: unknown; code?: unknown;
    files?: unknown; filesOnNode?: unknown;
  };
  let text = typeof r.text === 'string' ? r.text : '';

  // 老版本节点（只报数量、传不回来）仍然如实说，不假装收到了
  const stuck = typeof r.filesOnNode === 'number' ? r.filesOnNode : 0;
  if (stuck > 0) {
    text += `${text ? '\n' : ''}（它在「${alias}」上生成了 ${stuck} 个文件，但那台电脑上的文件我还传不回来。）`;
  }

  const files: RemoteFile[] = Array.isArray(r.files)
    ? r.files.flatMap((f) => {
      const o = (f ?? {}) as { token?: unknown; name?: unknown; caption?: unknown };
      if (typeof o.token !== 'string' || !o.token) return [];
      return [{
        token: o.token,
        name: typeof o.name === 'string' ? o.name : '附件',
        caption: typeof o.caption === 'string' ? o.caption : undefined,
      }];
    })
    : [];

  return {
    files,
    result: {
      text,
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
      error: typeof r.error === 'string' ? r.error : null,
      code: r.code as AgentResult['code'],
    },
  };
}

/** 把"哪几个附件没取回来"接在回复后面。**不能静默少一个文件** */
function withFileNotes(text: string, failures: string[]): string {
  if (!failures.length) return text;
  return `${text ? `${text}\n` : ''}（有 ${failures.length} 个文件没取回来：${failures.join('；')}）`;
}

/** 单个远端附件的大小上限。再大切块传输就不合适了，如实说比硬撑好 */
const MAX_REMOTE_FILE = 100 * 1024 * 1024;

/** 对面说"要发这几个文件"：token + 展示名 */
interface RemoteFile {
  token: string;
  name: string;
  caption?: string;
}

export default ButlerCore;
