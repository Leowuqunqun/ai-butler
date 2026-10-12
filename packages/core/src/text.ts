/**
 * 内核用的几段文案。
 *
 * 跟旧版命令行（`packages/channel-wechat/src/text.mjs`）里的同名函数是
 * **刻意重复**的：内核不能依赖某个具体通道包，否则"换通道不用改核心层"
 * 就成了空话。等命令行那条路也搬到内核上，旧的那份就删掉。
 *
 * @module @butler/core
 */

import type { LocalFile } from '@butler/seam-channel';

/**
 * 用户引用了一句话时，把它作为**上下文**顶在提示词最前面。
 *
 * 为什么要给 agent 看：连着发好几条时，"他这句是在回哪句"是理解问题的前提 ——
 * 用户当初要的就是这个（"发多次也知道他回复的是哪一个问题"）。
 *
 * 为什么路由**不看**它：引用里出现 `@某台设备` 不算在叫设备，用户只是在引用
 * 自己以前说过的话。所以它在 `InboundMessage.quote` 里，不在 `text` 里。
 */
export function quoteContext(quote: string | undefined): string {
  const one = String(quote ?? '').replace(/\s+/g, ' ').trim();
  return one ? `[引用: ${one}]\n` : '';
}

/**
 * 把附件的本机路径附在提示词末尾。
 *
 * 为什么要有：不是每个 agent 都会读 `files` 字段，但**每个** agent 都看得懂
 * 自己面前有个文件路径。这行是兜底，让"不认识多模态的后端"也能用上附件。
 */
export function filesHint(files: LocalFile[] | undefined): string {
  const list = (files ?? []).filter((f) => f?.path);
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.path}（${f.name}, ${f.mime}, ${f.size} 字节）`);
  return `\n\n（附件已下载到本机，可直接读取：\n${lines.join('\n')}\n）`;
}

/** 纯附件、没附文字时的起步提示 */
export function defaultPrompt(files: LocalFile[] | undefined): string {
  const kind = files?.[0]?.kind;
  if (!kind) {
    // 没有附件也没有正文 —— 只可能是"他只引用了一句话，自己没打字"。
    // 以前这里会说"我发来一个文件"，那是在撒谎（根本没有文件）。
    return '（我这次只引用了一句话，没打字。看我引用的那句，需要的话直接问我。）';
  }
  const what = kind === 'image' ? '图片'
    : kind === 'video' ? '视频'
      : kind === 'voice' ? '语音' : '文件';
  return `（我发来一个${what}，没有附文字。看看是什么，需要的话告诉我。）`;
}

/** 把任何抛出来的东西变成一句能给人看的话 */
export function errText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}
