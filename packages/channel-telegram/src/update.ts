/**
 * Telegram 的 **Update → 入站消息** 映射。
 *
 * 这一层是**纯函数**：没有网络、没有磁盘、没有 cordis。好处是 Telegram 那套
 * 嵌套结构（`message.photo` 是一组分辨率、`document` 里才有文件名、`caption`
 * 代替 `text`……）可以拿真样本离线怼，不用起服务器。
 *
 * ── 两条从 seam 契约下来的规矩 ──────────────────────────────────
 *
 * 1. **附件这里不下载。** 这里只产出"待取件清单"（`PendingFile`），下载由插件里
 *    的 worker 干 —— 因为在收信循环里下载会让长轮询掉线（seam 注释里的第 3 条）。
 * 2. **认不出来的 update 一律返回 null，不是抛错。** Telegram 会推很多我们
 *    不关心的东西（别人进了群、机器人被踢、频道的帖子）。它们是**正常的噪音**，
 *    不是异常。
 *
 * @module @butler/channel-telegram/update
 */

import { quotedMedia } from '@butler/seam-channel';
import type { FileKind } from '@butler/seam-channel';
import type { TgMessage, TgUpdate } from './api.js';

/** 一个等着被下载的附件。名字已经处理好，可以直接落盘 */
export interface PendingFile {
  /** 拿去问 `getFile` 的凭据 */
  fileId: string;
  /** 落盘用的文件名（已做安全处理） */
  name: string;
  /** 猜出来的 MIME。猜不出用 application/octet-stream */
  mime: string;
  /** 种类。核心层用它决定"图片能不能给模型看" */
  kind: FileKind;
  /** Telegram 报的大小（字节）。0 = 不知道 */
  size: number;
}

/** 一条归一化之后的入站消息（附件还没下载） */
export interface NormalizedUpdate {
  /** 通道内的发送者。**Telegram 用 chat id**（seam 的类型注释里就是这么写的） */
  fromId: string;
  /** 这条消息在 Telegram 里的 id。用来发原生引用回复 */
  messageId: number;
  /** 文本，或图片/文件的配文。空串 → undefined */
  text?: string;
  /**
   * 用户引用的那句话（`reply_to_message`），压成一行纯文本。
   *
   * 走 `quote` 而不是并进 `text`：引用里出现 `@某台设备` 不算在叫设备
   * （路由只看正文）—— 用户是在引用自己以前说过的话。
   */
  quote?: string;
  /**
   * 回复这条消息要带上的凭据，格式 `chatId:messageId`。
   *
   * 为什么塞两个：seam 的 `SendOpts.contextToken` 是通道私有的自由格式，
   * 而 Telegram 的引用回复需要 `reply_to_message_id`。把 message id 一起带上，
   * 回复时就能发**原生引用**（用户要的"知道它回的是哪一条"），而不用像微信
   * 那样加 `↩ …` 前缀（微信的协议里没有这个字段，只能凑）。
   */
  contextToken: string;
  /** 待取件的附件，按 Telegram 给的顺序 */
  pending: PendingFile[];
  /** 通道私有的原始事件（seam 契约里的逃生舱） */
  raw: TgUpdate;
}

/** 从 `contextToken` 里解出 `{ chatId, messageId }`。解不出就是没带，正常 */
export function parseContextToken(token: string | undefined): { chatId: string; messageId?: number } {
  const raw = (token ?? '').trim();
  const at = raw.lastIndexOf(':');
  if (at <= 0) return { chatId: raw };
  const head = raw.slice(0, at);
  const tail = raw.slice(at + 1);
  const id = Number(tail);
  return Number.isInteger(id) && id > 0
    ? { chatId: head, messageId: id }
    : { chatId: raw };
}

/**
 * 把一条 Telegram 的 Update 归一化成入站消息。
 *
 * 返回 `null` = "这条跟我们无关"，调用者直接跳过。
 */
export function normalizeUpdate(update: TgUpdate | undefined): NormalizedUpdate | null {
  // 只认 message。edited_message 是"有人改了刚才那句话" —— 当新消息处理会让
  // agent 把同一件事干两遍；channel_post 是频道广播，不是有人在跟管家说话。
  const msg = update?.message;
  if (!msg || !update) return null;

  const chatId = chatIdOf(msg);
  if (!chatId) return null;

  const body = textOf(msg);
  const pending = pendingFilesOf(msg);

  // 用户在 Telegram 里**引用**管家某条消息再说话时，那句被引用的话挂在
  // `reply_to_message` 上。它单独走 `quote` 字段：路由不能看它（引用里出现
  // `@某台设备` 不算在叫人），但 agent 要看得到用户在回哪一句。
  const quote = quoteTextOf(msg);
  const text = body;

  // 真·空消息（既没字、没附件、也没有引用，比如服务消息"某某加入了群"）：没什么可处理的。
  //
  // ⚠️ **只有引用、没有说话**不算空消息 —— 用户是在指着某句话，那是内容。
  // （以前引用是拼进正文的一行字，那时"光引用不说话"确实没法处理；现在它是
  // 独立字段，交上去 agent 就知道他在指什么 —— 两个通道在这件事上必须一致。）
  if (!body && pending.length === 0 && !quote) return null;

  return {
    fromId: chatId,
    messageId: msg.message_id,
    ...(text ? { text } : {}),
    ...(quote ? { quote } : {}),
    contextToken: `${chatId}:${msg.message_id}`,
    pending,
    raw: update,
  };
}

