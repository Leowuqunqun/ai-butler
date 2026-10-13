/**
 * 飞书归一化消息 → 接缝的 `InboundMessage`。
 *
 * 这一层刻意做成**纯函数**：不发网络、不落盘、不碰 cordis —— 所以能离线测。
 * 长连接、重连、去重、媒体上传那些全在 `@larksuite/channel` 里，我们不重写；
 * 我们只负责"把它的形状折成 `ctx.channel` 认的形状"。
 *
 * @module @butler/channel-feishu/map
 */

import type { InboundMessage, LocalFile } from '@butler/seam-channel';
import type { NormalizedMessage } from '@larksuite/channel';

/**
 * 回一条消息需要知道的两件事：**回哪个会话**，以及（走原生引用时）**回哪句话**。
 *
 * 为什么 chatId 是必需的：飞书发消息的收件人可以是用户（`open_id`）也可以是群
 * （`chat_id`），但**回复要落回原来那个会话** —— 群里来的消息回给用户会变成私聊，
 * 那是另一条对话。单聊同理：`chatId` 就是那个单聊会话。
 */
export interface FeishuContext {
  chatId: string;
  messageId?: string;
  threadId?: string;
}

/** 把会话信息编成 `contextToken`（接缝那个"回复时要带上的凭据"字段） */
export function encodeContext(
  msg: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
): string {
  const ctx: FeishuContext = { chatId: msg.chatId, messageId: msg.messageId };
  if (msg.threadId) ctx.threadId = msg.threadId;
  return JSON.stringify(ctx);
}

/**
 * 解回来。解析不出来时**退化到调用方给的收件人**，而不是抛错 ——
 * 主动推送（进度播报、将来的提醒）本来就没有 contextToken，那条路必须照走。
 */
export function decodeContext(token: string | undefined, fallbackTo: string): FeishuContext {
  if (token) {
    try {
      const raw = JSON.parse(token) as Partial<FeishuContext>;
      if (typeof raw?.chatId === 'string' && raw.chatId) {
        const ctx: FeishuContext = { chatId: raw.chatId };
        if (typeof raw.messageId === 'string') ctx.messageId = raw.messageId;
        if (typeof raw.threadId === 'string') ctx.threadId = raw.threadId;
        return ctx;
      }
    } catch {
      // 坏 token 不当故障：下面退化。
    }
  }
  return { chatId: fallbackTo };
}

/** 附件类型的人话名字 —— 引用里提到媒体时要说清楚是什么 */
const KIND_LABEL: Record<string, string> = {
  image: '图片',
  file: '文件',
  audio: '语音',
  video: '视频',
  sticker: '表情',
};

/**
 * 一条消息在"被引用"时的念法：文本用正文，媒体说清是什么。
 *
 * `content` 是 `@larksuite/channel` 归一化后的文本（群里 @ 机器人时，
 * 正文里的 `@_user_1` 已经被换成人名了 —— 这正是我们不自己解析事件的原因之一）。
 */
export function describe(msg: NormalizedMessage): string {
  const text = (msg.content ?? '').trim();
  if (text) return text;
  if (msg.resources.length === 0) return `（${msg.rawContentType || '未知类型'}）`;
  return msg.resources
    .map((r) => `［${KIND_LABEL[r.type] ?? '附件'}］${r.fileName ?? ''}`.trimEnd())
    .join(' ');
}

/**
 * 接缝要求引用是**一行纯文本**（它会被放进提示词当上下文）。
 * 换行压成 ` / `；太长就截断 —— 引用是给"他在回哪句"用的，不是全文转载。
 */
export function toQuoteLine(msg: NormalizedMessage, max = 50): string {
  const one = describe(msg).replace(/\s*\n+\s*/g, ' / ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 归一化消息 → `InboundMessage`。
 *
 * 引用原文和附件都**由调用方准备好再传进来**：引用要取一次网络（`fetchMessage`），
 * 附件要落一次盘（`downloadResourceToFile`）—— 两件都不属于"纯映射"，
 * 所以这个文件里一个 `await` 都没有，全部能离线测。
 */
export function toInbound(
  msg: NormalizedMessage,
  opts: { quote?: string; channelId?: string; files?: LocalFile[] } = {},
): InboundMessage {
  const out: InboundMessage = {
    channel: opts.channelId ?? 'feishu',
    fromId: msg.senderId,
    contextToken: encodeContext(msg),
    raw: msg,
  };
  const text = (msg.content ?? '').trim();
  const textual = msg.rawContentType === 'text' || msg.rawContentType === 'post';
  if (textual && text) out.text = text;
  if (opts.quote) out.quote = opts.quote;
  if (opts.files?.length) out.files = opts.files;
  return out;
}
