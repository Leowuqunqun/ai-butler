/**
 * "引用的是媒体"时**唯一的写法**（类别认得出来的那几种）。
 *
 * 类别认不出来时，通道可以用协议给的标题兜底：微信的 `ref_msg.title` 是服务端
 * 给的一句人话（"一条语音消息"），比 `[消息]` 有用；Telegram 没有这个字段，
 * 就退回 `quotedMedia('unknown')`。这条兜底路**不走这个函数**，因为它是
 * 协议各自的差异，不是"同一件事两种写法"。
 *
 * ── 为什么这事值得放在 seam 里 ────────────────────────────────────
 *
 * `InboundMessage.quote` 是一行纯文本，会被内核当成上下文放进提示词
 * （`[引用: …]`）。如果每个通道自己拼这一行，就会出现：
 *
 *     微信   → [引用: [文件（报表.xlsx）]]
 *     Telegram → [引用: [一个文件]]
 *
 * 同一件事，agent 看到的上下文不一样 —— 而 agent 对"用户在回哪句"的理解
 * 恰恰取决于这几个字。文件名是这里唯一真正帮得上忙的信息（"回的是哪个文件"
 * 才是用户想问的），所以带上它。
 *
 * 通道负责**取出**名字和类别，写法由这里统一定义。
 *
 * @module @butler/seam-channel/quote
 */

import type { FileKind } from './types.js';

/**
 * 把"引用的是一个媒体"写成一行纯文本，例如 `[图片]`、`[文件（报表.xlsx）]`。
 *
 * 引用的是图片/语音这类没有文件名的，就只有类别；有名字的一律带上。
 * `unknown` 用 `消息` —— 我们只知道那是条消息，就别假装知道它是什么。
 */
export function quotedMedia(kind: FileKind, name?: string): string {
  const label = kind === 'image' ? '图片'
    : kind === 'video' ? '视频'
    : kind === 'voice' ? '语音'
    : kind === 'file' ? '文件'
    : '消息';
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  return clean ? `[${label}（${clean}）]` : `[${label}]`;
}
