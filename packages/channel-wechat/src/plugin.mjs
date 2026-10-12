/**
 * 微信通道的 **cordis 插件入口** —— 实现 `ctx.channel`。
 *
 * ── 跟 `bridge.mjs` 什么关系 ────────────────────────────────────
 *
 * `bridge.mjs` 是个**单体**：收信 → 跑 agent → 回话，全在一个类里。
 * 这个文件是它的**拆分版**：只保留"收信 + 发信"，跑 agent 交给核心层。
 *
 *     bridge.mjs（CLI 用，今天就能跑）:  收 → [agent] → 回
 *     本文件（cordis 用）:                收 → emitMessage → （核心层跑 agent）→ sendText
 *
 * 两个入口**共用底下同一批模块**（ilink / media / text / store），
 * 所以协议实现只有一份，不存在两套逻辑各自演化。
 *
 * ── 一条重要的设计线：附件下载发生在通道里，但不在收信循环里 ──
 *
 * seam 的契约要求"交出去的附件已经是本机文件"。而下载是慢操作（微信要两步：
 * 取密文 + AES 解密），放在长轮询循环里会让通道**掉线**。
 * 所以这里保留了两段式：
 *
 *     长轮询循环 ──(只做归一化，很快)──> pending 队列 ──> 下载 worker ──> emitMessage
 *                                                                          ↑
 *                                                              到这里附件已经是本机路径了
 *
 * 再往后的 agent 活干多久，都跟通道无关。
 *
 * ── 访问控制 ───────────────────────────────────────────────────
 *
 * 这个插件**不是**权限门。`allowFrom` 只是个粗筛（默认空 = 不筛），
 * 真正的门在核心层（谁能让这台电脑干活）。**没接核心层之前，
 * 不要把暴露出来的通道当成安全的东西用。**
 *
 * @module wechat-agent-bridge/plugin
 */

import z from '@deepseek-ai/schemastery';
import { ChannelService } from '@butler/seam-channel';

