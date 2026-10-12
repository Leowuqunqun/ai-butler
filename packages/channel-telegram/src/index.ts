/**
 * Telegram 通道的 **cordis 插件入口** —— 实现 `ctx.channel`。
 *
 * ── 这个包是"第二个 IM"，它本身就是一次架构验证 ──────────────────
 *
 * 如果 `ctx.channel` 这个 seam 是真的，那么加一个 IM 应该**只动两处**：
 * 一个新的实现包 + 配置文件里那一行的 `name`。核心层、`butler run`、
 * `doctor`、agent 那一侧都不该有任何改动。这个包的测试就是拿这条线在钉：
 * `test/plugin.mjs` 用**同一套核心层容器**（`@butler/core`）装上 telegram 通道，
 * 断言四个能力位照旧就位。
 *
 * ── 收 / 干分离（跟微信通道同一个形状，理由却更硬）────────────────
 *
 *     getUpdates 长轮询 ──归一化(纯函数)──> 队列 ──> 下载 worker ──> emitMessage
 *                                                                    ↑
 *                                                        到这里附件已经是本机路径
 *
 * 为什么必须分开：Telegram 取附件是**两次**请求（`getFile` 拿路径、再下载字节）。
 * 在长轮询循环里干这件事，一个 20MB 的文件就足以让轮询超时、把消息漏掉。
 *
 * ── 出错之后的行为 ──────────────────────────────────────────────
 *
 * 网络抖 → 指数退避重试，不打扰用户（日志里有）。
 * token 错 / 409 有人抢 → 这是**配置错**，会一直错，所以只大声说一次，
 * 之后安静地退避重试 —— 刷屏的日志没有信息量，只有噪音。
 *
 * @module @butler/channel-telegram
 */

import z from '@deepseek-ai/schemastery';
import { ChannelService, type InboundMessage, type LocalFile, type SendOpts, type SendResult, type HealthCheck } from '@butler/seam-channel';
import type { Context } from '@deepseek-ai/cordis';

import { MAX_MESSAGE_CHARS, TelegramApi, TelegramError } from './api.js';
import { OffsetStore } from './store.js';
import { normalizeUpdate, parseContextToken, type NormalizedUpdate, type PendingFile } from './update.js';

import { chmodSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

/** 长轮询一次最多挂多久（秒）。Telegram 自己上限 50，留点余量 */
const DEFAULT_POLL_SEC = 25;
/** 出错后退避的上限 */
const MAX_BACKOFF_MS = 60_000;
/** 默认允许下载的附件大小（Telegram 给机器人的上限就是 20MB） */
const DEFAULT_MAX_MEDIA = 20 * 1024 * 1024;
/** 自检验 token 时最多等多久 —— doctor 不该因为对面不吭声就吊在那儿 */
const TOKEN_CHECK_TIMEOUT_MS = 5000;

export interface TelegramChannelConfig {
  botToken: string;
  home: string;
  baseUrl: string;
  allowFrom: string[];
  pollTimeoutSec: number;
  maxMediaBytes: number;
  maxChars: number;
}

export class TelegramChannel extends ChannelService {
  // 全部给 default、不用 .required() —— 本项目的既定写法（见 ARCH-technical §5）：
  // static Config 拦不住漏填，必填在构造函数里拦。
  static Config = z.object({
    /** BotFather 给的那串。**空 = 还没填**，doctor 会说出来，start() 会拒绝上线 */
    botToken: z.string().default(''),
    /** 管家目录。offset 放在 `<home>/state/telegram.json` */
    home: z.string().default(''),
    /** 换掉 API 根地址。只给测试用 */
    baseUrl: z.string().default(''),
    /** 只理这些 chat id。空 = 不筛（真正的门在核心层的"认主"） */
    allowFrom: z.array(z.string()).default([]),
    /** 长轮询挂多久（秒）。测试里给 0，立刻返回 */
    pollTimeoutSec: z.number().default(DEFAULT_POLL_SEC),
    /** 超过这个大小的附件不下载，只在消息里说明一句 */
    maxMediaBytes: z.number().default(DEFAULT_MAX_MEDIA),
    /** 单条文本的字符上限。默认就是 Telegram 的硬上限 */
    maxChars: z.number().default(MAX_MESSAGE_CHARS),
  });

  readonly config: TelegramChannelConfig;
  readonly id = 'telegram';

  private readonly api: TelegramApi;
  private readonly store: OffsetStore;
  private readonly home: string;

  /** 读到哪儿了。**只在内存里推进，每收一条都落盘** */
  private offset = 0;
  private stopping = false;
  private running = false;
  /** 长轮询和下载共用一个信号：stop() 掐它就够了 */
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private worker: Promise<void> | null = null;
  /** 收了还没取的件 */
  private readonly queue: NormalizedUpdate[] = [];
  /** 把打盹的 worker 叫醒（收信和干活是两个循环） */
  private wake: (() => void) | null = null;
  /** 已经大声说过的错，别重复刷屏 */
  private readonly shouted = new Set<number>();
  /** 上一次的轮询间隔，退避用 */
  private backoff = 0;

  constructor(ctx: Context, config: TelegramChannelConfig) {
    super(ctx);
    // `home` 空着就用默认位置。**不在 Config 里给默认值**：默认值要在运行时算
    //（会用到 homedir()），写在 schema 里会让 dump 出来的配置看起来是死的。
    this.home = config.home || join(homedir(), '.butler');

    this.config = { ...config, home: this.home };
    this.api = new TelegramApi({
      token: config.botToken,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
    this.store = new OffsetStore(join(this.home, 'state', 'telegram.json'));
  }

  /**
   * 开始收信。
   *
   * 幂等：重复调用不会起第二个轮询（两套轮询会互相偷走对方的 update，
   * 表现是"消息偶尔不回"）。
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.config.botToken.trim()) {
      // 这条错会原样出现在 `butler run` 的"起不来：…"里，所以要写成
      // "用户看完知道去哪拿"的话，而不是 "botToken is required"。
      throw new Error(
        '还没有 Telegram bot token。在 Telegram 里找 @BotFather 发 /newbot 建一个，'
        + '然后跑一次 `butler run` —— 它会开一个页面让你把那串（长得像 123456:ABC-DEF…）贴进去，'
        + '不用自己改配置文件。',
      );
    }

    this.stopping = false;
    this.abort = new AbortController();
    const { signal } = this.abort;

    // 先问一句"我是谁"：token 错的话现在就说清楚，别等轮询里报 401
    const me = await this.api.getMe(signal);
    this.running = true;

    const stored = this.store.read();
    if (stored === null) {
      // 读不出 offset = 我们从没成功收过信。**这时候不能从 0 开始**：
      // Telegram 会把最近 24 小时的消息重发一遍，用户昨天说过的"清空下载文件夹"
      // 会被再执行一次。宁可漏几条，也不重放。
      this.offset = await this.skipBacklog(signal);
      this.ctx.logger?.info(
        'telegram: 没有读过信的记录，已跳过积压历史（从 update %d 开始）。漏掉的消息重发一遍即可',
        this.offset,
      );
    } else {
      this.offset = stored;
    }

    this.loop = this.pollLoop();
    this.worker = this.deliverLoop();
    this.ctx.logger?.info('telegram: 上线了（%s）', me.username ? `@${me.username}` : `id ${me.id}`);
  }

  /** 停止收信。**没 start 过也要能安全调用** */
  async stop(): Promise<void> {
    // 先立牌子再动手：长轮询正好回来的时候，看到 stopping 就知道别再进循环了
    this.stopping = true;
    this.abort?.abort();
    this.abort = null;
    this.queue.length = 0;
    this.wake?.();
    this.wake = null;

    const pending = [this.loop, this.worker].filter((p): p is Promise<void> => p !== null);
    this.loop = null;
    this.worker = null;
    this.running = false;
    // 这里**不能**设超时后放它去跑：两个循环都在 await 带 abort 的 fetch，
    // 会在毫秒级返回。真卡住了说明有 bug，测试里有专门的用例盯着（stop < 2s）。
    await Promise.allSettled(pending);
  }

  /** 发一条文本。超长按 Telegram 的上限切段，**只在第一段上带引用** */
  async sendText(to: string, text: string, opts: SendOpts = {}): Promise<SendResult> {
    const { chatId, messageId } = parseContextToken(opts.contextToken);
    const target = to || chatId;
    if (!target) throw new Error('不知道发给谁：Telegram 需要 chat id');

    const chunks = chunkText(text, this.config.maxChars);
    if (!chunks.length) throw new Error('要发的文本是空的');

    // `quote` 表示"这条是在回答某句话"，而 Telegram 有天生的表达方式：原生引用回复。
    // 所以文本**一个字都不动** —— 不像微信那样顶一行 `↩ …`。
    //
    // 还有一个效果：进度提示（"还在处理…"）不带 quote，因此不会被引用；
    // 只有真正的答复才引用用户那句。以前内核替所有通道顶前缀，这几条会一起被引用。
    //
    // ⚠️ 这里有个**隐式前提**：还得能从 `contextToken` 里解出消息号，否则静默不引用。
    // 今天不可达（本包发出去的 token 一定是 `chatId:messageId`），但谁要是手写一个
    // 只有 chatId 的 token，这里会不声不响地降级成"不引用"。
    let first: number | undefined = opts.quote ? messageId : undefined;
    for (const chunk of chunks) {
      await this.api.sendMessage({
        chatId: target,
        text: chunk,
        ...(first ? { replyTo: first } : {}),
        ...(this.abort ? { signal: this.abort.signal } : {}),
      });
      // 只有第一段引用原消息：每一段都引用会把对话框刷成一片引用框
      first = undefined;
    }
    return { chunks: chunks.length };
  }

  /** 发一个本机文件。图片走 sendPhoto（点开能看大图），别的原样当文件发 */
  async sendFile(to: string, path: string, opts: SendOpts = {}): Promise<SendResult> {
    const { chatId, messageId } = parseContextToken(opts.contextToken);
    const target = to || chatId;
    if (!target) throw new Error('不知道发给谁：Telegram 需要 chat id');

    const name = basename(path);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`要发的文件找不到了：${path}`);
    }
    const common = {
      chatId: target,
      path,
      name,
      ...(opts.caption ? { caption: opts.caption } : {}),
      // `quote` 对文件同样有效（和文本一条规则）：有它就把文件挂成那条消息的引用回复
      ...(opts.quote && messageId ? { replyTo: messageId } : {}),
      ...(this.abort ? { signal: this.abort.signal } : {}),
    };
    if (isImage(name)) await this.api.sendPhoto(common);
    else await this.api.sendDocument(common);
    return { fileName: name, size };
  }

  /** "正在输入…"。**best-effort**：发不出去也不许影响真正的回复 */
  override async setTyping(to: string, on: boolean, opts: SendOpts = {}): Promise<void> {
    if (!on) return; // Telegram 没有"取消正在输入"，只能等它自己过期
    const { chatId } = parseContextToken(opts.contextToken);
    const target = to || chatId;
    if (!target) return;
    try {
      await this.api.sendChatAction(target, 'typing', this.abort?.signal);
    } catch {
      // 故意吞掉：用户没看到"正在输入"是小事，回复失败是大事
    }
  }

  /**
   * 自检。
   *
   * 有 token 的时候会**真去问一句"我是谁"**（`getMe` —— 免费、不要任何权限），
   * 因为"这串 token 已经作废了"光看配置文件是看不出来的，而它正是
   * "昨天还好好的、今天就不回消息了"的一个常见原因（在 @BotFather 那边
   * `/revoke` 过之后就是这样）。
   *
   * ⚠️ 但**连不上不算故障**：网断了就说"这次没查"，仍然是 ✓。
   *   网一断就报红，只会让用户去修一个根本不存在的问题。
   *   只有对面**明确拒了这个 token**（401/404）才判 ✗。
   * ⚠️ 5 秒上限：doctor 是拿来当场看结果的，不能因为对面不吭声就吊在那儿。
   */
  override async check(): Promise<HealthCheck[]> {
    const out: HealthCheck[] = [];
    if (!this.config.botToken.trim()) {
      out.push({
        name: 'Telegram 登录态',
        ok: false,
        detail: '还没有填 bot token',
        fix: '在 Telegram 里找 @BotFather 发 /newbot 建一个机器人；'
          + '然后跑一次 `butler run`，它会开一个页面让你把那串 token 贴进去',
      });
    } else {
      out.push(await this.tokenCheck());
    }
    out.push({
      name: '取件目录',
      ok: true,
      detail: join(this.home, 'inbox'),
    });
    return out;
  }

  /** 问一句"我是谁"。分三种结局：连上了 / 这次没连上（不算故障）/ 对面拒了 */
  private async tokenCheck(): Promise<HealthCheck> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_CHECK_TIMEOUT_MS);
    try {
      const me = await this.api.getMe(controller.signal);
      const who = me.username ? `@${me.username}` : String(me.id);
      const never = this.store.read() === null ? '（还没开始收过信）' : '';
      return { name: 'Telegram 登录态', ok: true, detail: `已连上 ${who}${never}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // 连不上 / 被我们掐了 = 这次没查（不是故障）。对面回 401/404 才是 token 的问题。
      if (/连不上 Telegram|取消|abort/i.test(msg)) {
        return {
          name: 'Telegram 登录态',
          ok: true,
          detail: '没查（这次连不上 Telegram）—— 不影响别的检查',
        };
      }
      return {
        name: 'Telegram 登录态',
        ok: false,
        detail: msg,
        fix: '跑 `butler run --again` 重新贴一串（@BotFather 发 /token 可以再要一个）',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ───────────────────────── 内部：收信 ─────────────────────────

  /**
   * 读一次"最新那条 update"的 id，用来跳过积压。
   *
   * 为什么不用 `getUpdates` 空跑一遍：那会把 24 小时的消息全拉回来（正是我们要避免的）。
   * `offset: -1` 是 Telegram 的约定：只返回**最新**的一条。
   */
  private async skipBacklog(signal: AbortSignal): Promise<number> {
    try {
      const last = await this.api.call<{ update_id: number }[]>(
        'getUpdates',
        { offset: -1, limit: 1, timeout: 0 },
        signal,
      );
      const id = last[0]?.update_id;
      return typeof id === 'number' ? id + 1 : 0;
    } catch {
      // 拿不到就当从 0 开始 —— 这是"没登录成功"的场景，本来也收不到历史
      return 0;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeoutSec: this.config.pollTimeoutSec,
          ...(this.abort ? { signal: this.abort.signal } : {}),
        });
        this.backoff = 0;

        for (const u of updates) {
          // **先推 offset 再处理**：反过来的话，处理中崩了会把同一条再处理一遍
          this.offset = Math.max(this.offset, u.update_id + 1);
          try {
            this.store.write(this.offset);
          } catch (error) {
            // 写不进去（磁盘满、只读）不致命：内存里还准，重启后最多重放一次积压。
            // 但这个信号必须说出来 —— 它是"重启后会重复执行"的前兆。
            this.ctx.logger?.warn('telegram: offset 落盘失败，重启后可能重放历史: %o', error);
          }

          const norm = normalizeUpdate(u);
          if (!norm) continue;
          if (!this.allowed(norm.fromId)) {
            this.ctx.logger?.info('telegram: 忽略了不在 allowFrom 里的会话 %s', norm.fromId);
            continue;
          }
          this.queue.push(norm);
        }
        this.wakeWorker();
      } catch (error) {
        if (this.stopping) return;
        this.noteError(error);
        await sleep(this.nextBackoff(), this.abort?.signal);
      }
    }
  }

  /** 只在**第一次**见到某个错的时候大声说，之后安静退避 —— 刷屏没有信息量 */
  private noteError(error: unknown): void {
    const code = error instanceof TelegramError ? error.code : 0;
    const text = error instanceof Error ? error.message : String(error);
    if (this.shouted.has(code)) {
      this.ctx.logger?.debug('telegram: 收信又失败了（同类，已说过）: %s', text);
      return;
    }
    this.shouted.add(code);
    this.ctx.logger?.error('telegram: 收信失败：%s', text);
  }

  private nextBackoff(): number {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, MAX_BACKOFF_MS) : 1000;
    return this.backoff;
  }

  private allowed(fromId: string): boolean {
    const list = this.config.allowFrom;
    return list.length === 0 || list.includes(fromId);
  }

  private wakeWorker(): void {
    this.wake?.();
    this.wake = null;
  }

  // ───────────────────────── 内部：干活 ─────────────────────────

  /**
   * 取件 → 交给核心层。
   *
   * 单独一个循环，**跟收信完全解耦**：下载慢不该让轮询掉线，
   * 核心层处理慢同样不该。
   */
  private async deliverLoop(): Promise<void> {
    while (!this.stopping) {
      const item = this.queue.shift();
      if (!item) {
        // 没活干就睡，等收信那边叫醒 —— 不许用轮询空转烧 CPU
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          // 兜底：万一叫醒丢了（收信循环刚好在赋 wake 之前推了队列），
          // 最多 1 秒之后自己醒一次
          const t = setTimeout(() => {
            this.wake = null;
            resolve();
          }, 1000);
          t.unref?.();
        });
        continue;
      }
      try {
        await this.deliver(item);
      } catch (error) {
        // 一条消息处理失败不能把干活的循环带走 —— 后面还有别人的消息
        this.ctx.logger?.error('telegram: 处理消息失败（已跳过）: %o', error);
      }
    }
  }

  private async deliver(item: NormalizedUpdate): Promise<void> {
    const files: LocalFile[] = [];
    const notes: string[] = [];

    for (const p of item.pending) {
      if (p.size && p.size > this.config.maxMediaBytes) {
        notes.push(`（有 ${Math.round(p.size / 1024 / 1024)}MB 的${kindWord(p.kind)}，超过上限没取回来）`);
        continue;
      }
      try {
        files.push(await this.fetchOne(item.messageId, p));
      } catch (error) {
        // 单个附件失败不算整条失败：文字照样要送达，并说明哪个没取到
        notes.push(`（${p.name} 没取回来）`);
        this.ctx.logger?.warn('telegram: 取件失败 %s: %o', p.fileId, error);
      }
    }

    const text = [item.text, ...notes].filter(Boolean).join('\n');
    const msg: InboundMessage = {
      channel: this.id,
      fromId: item.fromId,
      ...(text ? { text } : {}),
      ...(item.quote ? { quote: item.quote } : {}),
      ...(files.length ? { files } : {}),
      contextToken: item.contextToken,
      raw: item.raw,
    };
    this.emitMessage(msg);
  }

  /** 把一个附件取回本机。**两段式**：先问路径，再下字节 */
  private async fetchOne(messageId: number, p: PendingFile): Promise<LocalFile> {
    const signal = this.abort?.signal;
    const info = await this.api.getFile(p.fileId, signal);
    if (!info.file_path) throw new Error('Telegram 没给文件路径');

    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = join(this.home, 'inbox', day);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const dest = join(dir, `${messageId}-${p.name}`);
    try {
      await this.api.download(info.file_path, dest, signal);
      // Telegram 报的大小可能没有；用真实落盘的大小，核心层要拿它做判断
      const size = statSync(dest).size;
      // 附件落盘之后一律 0600：用户让管家收的文件可能很私人
      chmodQuiet(dest);
      return { path: dest, name: p.name, mime: p.mime, size, kind: p.kind };
    } catch (error) {
      // 半个文件比没有文件更坏：下次读它的东西会读到截断的内容
      rmSync(dest, { force: true });
      throw error;
    }
  }
}

/** 图片后缀。Telegram 的 sendPhoto 只认这几种 */
function isImage(name: string): boolean {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(name).toLowerCase());
}

function kindWord(kind: string): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'voice' ? '语音' : '文件';
}

function chmodQuiet(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // 权限设不上（比如 Windows）不影响主流程
  }
}

/**
 * 把长文本切成 Telegram 吃得下的几段。
 *
 * 三个坑都在这儿挡掉：
 *   1. **长度按 UTF-16 单元算**（Telegram 就是这么算的），不是"字符数" ——
 *      一个中文是一个单元，一个 emoji 是两个。
 *   2. **不能把代理对切开**，所以切点落 emoji 中间时往前挪一位。
 *   3. **优先切在换行/空格上**，不然会把一个词劈成两半。
 */
export function chunkText(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  const out: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = -1;
    // 往前找最多 200 个单位，看有没有天然的断点（换行最好，空格次之）
    for (let i = limit; i > Math.max(0, limit - 200); i -= 1) {
      const ch = rest[i - 1];
      if (ch === '\n' || ch === ' ') {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = limit;
    // 切点前面是个"高代理"（emoji 的前半），往后退一位，别把它劈开
    if (cut > 1 && isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
    if (cut <= 0) cut = Math.min(2, limit);

    out.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 可被 abort 打断的 sleep：stop() 的时候不用等退避跑完 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default TelegramChannel;