/**
 * 用户引用的那句话（`reply_to_message`），压成一行纯文本。
 *
 * 微信那边叫 `ref_msg`，Telegram 这边叫 `reply_to_message` —— 形状不同，
 * 交出去的字段是同一个（`InboundMessage.quote`）。
 */
function quoteTextOf(msg: TgMessage): string | undefined {
  const quoted = msg.reply_to_message;
  if (!quoted) return undefined;
  const one = (typeof quoted.text === 'string' && quoted.text ? quoted.text : quoted.caption ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (one) return one;
  // 引用的是图片/文件（没有文字）时，说清楚引的是什么 —— agent 才知道上下文是什么。
  // 写法由 seam 统一定义（和微信那侧必须逐字一致），有文件名就带上。
  const kind: FileKind = quoted.photo ? 'image'
    : quoted.video ? 'video'
    : quoted.voice ? 'voice'
    : quoted.audio ? 'file'
    : quoted.document ? 'file'
    : 'unknown';
  const name = quoted.document?.file_name ?? quoted.video?.file_name ?? quoted.audio?.file_name;
  return quotedMedia(kind, name);
}

/** chat id 一律转成字符串 —— seam 的 `fromId` 是 string，而 Telegram 给的是数字 */
function chatIdOf(msg: TgMessage): string {
  const id = msg.chat?.id;
  return typeof id === 'number' || typeof id === 'string' ? String(id) : '';
}

function textOf(msg: TgMessage): string {
  const raw = typeof msg.text === 'string' && msg.text ? msg.text : msg.caption;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 从一条消息里挑出所有要取回本机的附件 */
function pendingFilesOf(msg: TgMessage): PendingFile[] {
  const out: PendingFile[] = [];

  // 图片：Telegram 一次给好几档分辨率（从小到大）。**取最后一档**，
  // 就是它手里最大的那张 —— 取第一档会让模型看一张 90px 的缩略图。
  const photo = msg.photo;
  if (Array.isArray(photo) && photo.length) {
    for (let i = photo.length - 1; i >= 0; i -= 1) {
      const p = photo[i];
      if (p?.file_id) {
        out.push({
          fileId: p.file_id,
          // Telegram 的图片一律是 JPEG（要 PNG 得让机器人当文件发）
          name: `photo-${msg.message_id}.jpg`,
          mime: 'image/jpeg',
          kind: 'image',
          size: num(p.file_size),
        });
        break;
      }
    }
  }

  if (msg.document?.file_id) {
    out.push({
      fileId: msg.document.file_id,
      name: safeName(msg.document.file_name, `file-${msg.message_id}`),
      mime: msg.document.mime_type || 'application/octet-stream',
      kind: 'file',
      size: num(msg.document.file_size),
    });
  }

  // 语音：Telegram **不转写**。所以这里只能把音频本身交出去，
  // 不带假文本 —— 核心层会看到"只有附件没有字"，这是实话。
  if (msg.voice?.file_id) {
    out.push({
      fileId: msg.voice.file_id,
      name: `voice-${msg.message_id}.ogg`,
      mime: msg.voice.mime_type || 'audio/ogg',
      kind: 'voice',
      size: num(msg.voice.file_size),
    });
  }

  if (msg.audio?.file_id) {
    out.push({
      fileId: msg.audio.file_id,
      name: safeName(msg.audio.file_name, `audio-${msg.message_id}`),
      mime: msg.audio.mime_type || 'audio/mpeg',
      kind: 'file',
      size: num(msg.audio.file_size),
    });
  }

  if (msg.video?.file_id) {
    out.push({
      fileId: msg.video.file_id,
      name: safeName(msg.video.file_name, `video-${msg.message_id}.mp4`),
      mime: msg.video.mime_type || 'video/mp4',
      kind: 'video',
      size: num(msg.video.file_size),
    });
  }

  if (msg.sticker?.file_id) {
    out.push({
      fileId: msg.sticker.file_id,
      name: `sticker-${msg.message_id}.webp`,
      mime: msg.sticker.mime_type || 'image/webp',
      kind: 'image',
      size: num(msg.sticker.file_size),
    });
  }

  return out;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 文件名安全化。
 *
 * Telegram 给的 `file_name` 是**发送方**决定的，可以包含 `../../`（这不是理论：
 * 恶意的文件名是最老的一类攻击）。所以这里只留基名、去掉控制字符和路径分隔符，
 * 空的话退回一个我们自己的名字。
 */
export function safeName(name: unknown, fallback: string): string {
  const raw = typeof name === 'string' ? name : '';
  // 先把路径切掉：反斜杠也要切，因为同一份文件可能在 Windows 上生成
  const base = raw.split(/[/\\]/).pop() ?? '';
  // 控制字符 + Telegram 不喜欢的字符一律换掉
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  // 全都是点（"." / ".."）也算空
  const useful = cleaned.replace(/^\.+$/, '');
  return (useful || fallback).slice(0, 120);
}
