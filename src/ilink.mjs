/**
 * iLink Bot API 客户端 —— 腾讯个人微信号的 bot 通道。
 *
 * 反向整理自两个参考实现的行为：
 *   · @tencent-weixin/openclaw-weixin（腾讯官方）
 *   · @shgroup/dsh-serenity-hooks（宁静号 ACC）
 * 以及本项目实测踩出来的若干坑（见 docs/protocol.md）。
 *
 * 本文件**不读配置、不写磁盘**，只做协议。状态（token / 游标）由调用方保管。
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

const APP_ID = 'bot';
/** 客户端版本，wire 上是 (major<<16)|(minor<<8)|patch */
const CLIENT_VERSION = (2 << 16) | (1 << 8) | 1;

/** iLink 协议里的消息 item 类型 */
export const ItemType = {
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
  TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12,
};
/** 发送方类型：1 = 用户，2 = bot。收信时过滤 message_type === 1 */
export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** iLink 要求上传的 filesize 是 16 字节对齐后的长度 */
const padTo16 = (n) => Math.ceil(n / 16) * 16;
const withSlash = (u) => (u.endsWith('/') ? u : `${u}/`);

export class IlinkError extends Error {}

export class IlinkClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]
   * @param {string} [opts.botToken]
   * @param {string} [opts.ilinkUserId]
   * @param {string} [opts.botType] 二维码类型，实测 3 可用
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || ILINK_BASE;
    this.botToken = opts.botToken || '';
    this.ilinkUserId = opts.ilinkUserId || '';
    this.botType = opts.botType || '3';
    this.log = opts.log || (() => {});
  }

  /** 用登录结果替换凭据 */
  setCredentials({ baseUrl, botToken, ilinkUserId }) {
    if (baseUrl) this.baseUrl = baseUrl;
    if (botToken) this.botToken = botToken;
    if (ilinkUserId !== undefined) this.ilinkUserId = ilinkUserId;
    return this;
  }

  toJSON() {
    return { baseUrl: this.baseUrl, botToken: this.botToken, ilinkUserId: this.ilinkUserId };
  }

  // ───────────────────────── HTTP 底座 ─────────────────────────

  /** 每请求随机的防重放头：uint32 → base64 */
  #uin() {
    return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64');
  }

  #headers(auth) {
    const h = {
      'iLink-App-Id': APP_ID,
      'iLink-App-ClientVersion': String(CLIENT_VERSION),
    };
    if (auth) {
      h['Content-Type'] = 'application/json';
      h.AuthorizationType = 'ilink_bot_token';
      h['X-WECHAT-UIN'] = this.#uin();
      if (this.botToken) h.Authorization = `Bearer ${this.botToken}`;
    }
    return h;
  }

  async #request(method, endpoint, { body, auth = true, baseUrl, timeoutMs = 20_000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(endpoint, withSlash(baseUrl || this.baseUrl)), {
        method,
        headers: this.#headers(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new IlinkError(`${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(endpoint, opts) {
    return JSON.parse(await this.#request('GET', endpoint, { ...opts, auth: opts?.auth ?? false }));
  }

  async post(endpoint, body, opts) {
    return this.#request('POST', endpoint, { ...opts, body });
  }

  /** 发一个 POST 并校验 iLink 的业务返回码 */
  async postOk(endpoint, body, opts) {
    const raw = await this.post(endpoint, body, opts);
    assertIlinkOk(endpoint, raw);
    return raw;
  }

  // ───────────────────────── 登录 ─────────────────────────

  /** 取一张登录二维码。**不需要任何凭据。** */
  async fetchQrCode(botType = this.botType) {
    const r = await this.get(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`);
    if (!r?.qrcode || !r?.qrcode_img_content) {
      throw new IlinkError(`取码失败: ${JSON.stringify(r).slice(0, 300)}`);
    }
    return r;
  }

  /**
   * 查询扫码状态。
   * @returns {Promise<{status: 'wait'|'scaned'|'confirmed'|'expired'|string, bot_token?: string, baseurl?: string, ilink_user_id?: string}>}
   */
  async pollQrStatus(qrcode, { timeoutMs = 20_000 } = {}) {
    return this.get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, { timeoutMs });
  }

  /**
   * 完整登录流程，**自动换码**。
   *
   * 为什么必须自动换码：单张二维码只活约 **90 秒**（实测；文档里说的 5 分钟不准）。
   * 把二维码贴进聊天窗口让人去扫，必然过期——所以正确做法是让调用方把
   * "当前有效的码"在一个能自动刷新的界面上呈现（见 qr-page.mjs），
   * 这个函数负责在后台不停换新码。
   *
   * @param {object} opts
   * @param {(info: {qrcode: string, content: string, cycle: number}) => void} [opts.onQr] 每换一张码回调一次
   * @param {(status: string) => void} [opts.onStatus]
   * @param {number} [opts.timeoutMs] 总预算，默认 12 分钟
   * @param {number} [opts.qrTtlMs] 单张码给人扫的窗口，默认 85 秒
   * @param {() => boolean} [opts.shouldStop]
   * @returns {Promise<{baseUrl: string, botToken: string, ilinkUserId: string, qrcode: string}>}
   */
  async login({ onQr, onStatus, timeoutMs = 12 * 60 * 1000, qrTtlMs = 85_000, shouldStop } = {}) {
    const deadline = Date.now() + timeoutMs;
    let cycle = 0;

    while (Date.now() < deadline) {
      if (shouldStop?.()) throw new IlinkError('登录已被取消');
      cycle += 1;

      const qr = await this.fetchQrCode();
      onQr?.({ qrcode: qr.qrcode, content: qr.qrcode_img_content, cycle });

      const qrDeadline = Date.now() + qrTtlMs;
      while (Date.now() < qrDeadline && Date.now() < deadline) {
        if (shouldStop?.()) throw new IlinkError('登录已被取消');
        await sleep(2000);
        let st;
        try {
          st = await this.pollQrStatus(qr.qrcode, { timeoutMs: 30_000 });
        } catch {
          continue; // 单次查询失败不致命，等下一轮
        }
        onStatus?.(st.status);

        if (st.status === 'confirmed') {
          if (!st.bot_token) throw new IlinkError('已确认但没拿到 bot_token');
          const creds = {
            baseUrl: st.baseurl || ILINK_BASE,
            botToken: st.bot_token,
            ilinkUserId: st.ilink_user_id ?? '',
            qrcode: qr.qrcode,
          };
          this.setCredentials(creds);
          return creds;
        }
        if (st.status === 'expired') break; // 换下一张
      }
    }
    throw new IlinkError(`登录超时（${Math.round(timeoutMs / 60000)} 分钟无人确认）`);
  }

  // ───────────────────────── 收信 ─────────────────────────

  /**
   * 长轮询收消息。服务端会 hold 住约 35 秒；**游标必须原样带回去**，
   * 否则会重复消费或漏消息。
   * @param {string} buf 上次返回的 get_updates_buf
   * @param {object} [opts]
   * @returns {Promise<{ret?: number, errcode?: number, msgs?: any[], get_updates_buf?: string}>}
   */
  async getUpdates(buf = '', { timeoutMs = 40_000 } = {}) {
    const raw = await this.post('ilink/bot/getupdates', { get_updates_buf: buf }, { timeoutMs });
    const j = JSON.parse(raw);
    assertIlinkOk('ilink/bot/getupdates', raw);
    return j;
  }

  // ───────────────────────── 发文本 ─────────────────────────

  /**
   * 发一条文本。超长会自动切成多条并加 (1/N) 前缀。
   * @returns {Promise<number>} 实际发出的条数
   */
  async sendText(toUserId, text, { contextToken, maxChars = 1200 } = {}) {
    const chunks = chunkTextRaw(text, maxChars);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length}) ` : '';
      await this.postOk('ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `wab-${randomBytes(4).toString('hex')}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: ItemType.TEXT, text_item: { text: prefix + chunks[i] } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      }, { timeoutMs: 20_000 });
    }
    return chunks.length;
  }

  // ───────────────────────── 发文件 ─────────────────────────

  /**
   * 发一个本地文件。三步：
   *   ① getuploadurl 拿上传地址（带 md5 / 对齐长度 / 随机 aeskey）
   *   ② 把 AES-128-ECB 加密后的字节 POST 到 CDN，回执里的 encrypt_query_param 是取件凭据
   *   ③ sendmessage 发 FILE item（注意 aes_key 是 base64(hex(aesKey))，不是 base64(aesKey)）
   * @returns {Promise<{fileName: string, size: number}>}
   */
  async sendFile(toUserId, absPath, { contextToken } = {}) {
    let stt;
    try {
      stt = statSync(absPath);
    } catch {
      throw new IlinkError(`文件不存在: ${absPath}`);
    }
    if (!stt.isFile()) throw new IlinkError(`不是普通文件: ${absPath}`);
    if (stt.size > MAX_FILE_BYTES) throw new IlinkError(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB: ${absPath}`);

    const data = readFileSync(absPath);
    const fileName = basename(absPath);
    const rawSize = data.length;
    const rawFileMd5 = createHash('md5').update(data).digest('hex');
    const aesKey = randomBytes(16);
    const aesKeyHex = aesKey.toString('hex');
    const aesKeyB64 = Buffer.from(aesKeyHex, 'utf8').toString('base64');
    const fileKey = `wab-${randomBytes(8).toString('hex')}`;

    const uplRaw = await this.postOk('ilink/bot/getuploadurl', {
      filekey: fileKey,
      media_type: UploadMediaType.FILE,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawFileMd5,
      filesize: padTo16(rawSize),
      aeskey: aesKeyHex,
      no_need_thumb: true,
    }, { timeoutMs: 20_000 });

    const upl = JSON.parse(uplRaw);
    if (!upl.upload_full_url && !upl.upload_param) {
      throw new IlinkError(`getuploadurl 未给上传地址: ${uplRaw.slice(0, 200)}`);
    }
    const uploadUrl = upl.upload_full_url
      || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(upl.upload_param ?? '')}`
        + `&filekey=${encodeURIComponent(upl.filekey ?? fileKey)}`;

    const cipher = createCipheriv('aes-128-ecb', aesKey, null);
    const encBody = Buffer.concat([cipher.update(data), cipher.final()]);
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      body: encBody,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const upText = await upRes.text();
    // 凭据在响应头里；个别情况下在 body 的 JSON 里
    let encryptQueryParam = upRes.headers.get('x-encrypted-param');
    if (!encryptQueryParam) {
      try { encryptQueryParam = JSON.parse(upText).encrypted_query_param ?? null; } catch { /* 不是 JSON */ }
    }
    if (!encryptQueryParam) {
      throw new IlinkError(`CDN 上传未返回取件凭据（HTTP ${upRes.status}）: ${upText.slice(0, 200)}`);
    }

    await this.postOk('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `wab-${randomBytes(4).toString('hex')}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{
          type: ItemType.FILE,
          file_item: {
            media: { encrypt_query_param: encryptQueryParam, aes_key: aesKeyB64, encrypt_type: 1 },
            file_name: fileName,
            md5: rawFileMd5,
            len: String(rawSize),
          },
        }],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
    }, { timeoutMs: 30_000 });

    return { fileName, size: rawSize };
  }

  // ───────────────────────── "正在输入" ─────────────────────────

  /** 取对话配置，只为拿 typing_ticket（sendtyping 的前置）。纯 best-effort。 */
  async typingTicket(contextToken) {
    try {
      const raw = await this.post('ilink/bot/getconfig', {
        ilink_user_id: this.ilinkUserId,
        context_token: contextToken,
      }, { timeoutMs: 10_000 });
      return JSON.parse(raw).typing_ticket ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 发"正在输入"状态。
   * @param {string|null} ticket typingTicket() 的返回
   * @param {number} status 1 = 开始输入，0 = 取消
   */
  async setTyping(ticket, status) {
    if (!ticket) return;
    try {
      await this.post('ilink/bot/sendtyping', {
        ilink_user_id: this.ilinkUserId,
        typing_ticket: ticket,
        status,
      }, { timeoutMs: 8_000 });
    } catch { /* best-effort */ }
  }
}

/**
 * iLink 会用 **HTTP 200 + ret/errcode != 0** 表达失败。
 * 只判状态码会得到"发送成功"的假象——这是这个协议最容易踩的坑。
 * @param {string} endpoint
 * @param {string} raw 原始响应体
 */
export function assertIlinkOk(endpoint, raw) {
  let j;
  try { j = JSON.parse(raw); } catch { return; }
  const detail = j.errmsg ? `: ${j.errmsg}` : '';
  if (typeof j.ret === 'number' && j.ret !== 0) throw new IlinkError(`${endpoint} ret=${j.ret}${detail}`);
  if (typeof j.errcode === 'number' && j.errcode !== 0) throw new IlinkError(`${endpoint} errcode=${j.errcode}${detail}`);
}

// 只在协议层内部用到的最小切块（对外请用 text.mjs 的 chunkText）
function chunkTextRaw(text, limit) {
  const s = String(text);
  if (s.length <= limit) return [s];
  const out = [];
  let rest = s;
  while (rest.length > limit) {
    const w = rest.slice(0, limit);
    let cut = Math.max(w.lastIndexOf('\n\n'), w.lastIndexOf('\n'));
    if (cut < limit * 0.5) cut = w.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out.filter((x) => x.length);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
