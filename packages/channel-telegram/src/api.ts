/**
 * Telegram Bot API 客户端 —— 只做"发请求 + 归一化错误"，不含任何管家概念。
 *
 * ── 为什么自己写，不拉一个库 ────────────────────────────────────
 *
 * 这个产品的通道层要能被人替换和审计：它碰的是用户的电脑。多一个依赖就多一份
 * 供应链风险，而 Bot API 本身是**纯 JSON over HTTPS**，需要的只有五个方法。
 * 所以这里就是 `fetch` + 一个错误映射，`node:` 之外零依赖。
 *
 * ── 错误必须是给人看的话 ────────────────────────────────────────
 *
 * Telegram 出错时返回 `{ok:false, error_code, description}`，`description` 是英文
 * 而且是给开发者看的（"Unauthorized"、"Conflict: terminated by other getUpdates
 * request"）。用户看到这些只会去网上搜。所以这里按 `error_code` 翻成人话，
 * 见 `explain()`。**原始 description 不丢**，挂在 `TelegramError.description` 上，
 * 排查时还能拿出来。
 *
 * @module @butler/channel-telegram/api
 */

/** Telegram 官方 API 根地址。测试里换成假的（`baseUrl`）就会走到别的服务器 */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** 一条消息最多多少**字符**（Telegram 的硬上限，超了直接 400） */
export const MAX_MESSAGE_CHARS = 4096;

/** Telegram 自己允许机器人下载的文件上限 */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** 出错了。`description` 是 Telegram 的原文，`message` 是给用户看的中文 */
export class TelegramError extends Error {
  readonly code: number;
  readonly description: string;
  /** 429 时 Telegram 会告诉你等多久（秒） */
  readonly retryAfterSec: number;

  constructor(code: number, description: string, retryAfterSec = 0) {
    super(explain(code, description));
    this.name = 'TelegramError';
    this.code = code;
    this.description = description;
    this.retryAfterSec = retryAfterSec;
  }
}

/** 把 Telegram 的错误码翻成"用户看完知道该干什么"的一句话 */
function explain(code: number, description: string): string {
  if (code === 401) {
    return 'Telegram 说这个 token 不认 —— 复制的时候可能少了几位，或者它已经被作废了'
      + '（跑 `butler run --again` 可以重新贴一次）';
  }
  if (code === 404) {
    return 'Telegram 说没这个 token（或者这个机器人被删了）—— 跑 `butler run --again` 换一串';
  }
  if (code === 409) {
    return '同一个机器人有**另一个程序**正在收信 —— Telegram 只允许一个。'
      + '先确认没有第二份管家在跑（它会把消息随机分给两边，表现是"有时不回"）';
  }
  if (code === 429) return '发得太快了，Telegram 让我们等一下再发';
  if (code === 400) return `Telegram 不接受这个请求：${description}`;
  if (code === 403) return '这个机器人被对方拉黑了，或者它没被允许给你发消息（先在对话里点一下 Start）';
  return `Telegram 出错了（${code}）：${description}`;
}

/** 一次 API 调用的形状。`result` 由各方法自己解释 */
interface ApiResponse<T> {
  ok?: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramApiOptions {
  /** BotFather 给的那串 `123456:ABC-DEF…` */
  token: string;
  /**
   * 换掉 API 根地址。**只给测试用** —— 真实产品永远走官方地址，
   * 免得有人以为管家支持"自建 Telegram 服务端"（那是另一件事，没做）。
   */
  baseUrl?: string;
  /** 换掉 fetch。测试里用来注入一个必定失败的实现 */
  fetchImpl?: typeof fetch;
}

export interface GetUpdatesOpts {
  /** 只要 update_id ≥ offset 的。**收到一条就把 offset 推到它 +1**，否则会重复收 */
  offset: number;
  /** 长轮询挂多久（秒）。0 = 立刻返回（测试用） */
  timeoutSec?: number;
  signal?: AbortSignal;
}

/** Telegram 的 Update 形状。只声明我们真的会读的字段，别的原样带在 `raw` 里 */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  channel_post?: TgMessage;
  [k: string]: unknown;
}

export interface TgMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  chat: { id: number; type?: string; title?: string; first_name?: string; username?: string };
  date?: number;
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_unique_id?: string; width?: number; height?: number; file_size?: number }[];
  document?: TgFileRef & { file_name?: string };
  voice?: TgFileRef & { duration?: number };
  audio?: TgFileRef & { file_name?: string };
  video?: TgFileRef & { file_name?: string };
  sticker?: TgFileRef;
  reply_to_message?: TgMessage;
  [k: string]: unknown;
}

export interface TgFileRef {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  mime_type?: string;
}

export class TelegramApi {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramApiOptions) {
    this.token = opts.token;
    this.url = `${opts.baseUrl || TELEGRAM_API_BASE}/bot${opts.token}`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 文件下载走**另一条**路径：`/file/bot<token>/<file_path>`（没有方法名） */
  get fileBase(): string {
    const base = this.url.replace(/\/bot[^/]*$/, '');
    return `${base}/file/bot${this.token}`;
  }

