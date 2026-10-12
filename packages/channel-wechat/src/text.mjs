/**
 * 文本工具：微信这条通道对文本有它自己的脾气，集中在这里处理。
 *
 *  · 微信不渲染 Markdown → toPlainText
 *  · 单条消息有长度上限 → chunkText 按语义切块
 *  · 语音消息服务端已转写成文字 → extractText 顺手取出来
 *  · agent 想发文件 → extractFileMarkers 从回复里抠出指令
 *  · 协议没有引用回复 → quoteLine 用一行文本替代
 *  · 用户引用了某句话 → extractQuote 取出来（媒体描述用 seam 的统一写法）
 */

import { quotedMedia } from '@butler/seam-channel';

/**
 * 微信不渲染 Markdown：去掉代码块围栏/图片/链接/表格/标题/粗体斜体/删除线/行内码。
 * 保留代码块里的内容本身，只剥掉标记。
 * @param {string} text
 * @returns {string}
 */
export function toPlainText(text) {
  return String(text)
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim())
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\|.*\|[ \t]*$/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .trim();
}

/**
 * 按 空行 → 换行 → 句末标点 → 空格 的优先级切块，尽量不把一句话劈两半。
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < limit * 0.5) {
      cut = Math.max(
        window.lastIndexOf('。'), window.lastIndexOf('！'),
        window.lastIndexOf('？'), window.lastIndexOf('. '),
      );
    }
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 提取来信文本。
 *   type 1 → text_item.text
 *   type 3 → voice_item.text（微信服务端自带语音转写，不需要自己做 ASR）
 * @param {any} msg getUpdates 返回的消息对象
 * @returns {string|null}
 */
export function extractText(msg) {
  const items = msg?.item_list;
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    if (it.type === 1 && typeof it.text_item?.text === 'string' && it.text_item.text.trim()) {
      return it.text_item.text.trim();
    }
    if (it.type === 3 && typeof it.voice_item?.text === 'string' && it.voice_item.text.trim()) {
      return it.voice_item.text.trim();
    }
  }
  return null;
}

/**
 * 用户**引用**的那句话（入站有、出站没有）。
 *
 * 协议里挂在 text item 的 `ref_msg` 上；腾讯自己的参考实现只是把它压成一行纯文本
 * 塞进正文。我们**把它单独交出去**（`InboundMessage.quote`），理由见 seam 的类型注释：
 * 引用不能参与路由，但 agent 必须看得见。
 *
 * 引用的是文字就要文字；引用的是图片/文件/语音，就说清楚是什么（连"被引用的
 * 文件名"一起给，那是唯一能帮上忙的信息）。
 */
export function extractQuote(msg) {
  const items = msg?.item_list;
  if (!Array.isArray(items)) return undefined;
  for (const it of items) {
    if (it?.type !== 1) continue;
    const ref = it.ref_msg;
    if (!ref || typeof ref !== 'object') continue;

    const item = ref.message_item;
    const own = typeof item?.text_item?.text === 'string' ? item.text_item.text.trim() : '';
    if (own) return own;

    // 类别 → seam 的统一写法（两个通道必须写出同一行字，见 seam 的 quote.ts）
    const kind = item?.voice_item ? 'voice'
      : item?.image_item ? 'image'
      : item?.video_item ? 'video'
      : item?.file_item ? 'file'
      : null;
    if (kind) {
      const name = typeof item?.file_item?.file_name === 'string' ? item.file_item.file_name : undefined;
      return quotedMedia(kind, name);
    }
    // 认不出是什么媒体，但服务端给了个人话标题 —— 那比"消息"有用
    const title = typeof ref.title === 'string' ? ref.title.trim() : '';
    return title ? `[${title}]` : undefined;
  }
  return undefined;
}

/**
 * 从 agent 回复里抽出发文件指令。约定 agent 在回复里单独写一行：
 *
 *     [[file:/绝对/路径.pdf]]
 *     [[file:/绝对/路径.png|这是配文]]
 *
 * 抽出后从正文里删掉，返回 { text, files }。
 * @param {string} text
 * @returns {{ text: string, files: { path: string, caption: string }[] }}
 */
export function extractFileMarkers(text) {
  const files = [];
  const clean = String(text)
    .replace(/\[\[file:([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, p, cap) => {
      const fp = String(p).trim();
      if (fp) files.push({ path: fp, caption: (cap ?? '').trim() });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: clean, files };
}

/**
 * 把用户那句话压成一行短引用，顶在回复最前面。
 *
 * iLink 协议**没有出站引用能力**（消息连 id 都没有，无从"引用某一条"），
 * 腾讯官方参考实现处理入站引用时也只是压成一行纯文本。所以这里用同一种办法：
 * 自己把"这是在回哪句"带上，用户连发多条时就不会分不清哪条回复对应哪个问题。
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string} 形如 `↩ 原问题\n`；没有文本时返回空串
 */
export function quoteLine(text, max = 30) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return '';
  return `↩ ${one.length > max ? `${one.slice(0, max)}…` : one}\n`;
}

/**
 * 从消息里取 context_token（回复时带上，微信才知道你在回哪个会话）。
 * @param {any} msg
 * @returns {string|undefined}
 */
export function contextTokenOf(msg) {
  return msg?.context_token ?? undefined;
}