import { ILINK_BASE, IlinkClient, MessageType, TypingStatus } from './ilink.mjs';
import {
  MAX_MEDIA_BYTES,
  describeItem,
  fetchMedia,
  mediaKindOf,
  originalNameOf,
  pickMediaItem,
  saveInbound,
} from './media.mjs';
import { contextTokenOf, extractQuote, extractText, quoteLine } from './text.mjs';
import { Store } from './store.mjs';
import { QrPage } from './qr-page.mjs';
import { LOGIN_TIMEOUT_MS, browserOpener, loginWithQrPage } from './login.mjs';
import { accessSync, constants, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** 长轮询一次最多挂多久（毫秒）。微信服务端大约 35s 会回一次空 */
const POLL_TIMEOUT_MS = 40_000;
/** 收信出错后的退避上限 */
const MAX_BACKOFF_MS = 60_000;

export class WechatChannel extends ChannelService {
  static Config = z.object({
    /** 数据目录：token / 游标 / 收件箱都在它的 state/ 下。空 = 当前工作目录 */
    home: z.string().default(''),
    /** 服务端地址，一般不用改 */
    baseUrl: z.string().default(ILINK_BASE),
    /** 粗筛：只服务这些 userId。**空数组 = 不筛（默认）**，真正的权限门在核心层 */
    allowFrom: z.array(z.string()).default([]),
    /** 发"正在输入"。best-effort */
    typing: z.boolean().default(true),
    /** 收到图片/文件时下载并落盘 */
    mediaEnabled: z.boolean().default(true),
    /** CDN 地址，一般不用改（服务端返回 baseurl 时会覆盖） */
    cdnBaseUrl: z.string().default(''),
    /** 单个附件上限。100MB 是协议上限 */
    maxMediaBytes: z.number().default(MAX_MEDIA_BYTES),
    /** 单条回复的字符上限，超出由通道分条 */
    replyChars: z.number().default(1200),
    /**
     * 没有登录态时，**自己起扫码页等着扫**（默认开）。
     *
     * 关掉它就退回老行为：直接报错，让人去跑 `wechat-agent-bridge qr`。
     * 关它的场合是没有浏览器的地方（服务器、CI）。
     */
    qrPage: z.boolean().default(true),
    /** 扫码页监听的端口。**只监听 127.0.0.1**；被占用会自动往后找一个 */
    qrPort: z.number().default(8099),
    /** 等人扫码最多等多久 */
    loginTimeoutMs: z.number().default(LOGIN_TIMEOUT_MS),
  });

  /** @type {string} */
  id = 'wechat';

  // ───────────────────────── 构造 ─────────────────────────

  constructor(ctx, config) {
    super(ctx);
    this.config = config;

    const home = config.home || process.cwd();
    // ⚠️ Store 的构造函数会**建目录**，所以"目录用不了"是在这里炸的，
    // 而不是在 start() 里。原生错误长这样：
    //     EACCES: permission denied, mkdir '/x/state'
    // 用户看不懂，也不知道该动哪里。所以这里翻译成一句人话再抛 ——
    // 它会被 boot() 收成 failures，最后由 doctor 原样打给用户看。
    try {
      this.store = new Store(home);
    } catch (cause) {
      // 分工：**日志留原文，用户看到的是人话。**
      // 原生错误（`EACCES: permission denied, mkdir '/x/state'`）里有排查需要的
      // 全部信息，但对用户是噪音 —— 它甚至提到一个他从没配过的路径。
      // 所以原文进日志，抛出去的那句只说"哪儿不对、该怎么办"。
      ctx.logger?.info?.(`[wechat] 数据目录不可用 home=${home}：${cause?.message ?? cause}`);
      throw new Error(
        `数据目录用不了：${home}。`
        + '这里是放微信登录态和收件的地方，得是一个能写的目录 —— '
        + '把它建出来，或者在配置里把 home 指到别处。',
      );
    }
    this.log = (m) => ctx.logger?.info?.(`[wechat] ${m}`);

    /** @type {object[]} 已归一化、等待附件落地的消息 */
    this.pending = [];
    /** @type {(() => void) | null} 用来叫醒退避中的收信循环 */
    this.wake = null;
    this.stopping = false;
    this.started = false;
    /** @type {Map<string, string>} contextToken → typing_ticket */
    this.tickets = new Map();

    this.ilink = this.createIlink();

    // 收尾一律走 effect（cordis 4 没有 'dispose' 事件）
    ctx.effect(() => () => this.stop(), 'wechat.stop');
  }

  /**
   * 造协议客户端。**单独一个方法是为了测试能换掉它** ——
   * 测试里子类重写这个方法返回一个假的 ilink，就能全离线跑完收发。
   */
  createIlink() {
    const token = this.store.readToken();
    return new IlinkClient({
      baseUrl: this.config.baseUrl || token?.baseUrl || ILINK_BASE,
      botToken: token?.botToken ?? '',
      ilinkUserId: token?.ilinkUserId ?? '',
      log: this.log,
    });
  }

  /**
   * 第一次启动时把登录做完：起扫码页 → 打开浏览器 → 等扫码 → 落盘。
   *
   * 细节都在 `login.mjs` 里（那边能离线测）。这里只负责把**真的**页面和
   * **真的**客户端接上去。
   */
  async login() {
    if (!this.config.qrPage) {
      throw new Error(
        `微信还没登录（${this.store.paths.token} 里没有 botToken）。`
        + '这份配置关掉了扫码页（qrPage=false），先在命令行跑一次扫码登录：'
        + ' wechat-agent-bridge qr',
      );
    }

    const page = new QrPage({ port: this.config.qrPort, log: this.log });

    return loginWithQrPage({
      // 走 createIlink() 那一道缝：测试就是靠重写它把真客户端换成假的
      client: this.ilink,
      store: this.store,
      page,
      log: this.log,
      open: (url) => this.openBrowser(url),
      shouldStop: () => this.stopping,
      timeoutMs: this.config.loginTimeoutMs,
    });
  }

  /** 打开浏览器给用户扫码。**子类/测试可以重写**（测试里不该真弹一个窗口出来） */
  openBrowser(url) {
    browserOpener()(url);
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  async start() {
    if (this.started) return;                    // 幂等：重复 start 不该起两个循环

    // 没登录就**在这儿登录**，而不是让用户去敲另一条命令。
    // 对一个不懂技术的人来说，"去跑 xxx qr"就是终点：那条命令的名字他猜不出来。
    if (!this.store.readToken()?.botToken) await this.login();

    this.stopping = false;
    this.started = true;
    /** 用来立刻掐断挂着的长轮询 —— 停机不该干等 40 秒 */
    this.abort = new AbortController();
    this.log(`开始收信（state=${this.store.dir}）`);
    // 不 await：两个循环都是长驻的
    this.poller = this.pollLoop(this.abort.signal).catch((e) => this.log(`收信循环挂了: ${e.message}`));
    this.worker = this.downloadLoop().catch((e) => this.log(`下载循环挂了: ${e.message}`));
  }

  async stop() {
    // ⚠️ 先置位再判断：登录过程也属于"启动中"，用户这时按 Ctrl-C 也得停得下来。
    // 顺序反了的话，扫码页会一直挂到超时（12 分钟），而他以为已经退出了。
    this.stopping = true;
    if (!this.started) return;
    this.started = false;
    this.abort?.abort();      // 掐断在飞的长轮询，否则这里要等满 POLL_TIMEOUT_MS
    this.wake?.();            // 叫醒退避中的等待
    this.wakePending?.();     // 叫醒空转的下载循环
    await Promise.allSettled([this.poller, this.worker]);
    this.log('已停止收信');
  }

  // ───────────────────────── 收信 ─────────────────────────

  async pollLoop(signal) {
    let buf = this.store.readCursor();
    let backoff = 1000;

    while (!this.stopping) {
      let r;
      try {
        r = await this.ilink.getUpdates(buf, { timeoutMs: POLL_TIMEOUT_MS, signal });
      } catch (e) {
        if (this.stopping) break;               // 是我们自己掐断的，不是故障
        // 长轮询超时是正常的；真错误就退避重试，别把循环打死
        this.log(`收信失败（${Math.round(backoff / 1000)}s 后重试）: ${e.message}`);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      backoff = 1000;

      if (r.get_updates_buf) {
        buf = r.get_updates_buf;
        this.store.writeCursor(buf);
      }

      for (const msg of r.msgs ?? []) {
        if (msg?.message_type !== MessageType.USER) continue;   // 只收用户发的
        this.enqueue(msg);
      }
    }
  }

  /**
   * 归一化一条来信，塞进待下载队列。
   *
   * **这里只挑媒体、不下载** —— 下载放到 worker，见文件头部的说明。
   */
  enqueue(msg) {
    const fromId = msg.from_user_id;
    const text = extractText(msg);
    const media = this.config.mediaEnabled === false ? null : pickMediaItem(msg.item_list);

    if (this.config.allowFrom?.length && !this.config.allowFrom.includes(fromId)) {
      this.log(`忽略不在 allowFrom 里的来信 from=${fromId}`);
      return;
    }

    // 用户引用的那句话单独带着走：它要交给 agent 当上下文，但**不能进 text**
    // （否则引用里出现 `@某台设备` 会把这条消息错误地路由过去）
    const quote = extractQuote(msg);

    if (!text && !media) {
      // 有媒体项但没凭据（多半过期）vs 压根不认这种类型
      const looksLikeMedia = Array.isArray(msg.item_list)
        && msg.item_list.some((it) => [2, 3, 4, 5].includes(it?.type));

      // **引用本身就是内容**：用户引用某句话、自己没打字（也常见于关了 media 时
      // 引用着一张图），那就把引用交给核心层 —— 不能连他指着的东西一起丢掉。
      if (quote) {
        if (looksLikeMedia) {
          this.receipt(fromId, msg, '这条消息里的图片/文件没能取到（凭据过期，或本机关了 media），先按你引用的那句办');
        }
        this.pending.push({
          fromId,
          text: undefined,
          quote,
          media: null,
          contextToken: contextTokenOf(msg),
          at: Date.now(),
        });
        this.wakePending?.();
        return;
      }

      // 没有正文、没有附件、也没有引用 —— 这条确实读不了，如实说
      this.receipt(fromId, msg, looksLikeMedia
        ? '这条消息里的图片/文件没有可下载的凭据（也可能已过期），读不了'
        : '这条消息里没有我能读的内容（文字、语音转文字、图片、文件都没有）');
      return;
    }

    this.pending.push({
      fromId,
      text,
      quote,
      media,
      contextToken: contextTokenOf(msg),
      at: Date.now(),
    });
    this.wakePending?.();
  }

  /**
   * 协议层的礼貌回执（"这条读不了"这类）。
   *
   * 它不是对话回合 —— 核心层/agent 都不该知道有这回事，所以通道自己回。
   */
  receipt(fromId, msg, why) {
    this.ilink
      .sendText(fromId, `（${why}）`, { contextToken: contextTokenOf(msg) })
      .catch((e) => this.log(`回执发送失败: ${e.message}`));
  }

  /** 下载 worker：把附件落成本机文件，然后交给核心层 */
  async downloadLoop() {
    while (!this.stopping || this.pending.length) {
      const item = this.pending.shift();
      if (!item) {
        await this.waitForPending();
        continue;
      }

      let files;
      try {
        const saved = item.media ? await this.fetchInbound(item.media) : null;
        files = saved ? [saved] : undefined;
      } catch (e) {
        // 附件坏了不该把整条消息吞掉：仍然把文字交出去，并且如实说附件没拿到
        this.log(`附件下载失败（文字仍会照常处理）: ${e.message}`);
        files = undefined;
        item.text = [item.text, `（附件没能取到：${e.message}）`].filter(Boolean).join('\n');
      }

      /** @type {import('@butler/seam-channel').InboundMessage} */
      const inbound = {
        channel: this.id,
        fromId: item.fromId,
        text: item.text ?? undefined,
        quote: item.quote,
        files,
        contextToken: item.contextToken,
      };
      try {
        this.emitMessage(inbound);
      } catch (e) {
        this.log(`交给核心层失败: ${e.message}`);
      }
    }
  }

  /** 取回一个附件并落进收件箱（**这是通道自己的事，核心层不该看见这一步**） */
  async fetchInbound(sel) {
    const cfg = this.config;
    const buf = await fetchMedia(sel, {
      cdnBaseUrl: cfg.cdnBaseUrl || undefined,
      maxBytes: cfg.maxMediaBytes,
    });
    const saved = saveInbound(buf, {
      dir: this.store.paths.inbox,
      fileName: originalNameOf(sel),
      kind: sel.kind,
    });
    this.log(`📥 收到${describeItem(sel)} → ${saved.path}（${saved.size} 字节）`);
    return saved;
  }

  // ───────────────────────── 发信 ─────────────────────────

  async sendText(to, text, opts = {}) {
    // "在回哪句"由**通道**显示成什么样 —— 这是通道的事，不是内核的。
    //
    // 微信协议没有引用回复字段，所以只能把原话截一段顶在文本前面。
    // 前缀进 `maxChars` 的分条计算：截断前和截断后加起来不该超上限。
    const head = opts.quote ? quoteLine(opts.quote) : '';
    const chunks = await this.ilink.sendText(to, head + text, {
      contextToken: opts.contextToken,
      maxChars: opts.maxChars ?? this.config.replyChars,
    });
    return { chunks };
  }

  async sendFile(to, path, opts = {}) {
    // ⚠️ `opts.quote` 在这里**用不上**：iLink 发文件没有"引用某条消息"这个能力
    // （协议里连消息 id 都没有）。所以文件本身挂不了引用 —— 内核照样会传，
    // 由这里如实忽略，而不是假装支持。
    //
    // 图片 / 视频 / 文件：**跟 Telegram 一条规矩** —— 由通道按文件名定，内核不掺和。
    // （内核只管说"把这个发给他"，至于对面看到的是图片、视频还是一个附件，
    //   那是通道最清楚的事。）
    const r = await this.ilink.sendFile(to, path, {
      contextToken: opts.contextToken,
      kind: mediaKindOf(path),
    });
    return { fileName: r.fileName, size: r.size };
  }

  /**
   * 自检 —— **只查前置条件，不连网**。
   *
   * 这里刻意不去调 ilink 验登录态还灵不灵：自检可能被反复跑（用户每遇到一次
   * "没反应"就会跑一次），不该产生任何网络副作用。token 在不在足够判断
   * "要不要重新扫码"了 —— 真过期的话 start() 会自己走重新登录。
   */
  check() {
    const out = [];
    const home = this.config.home || process.cwd();

    out.push(checkDir('数据目录', home, '放登录态、会话、收件的地方'));

    const token = this.store.readToken();
    if (token?.botToken) {
      // ⚠️ 时间字段有两个来源：cordis 版的 Store 写 `savedAt`，早期单体版
      // 写的是 `confirmedAt`。拿真数据验的时候发现的 —— 只认 savedAt 的话，
      // 老账号迁移过来会一直显示"时间未知"。
      const at = token.savedAt ?? token.confirmedAt;
      const when = at ? new Date(at).toLocaleString('zh-CN') : '（时间未知）';
      // ⚠️ 这里只敢说"存过"：token 文件在，不等于**现在**还有效 —— 那得真连一次
      // 服务端才知道，而自检是在回消息的过程中跑的（一个长轮询 40 秒起）。
      // 说成"已登录"是一句主人既没法核实、也没法反驳的假绿：真掉线了，
      // 报告还是绿的，而他手上的现象是"发消息没反应"。
      out.push({
        name: '微信登录态',
        ok: true,
        detail: `登录态存过（${when} 扫的码）—— 这只说明存过，说明不了现在还有效；`
          + '真掉线了，重启一次它会让你重新扫码',
      });
    } else {
      out.push({
        name: '微信登录态',
        ok: false,
        // 说清**找的是哪个文件** —— 这是"我明明登录过啊"这类问题的唯一线索。
        // 数据根目录指错一层（比如把 home 指到了 state/ 里），表现就是这句，
        // 而用户从"还没登录"这四个字里完全看不出问题在哪。
        detail: `还没登录过这台机器（找的是 ${this.store.paths.token}）`,
        fix: '启动时会自动打开一个扫码页，用微信扫一下就好',
      });
    }

    return out;
  }

  async setTyping(to, on, opts = {}) {
    if (!this.config.typing) return;
    try {
      const key = opts.contextToken ?? '';
      let ticket = this.tickets.get(key);
      if (!ticket) {
        ticket = await this.ilink.typingTicket(key);
        if (ticket) this.tickets.set(key, ticket);
      }
      // 取消必须用 CANCEL(2)：写 0 是静默无操作（实测）
      if (ticket) await this.ilink.setTyping(ticket, on ? TypingStatus.TYPING : TypingStatus.CANCEL);
    } catch (e) {
      // best-effort：拿不到票据就算了，绝不能因为"正在输入"失败影响真正的回复
      this.log(`正在输入发送失败（忽略）: ${e.message}`);
    }
  }

  // ───────────────────────── 内部 ─────────────────────────

  sleep(ms) {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      this.wake = () => { clearTimeout(t); r(); };
    }).finally(() => { this.wake = null; });
  }

  waitForPending() {
    return new Promise((r) => { this.wakePending = () => { this.wakePending = null; r(); }; });
  }
}

export default WechatChannel;

/** 目录在不在、能不能写。给用户的话里要说清这个目录是干什么的 */
function checkDir(name, dir, what) {
  const abs = isAbsolute(dir) ? dir : join(process.cwd(), dir);
  if (!existsSync(abs)) {
    return { name, ok: false, detail: `${abs} 不存在`, fix: `建一下这个目录（${what}），或者把配置里的 home 指到别处` };
  }
  try {
    accessSync(abs, constants.W_OK);
  } catch {
    return { name, ok: false, detail: `${abs} 写不进去`, fix: '检查一下目录权限' };
  }
  return { name, ok: true, detail: abs };
}
