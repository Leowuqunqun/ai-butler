/**
 * 入站附件：把飞书那份 `ResourceDescriptor` 翻译成接缝要的 `LocalFile`。
 *
 * 接缝的底线写在 `seam-channel/types.ts` 开头：**拿到对象时 `path` 必须已经是
 * 一个可读的真实文件**。所以这一层只做"跟协议无关"的那部分 ——
 * 名字怎么起、类型怎么翻译、猜不出 MIME 怎么办。
 *
 * 真正的下载在 `index.ts` 里交给官方包（`downloadResourceToFile`）：
 * 我们一行 HTTP 都不写，这是这个包从头到尾的立场。
 */

import { extname, join } from 'node:path';

import type { FileKind, LocalFile } from '@butler/seam-channel';
import type { ResourceDescriptor } from '@larksuite/channel';

/** 扩展名 → MIME。猜不出给 `application/octet-stream`（跟微信那边同一个立场） */
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

/**
 * 官方下载接口只认两种类型：`image` 和 `file`。
 *
 * 所以 `audio` / `video` / `sticker` 都按 `file` 走 —— 这不是偷懒，
 * 是官方类型定义就是这么写的（`type ResourceType = 'image' | 'file'`）。
 * 分门别类留给下面那个 `kindOf`，它管的是"接缝怎么称呼它"，不是"怎么下载"。
 */
export function downloadTypeOf(type: ResourceDescriptor['type']): 'image' | 'file' {
  return type === 'image' ? 'image' : 'file';
}

/** 飞书的类型 → 接缝的类型。飞书叫 `audio`，接缝叫 `voice` */
export function kindOf(type: ResourceDescriptor['type']): FileKind {
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'voice';
    // 表情包本质是图片，但接缝没有 `sticker` 这一档 —— 归到图片最不容易误解
    case 'sticker':
      return 'image';
    default:
      return 'file';
  }
}

/**
 * 文件名消毒。**这个函数的每一行都是在防"文件名里有路径"**：
 *
 *   · `..` / `/` / `\` 一律换成 `_` —— 不然 `../../.ssh/authorized_keys` 这种
 *     名字能把文件写到目录外面去（对方是可以随便起文件名的）
 *   · 去掉前导点 —— 别在收件箱里造出隐藏文件
 *   · 只留中英文、数字、`._-`（`\p{L}` 保住中文名）
 *   · 截 120 字 —— 路径长度有上限，别让一个超长名字把写入搞崩
 */
export function sanitizeName(name?: string): string {
  return String(name ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}

/**
 * MIME：**服务器说的优先**，其次按扩展名猜。
 *
 * 为什么服务器优先：飞书返回的 `content-type` 是它自己认的，比我们按后缀猜准
 * （尤其微信/飞书那种"文件名没有扩展名"的情况）。它没给才轮到我们猜。
 */
export function guessMime(name: string, fromServer?: string): string {
  const server = (fromServer ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  // 只认"看着像 MIME"的：`application/octet-stream` 是官方包在缺 content-type
  // 时的兜底值，没有信息量 —— 那种情况留给扩展名去猜
  if (server.includes('/') && server !== 'application/octet-stream') return server;
  return MIME[extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';
}

/** 没有原文件名时，按类型给个后缀，免得落下来是一堆没后缀的文件 */
const FALLBACK_EXT: Record<FileKind, string> = {
  image: '.jpg',
  video: '.mp4',
  voice: '.opus',
  file: '.bin',
  unknown: '.bin',
};

/**
 * 落盘位置：`<dir>/<ISO 时间>-<安全名>`。
 *
 * 时间戳在前有两个好处：**可排序**（收件箱按名字排就是按时间排）、**不撞名**
 * （同一个 fileKey 重投、或者两张都叫 `image.jpg` 的图片，不会互相覆盖）。
 * 这套起名法是照抄微信通道的（`channel-wechat/src/media.mjs` 的 `saveInbound`）——
 * 两个通道落下来的文件长得一样，用户和 agent 都不用重新适应。
 */
export function destFor(
  dir: string,
  res: ResourceDescriptor,
  at: number = Date.now(),
): { path: string; name: string } {
  const kind = kindOf(res.type);
  let base = sanitizeName(res.fileName);
  if (!base) {
    base = `${res.type}-${at}${FALLBACK_EXT[kind]}`;
  } else if (!extname(base)) {
    base += FALLBACK_EXT[kind];
  }
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  return { path: join(dir, `${stamp}-${base}`), name: base };
}
