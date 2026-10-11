/**
 * 桥的编排层：收信 → 排队 → 串行交给 agent → 回话（文本 + 附件）。
 *
 * 两个循环是分开的，这是**刻意的**：
 *
 *   poller（收）── 从不被 agent 阻塞，一直喂队列，所以你在 agent 忙的时候照样能发
 *   worker（干）── 严格串行，一条跑完才跑下一条
 *
 * 为什么不用一个循环：早期版本收和干在一个循环里，agent 一旦卡住（等一个永远不会
 * 来的批准、或者自己在死循环里打转），整条桥就"失联"了——用户发什么都没反应，
 * 也拿不到任何解释。分开之后至少能立刻回一句"收到，前面还有 N 条"。
 */

import { extractFileMarkers, extractText, quoteLine } from './text.mjs';
import { MessageType } from './ilink.mjs';

export class Bridge {
  /**
   * @param {object} o
   * @param {string} o.root 项目根目录
   * @param {import('./store.mjs').Store} o.store
   * @param {object} o.config
   * @param {import('./ilink.mjs').IlinkClient} o.ilink
   * @param {{name: string, run: Function}} o.backend
   * @param {(line: string) => void} [o.log]
   */
  constructor({ root, store, config, ilink, backend, log }) {
    this.root = root;
    this.store = store;
    this.cfg = config;
    this.ilink = ilink;
    this.backend = backend;
    this.log = log ?? ((s) => console.log(s));
    this.queue = [];
    this.stopping = false;
    this._workerRunning = false;
    this._sleeping = null;
  }

  get allowFrom() {
    return this.cfg.allowFrom ?? [];
  }

  // ───────────────────────── 生命周期 ─────────────────────────

  start() {
    this.stopping = false;
    // 不 await：两个循环都是长驻的
    this._pollerPromise = this._pollLoop().catch((e) => this.log(`收信循环挂了: ${e.message}`));
    this._workerPromise = this._workLoop().catch((e) => this.log(`干活循环挂了: ${e.message}`));
    return this;
  }

  async stop() {
    this.stopping = true;
    if (this._sleeping) this._sleeping();
    await Promise.allSettled([this._pollerPromise, this._workerPromise]);
  }

  // ───────────────────────── 收信 ─────────────────────────

