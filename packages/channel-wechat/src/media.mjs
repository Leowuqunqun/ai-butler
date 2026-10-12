/**
 * 入站媒体：把微信发来的图片 / 文件从 CDN 取回来并解密。
 *
 * 微信的入站媒体**不是一个 URL，而是一组加密的 CDN 凭据**：
 *
 *     item.image_item.media = { encrypt_query_param, aes_key, full_url? }
 *
 * 要自己拼下载地址、下载密文、再 AES-128-ECB 解密。细节见 docs/protocol.md。
 *
 * ── 两个必须知道的坑（搞错的表现都是"消息收到了，但文件打不开"）────────
 *
 * 1) aes_key 有**两种编码**，而且在真实流量里同时存在：
 *      base64(16 字节原始 key)     ← 图片
 *      base64(32 字符 hex 串)      ← 文件 / 语音 / 视频
 *    判据：base64 解码后长度是 16 就是前者，是 32 且全是 hex 字符就是后者。
 *
 * 2) **图片还有第二个 key 来源**：`image_item.aeskey`（hex 串），
 *    且它优先于 `media.aes_key`。漏掉这个来源，图片就是一坨乱码。
 *
 * 这两条与**出站**那个坑恰好对称：我们发文件时写成 base64(hex(key))。
 */

import { createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** 微信 CDN 默认地址；服务端返回 baseurl 时应以它为准 */
export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** 协议上限 100MB，超过的直接拒收，别把内存撑爆 */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * 媒体项优先级：**能读图的先给 agent 看图**。
 * 顺序与官方参考实现一致（图片 > 视频 > 文件）。
 * 语音不在其中——微信服务端已经给了转写文本，不需要再下载音频。
 */
const MEDIA_PRIORITY = [
  { type: 2, field: 'image_item', kind: 'image' },
  { type: 5, field: 'video_item', kind: 'video' },
  { type: 4, field: 'file_item', kind: 'file' },
];

const KIND_LABEL = { image: '图片', video: '视频', file: '文件' };

/** 扩展名 → MIME。够用就行，不追求全。 */
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
};

/** 类型 → 兜底扩展名（原文件名缺失时用） */
const FALLBACK_EXT = { image: '.jpg', video: '.mp4', file: '.bin' };

/**
 * 解析 aes_key 成 16 字节原始 key。**两种编码都兜**。
 * @param {string} aesKeyBase64
 * @returns {Buffer} 16 字节
 * @throws {Error} 两种编码都对不上时
 */
export function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 ?? ''), 'base64');
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString('ascii');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
    return Buffer.from(ascii, 'hex');
  }
  throw new Error(
    `aes_key 既不是 base64(16 字节) 也不是 base64(32 字符 hex)，解出来是 ${decoded.length} 字节`,
  );
}

/**
 * AES-128-ECB 解密（PKCS7 padding，无 IV）。
 * @param {Buffer} ciphertext
 * @param {Buffer} key 16 字节
 * @returns {Buffer}
 */
export function decryptAesEcb(ciphertext, key) {
  const d = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/**
 * 拼 CDN 下载地址。优先用服务端给的 full_url（见 fetchMedia）。
 * @param {string} encryptedQueryParam
 * @param {string} [cdnBaseUrl]
 * @returns {string}
 */
export function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = DEFAULT_CDN_BASE) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 这一项媒体有没有可下载的凭据 */
function hasCredentials(media) {
  return Boolean(media?.encrypt_query_param || media?.full_url);
}

/**
 * 从 item_list 里挑出**最值得取回来的一个**媒体项。
 * 优先级 图片 > 视频 > 文件；语音刻意跳过（服务端已给转写）。
 * @param {any[]} itemList
 * @returns {{ item: any, field: string, kind: string, media: any } | null}
 */
export function pickMediaItem(itemList) {
  if (!Array.isArray(itemList)) return null;
  for (const { type, field, kind } of MEDIA_PRIORITY) {
    for (const item of itemList) {
      if (item?.type !== type) continue;
      const media = item[field]?.media;
      if (hasCredentials(media)) return { item, field, kind, media };
    }
  }
  return null;
}

/**
 * 取该项媒体的 aes_key（base64 形式，供 parseAesKey 用）。
 *
 * 图片优先用 `image_item.aeskey`（**hex 串**，转成 base64 才能走同一条解析路径），
 * 其余类型用 `media.aes_key`。没有 key 时返回 null（表示明文，直接下）。
 * @param {{ item: any, field: string, kind: string, media: any }} sel
 * @returns {string|null}
 */