  /** 一个通用调用。JSON 进、JSON 出，错了就抛 `TelegramError` */
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // 网络层的错（DNS、断网、被 abort）在这里统一成一句话：
      // 上面那些 TelegramError 是"服务器回话了但说不行"，这里连话都没回上。
      if (signal?.aborted) throw error;
      throw new Error(`连不上 Telegram（${method}）：${describeNetworkError(error)}`);
    }

    let body: ApiResponse<T>;
    try {
      body = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new Error(`Telegram 回了一句读不懂的话（HTTP ${res.status}）`);
    }

    if (!body.ok) {
      throw new TelegramError(
        body.error_code ?? res.status,
        body.description ?? '(没有说明)',
        body.parameters?.retry_after ?? 0,
      );
    }
    return body.result as T;
  }

  /** 我是谁。启动时调一次，能把 token 错当场说清楚，还能把用户名打给用户看 */
  getMe(signal?: AbortSignal): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call('getMe', {}, signal);
  }

  /**
   * 长轮询收信。
   *
   * `timeoutSec` 是**挂多久**（Telegram 那边等），不是本地超时。挂着的这段时间里
   * 随时可能被 `signal` 掐断 —— `stop()` 必须能立刻返回，不能等长轮询自己到点。
   */
  getUpdates(opts: GetUpdatesOpts): Promise<TgUpdate[]> {
    const params: Record<string, unknown> = {
      offset: opts.offset,
      // 少收几种：编辑过的消息、频道帖子这些不是"用户跟我说话"，收到只会添乱
      allowed_updates: ['message'],
    };
    if (opts.timeoutSec) params['timeout'] = opts.timeoutSec;
    return this.call<TgUpdate[]>('getUpdates', params, opts.signal);
  }

  /** 发文本。`replyTo` 带上就是 Telegram 原生的**引用回复**（用户要的"知道在回哪一条"） */
  sendMessage(opts: {
    chatId: string;
    text: string;
    replyTo?: number;
    signal?: AbortSignal;
  }): Promise<{ message_id: number }> {
    const params: Record<string, unknown> = { chat_id: opts.chatId, text: opts.text };
    // 不设 parse_mode：Telegram 默认 Markdown，而我们的契约是**纯文本**（见人格约定）。
    // 设了 parse_mode 反而会让用户文本里的下划线/星号被吃掉。
    if (opts.replyTo) params['reply_to_message_id'] = opts.replyTo;
    return this.call<{ message_id: number }>('sendMessage', params, opts.signal);
  }

  /** "正在输入…"。用户等 agent 干活的时候，这一行字值很多 */
  sendChatAction(chatId: string, action = 'typing', signal?: AbortSignal): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action }, signal);
  }

  /** 发一个本机文件（原样，不压缩） */
  async sendDocument(opts: {
    chatId: string;
    path: string;
    name: string;
    caption?: string;
    replyTo?: number;
    signal?: AbortSignal;
  }): Promise<{ message_id: number }> {
    return this.callMultipart('sendDocument', 'document', opts);
  }

  /** 发一张图 —— Telegram 会把它当图片渲染出来（点开能看大图） */
  async sendPhoto(opts: {
    chatId: string;
    path: string;
    name: string;
    caption?: string;
    replyTo?: number;
    signal?: AbortSignal;
  }): Promise<{ message_id: number }> {
    return this.callMultipart('sendPhoto', 'photo', opts);
  }

  private async callMultipart(
    method: string,
    field: string,
    opts: { chatId: string; path: string; name: string; caption?: string; replyTo?: number; signal?: AbortSignal },
  ): Promise<{ message_id: number }> {
    // openAsBlob 是**流式**的：发一个 300MB 的文件不会先把它整个读进内存
    const { openAsBlob } = await import('node:fs');
    const form = new FormData();
    form.set('chat_id', opts.chatId);
    if (opts.caption) form.set('caption', opts.caption);
    // 文件也能挂原生引用回复 —— 和文本同一个语义（`SendOpts.quote`）
    if (opts.replyTo) form.set('reply_to_message_id', String(opts.replyTo));
    form.set(field, await openAsBlob(opts.path), opts.name);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/${method}`, {
        method: 'POST',
        body: form,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new Error(`连不上 Telegram（${method}）：${describeNetworkError(error)}`);
    }
    const body = (await res.json()) as ApiResponse<{ message_id: number }>;
    if (!body.ok) {
      throw new TelegramError(
        body.error_code ?? res.status,
        body.description ?? '(没有说明)',
        body.parameters?.retry_after ?? 0,
      );
    }
    return body.result as { message_id: number };
  }

  /** 问一个文件的下载路径。**得再发一次请求才能拿到字节** —— 这就是两段式 */
  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string; file_size?: number }> {
    return this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId }, signal);
  }

  /** 把文件字节流到本机某个路径。返回实际写了多少字节 */
  async download(filePath: string, dest: string, signal?: AbortSignal): Promise<number> {
    const res = await this.fetchImpl(`${this.fileBase}/${filePath}`, signal ? { signal } : {});
    if (!res.ok) throw new Error(`下载文件失败（HTTP ${res.status}）—— 文件可能太大了`);
    if (!res.body) throw new Error('下载文件失败：Telegram 没有返回内容');

    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    // Readable.fromWeb 要的是 undici 的 ReadableStream，这里类型是对得上的（@types/node 22）
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return Number(res.headers.get('content-length') ?? 0);
  }
}

/** 网络层的错翻译成人话。这里的原则是：**别把 errno 抛给用户** */
function describeNetworkError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ENOTFOUND|EAI_AGAIN/i.test(msg)) return '网络不通（检查一下这台电脑能不能上外网）';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝';
  if (/ETIMEDOUT|timeout/i.test(msg)) return '等太久了';
  return msg;
}