  async _pollLoop() {
    let buf = this.store.readCursor();
    let backoff = 1000;

    while (!this.stopping) {
      let r;
      try {
        r = await this.ilink.getUpdates(buf, { timeoutMs: 40_000 });
      } catch (e) {
        // 长轮询超时是正常的；真错误就退避重试，别把循环打死
        this.log(`收信失败（${Math.round(backoff / 1000)}s 后重试）: ${e.message}`);
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      backoff = 1000;

      if (r.get_updates_buf) {
        buf = r.get_updates_buf;
        this.store.writeCursor(buf);
      }

      for (const msg of r.msgs ?? []) {
        if (msg?.message_type !== MessageType.USER) continue; // 只处理用户发的
        this._enqueue(msg);
      }
    }
  }

  _enqueue(msg) {
    const from = msg.from_user_id;
    const text = extractText(msg);

    // 白名单：不是自己人就静默丢弃（不回话，免得变成探测工具）
    if (!this._isAllowed(from)) {
      if (this._maybeBind(from)) {
        // 刚认主，继续往下走
      } else {
        this.log(`忽略非白名单来信 from=${from}`);
        this.store.audit({ dir: 'in', from, text, ignored: true });
        return;
      }
    }

    if (!text) {
      // 目前只处理文本与语音转写；图片/文件/视频会走到这里
      this.store.audit({ dir: 'in', from, text: null, unsupported: true });
      this._reply(from, '这条消息我暂时读不了（目前只认文字和语音转文字）。', msg.context_token).catch(() => {});
      return;
    }

    this.store.audit({ dir: 'in', from, text });

    if (this.queue.length >= this.cfg.maxQueue) {
      this._reply(from, `积压太多了（已经 ${this.queue.length} 条在排队），这条先不接。等前面清完再发。`, msg.context_token)
        .catch(() => {});
      return;
    }

    const ahead = this.queue.length + (this._workerRunning ? 1 : 0);
    this.queue.push({ msg, text, from, contextToken: msg.context_token, at: Date.now() });

    if (ahead > 0 && this.cfg.queueAck) {
      this._reply(from, `收到，前面还有 ${ahead} 条在处理，稍等。`, msg.context_token).catch(() => {});
    }
    this.log(`← ${from}: ${text.slice(0, 80)}${ahead > 0 ? `（排队 ${ahead}）` : ''}`);
  }

  _isAllowed(userId) {
    const list = this.allowFrom;
    return list.length > 0 && list.includes(userId);
  }

  /** allowFrom 为空且开了 bindFirstSender ⇒ 第一条来信把控制权交给它 */
  _maybeBind(userId) {
    if (this.allowFrom.length > 0 || !this.cfg.bindFirstSender || !userId) return false;
    this.cfg.allowFrom = [userId];
    this.store.saveConfig(this.cfg);
    this.log(`🔗 首次来信认主：allowFrom = [${userId}]`);
    return true;
  }

  // ───────────────────────── 干活 ─────────────────────────

  async _workLoop() {
    while (!this.stopping) {
      const job = this.queue.shift();
      if (!job) {
        await this._sleep(300);
        continue;
      }
      this._workerRunning = true;
      try {
        await this._handle(job);
      } catch (e) {
        this.log(`处理来信时崩了: ${e.stack ?? e.message}`);
        this._reply(job.from, `处理这条时出错了：${e.message}`, job.contextToken).catch(() => {});
      } finally {
        this._workerRunning = false;
      }
    }
  }

  async _handle({ from, text, contextToken }) {
    const started = Date.now();
    this.log(`→ 开始处理: ${text.slice(0, 60)}`);

    // 正在输入 + 进度提示
    let typingTicket = null;
    if (this.cfg.typing) {
      typingTicket = await this.ilink.typingTicket(contextToken);
      await this.ilink.setTyping(typingTicket, 1);
    }
    let ticker = null;
    if (this.cfg.progressIntervalMs > 0) {
      ticker = setInterval(() => {
        const secs = Math.round((Date.now() - started) / 1000);
        this._reply(from, `还在处理…（已 ${secs}s）`, contextToken).catch(() => {});
      }, this.cfg.progressIntervalMs);
    }

    try {
      let sessionId = this.store.getSession(from);
      let res = await this._runBackend(text, sessionId, from);

      // 会话被别的进程锁住 → 换一个新会话重试一次，别让用户干等
      if (res.error === 'SESSION_LOCKED') {
        this.log('会话被占用，换新会话重试一次');
        this.store.setSession(from, null);
        res = await this._runBackend(text, null, from);
      }
      if (res.sessionId) this.store.setSession(from, res.sessionId);

      const secs = Math.round((Date.now() - started) / 1000);
      const fallback = `任务中止了（跑了 ${secs}s 没出结果）。可能是中途被掐断或超时——换个说法，或者把事拆小一点再试。`;
      const reply = res.error
        ? `（agent 出错，${secs}s）\n${res.error === 'SESSION_LOCKED' ? '会话被占用，重试也没成功' : res.error}`
        : (res.text?.trim() || fallback);

      const parsed = res.error ? { text: reply, files: [] } : extractFileMarkers(reply);
      const files = parsed.files;

      // 协议没有引用回复，用一行文本把"这是在回哪句"钉在最前面
      const quoted = this.cfg.quoteReply ? quoteLine(text) : '';
      const body = parsed.text ? quoted + parsed.text : '';

      if (quoted && !body && files.length) {
        // 只发附件、没正文时，单独说一句"回的是哪句"，别让附件孤零零的
        await this._reply(from, quoted.trim(), contextToken).catch(() => {});
      }

      this.log(`→ ${from}: ${(parsed.text || '(仅附件)').slice(0, 80)} (${secs}s, session=${res.sessionId ?? '?'})`);

      let chunks = 0;
      if (body) chunks = await this.ilink.sendText(from, body, { contextToken, maxChars: this.cfg.maxReplyChars });

      const sentFiles = [];
      for (const f of files) {
        try {
          if (f.caption) await this.ilink.sendText(from, f.caption, { contextToken, maxChars: this.cfg.maxReplyChars });
          const sent = await this.ilink.sendFile(from, f.path, { contextToken });
          sentFiles.push(sent);
          this.log(`📎 已发送附件 ${sent.fileName}（${sent.size} 字节）`);
        } catch (e) {
          this.log(`📎 发附件失败 ${f.path}: ${e.message}`);
          sentFiles.push({ path: f.path, error: e.message });
          await this._reply(from, `附件发送失败：${f.path}\n${e.message}`, contextToken).catch(() => {});
        }
      }

      this.store.audit({
        dir: 'out', to: from, text: body, chunks, files: sentFiles,
        seconds: secs, sessionId: res.sessionId, error: res.error ?? null,
      });
    } finally {
      if (ticker) clearInterval(ticker);
      if (this.cfg.typing) await this.ilink.setTyping(typingTicket, 0);
    }
  }

  _runBackend(text, sessionId, userId) {
    return Promise.resolve(this.backend.run({
      text,
      sessionId,
      userId,
      config: this.cfg,
      workspace: this.cfg.workspace || this.root,
      log: (m) => this.log(`  [${this.backend.name}] ${m}`),
    }));
  }

  /** 发一条纯文本（内部用，走和正式回复一样的通道） */
  async _reply(to, text, contextToken) {
    return this.ilink.sendText(to, text, { contextToken, maxChars: this.cfg.maxReplyChars });
  }

  async _sleep(ms) {
    await new Promise((r) => {
      const t = setTimeout(r, ms);
      this._sleeping = () => { clearTimeout(t); r(); };
    });
    this._sleeping = null;
  }
}