export function aesKeyOf(sel) {
  if (sel.kind === 'image') {
    const hex = sel.item?.image_item?.aeskey;
    if (typeof hex === 'string' && hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
      return Buffer.from(hex, 'hex').toString('base64');
    }
  }
  return sel.media?.aes_key ?? null;
}

/** 给用户/日志看的一句话描述，例如「图片」「文件 报表.xlsx」 */
export function describeItem(sel) {
  const label = KIND_LABEL[sel.kind] ?? '媒体';
  const name = originalNameOf(sel);
  return name ? `${label} ${name}` : label;
}

/** 原文件名（只有文件类型有） */
export function originalNameOf(sel) {
  const n = sel.item?.[sel.field]?.file_name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/**
 * 下载 + 解密一项媒体。
 *
 * @param {{ item: any, field: string, kind: string, media: any }} sel
 * @param {object} [o]
 * @param {string} [o.cdnBaseUrl] 服务端给的 baseurl；不传用默认 CDN
 * @param {typeof fetch} [o.fetchImpl] 便于离线测试
 * @param {number} [o.maxBytes] 上限，默认协议上限 100MB
 * @returns {Promise<Buffer>} 明文
 */
export async function fetchMedia(sel, o = {}) {
  const {
    cdnBaseUrl = DEFAULT_CDN_BASE,
    fetchImpl = globalThis.fetch,
    maxBytes = MAX_MEDIA_BYTES,
  } = o;
  const url = sel.media.full_url
    || buildCdnDownloadUrl(sel.media.encrypt_query_param ?? '', cdnBaseUrl);

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`CDN 返回 HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  }
  const raw = Buffer.from(await res.arrayBuffer());
  if (raw.length > maxBytes) {
    throw new Error(`文件太大（${raw.length} 字节，上限 ${maxBytes}）`);
  }

  const keyB64 = aesKeyOf(sel);
  // 没有 key = 明文（官方实现对图片保留了这条分支）
  return keyB64 ? decryptAesEcb(raw, parseAesKey(keyB64)) : raw;
}

/**
 * 把文件名洗成安全的单段名：剥掉目录、去掉 `..`、掐掉超长。
 * **这条是防路径穿越的关键**——用户发来的文件名是不可信输入。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return base
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}

/** 按扩展名猜 MIME；猜不出给个通用值 */
export function guessMime(name) {
  return MIME[extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 这个文件名该当**图片 / 视频 / 文件**发（出站用）。
 *
 * 判据直接用上面那张 MIME 表 —— 不再另立一张扩展名表，免得两张表慢慢长歪
 * （多认一种格式只改一处）。认不出来的一律当普通文件发，这是安全的默认：
 * 当文件发**一定送得到**，当图片/视频发还得看对面认不认这个格式。
 */
export function mediaKindOf(name) {
  const mime = guessMime(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * 落盘到收件箱。文件名 = `<ISO 时间>-<安全原名>`，保证可排序且不撞名。
 * @param {Buffer} buffer
 * @param {object} o
 * @param {string} o.dir 收件箱目录
 * @param {string} [o.fileName] 原文件名
 * @param {string} o.kind image | video | file
 * @param {number} [o.at] 时间戳，便于测试固定
 * @returns {{ path: string, name: string, size: number, mime: string, kind: string }}
 */
export function saveInbound(buffer, { dir, fileName, kind, at = Date.now() }) {
  mkdirSync(dir, { recursive: true });
  let base = sanitizeName(fileName);
  if (!base) base = `${kind}-${at}${FALLBACK_EXT[kind] ?? '.bin'}`;
  else if (!extname(base)) base += FALLBACK_EXT[kind] ?? '.bin';

  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${base}`);
  writeFileSync(path, buffer);
  return { path, name: base, size: buffer.length, mime: guessMime(base), kind };
}

/**
 * 只有媒体、没有文字时，给 agent 一个起步的提示。
 * 不去猜用户的意图，只把事实说清楚。
 * @param {{ kind: string, item: any, field: string }} sel
 * @returns {string}
 */
export function defaultPromptFor(sel) {
  return `（我发来一个${describeItem(sel)}，没有附文字。看看是什么，需要的话告诉我。）`;
}

/**
 * 把本机附件路径拼成一段提示，附在用户的文字后面。
 * 这样**任何后端**（哪怕不认识 files 字段）都能直接读到文件。
 * @param {{ path: string, name: string, mime: string, size: number, kind: string }[]} files
 * @returns {string}
 */
export function filesHint(files) {
  const list = (files ?? []).filter((f) => f?.path);
  if (!list.length) return '';
  const lines = list.map((f) => `- ${f.path}（${f.name}, ${f.mime}, ${f.size} 字节）`);
  return `\n\n（附件已下载到本机，可直接读取：\n${lines.join('\n')}\n）`;
}
