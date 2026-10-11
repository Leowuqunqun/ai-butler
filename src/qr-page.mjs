/**
 * 扫码页 —— 一个会自动换码的本地网页。
 *
 * 为什么需要它：iLink 的登录二维码**只活约 90 秒**。如果把二维码打印成文件或
 * 贴进聊天窗口，等你翻到手机再扫，八成已经过期了。
 *
 * 所以正确做法是：把"当前有效的码"放在一个会自动刷新的页面上。
 * 后台不停换新码，页面只在码真的换了才重新加载图片（用 updatedAt 判断），
 * 于是你可以在页面上从容地扫，扫不到会自动换下一张。
 *
 * 页面只监听 127.0.0.1，不对外暴露。
 */

import { createServer } from 'node:http';

export class QrPage {
  /** @param {{port?: number, log?: (s: string) => void}} [opts] */
  constructor(opts = {}) {
    this.port = opts.port ?? 8099;
    this.log = opts.log ?? (() => {});
    this.state = {
      status: 'wait',
      updatedAt: 0,
      expiresAt: 0,
      done: false,
      error: null,
      cycle: 0,
      accountId: '',
    };
    this._content = '';
    this._png = null;
    this._pngFor = '';
    this._server = null;
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 换了一张新码 */
  update({ content, cycle, ttlMs = 90_000 }) {
    this._content = content;
    this._png = null;
    this._pngFor = '';
    this.state = {
      ...this.state,
      status: 'wait',
      updatedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      cycle: cycle ?? this.state.cycle + 1,
      error: null,
    };
  }

  setStatus(status) {
    // 同一个状态不重复写 updatedAt，免得页面白刷
    if (this.state.status === status) return;
    this.state = { ...this.state, status };
  }

  finish({ accountId = '' } = {}) {
    this.state = { ...this.state, done: true, status: 'confirmed', accountId, updatedAt: Date.now() };
  }

  fail(message) {
    this.state = { ...this.state, error: String(message), done: false, updatedAt: Date.now() };
  }

  /** 启动页面；端口被占会自动往后试几个 */
  async start({ maxTries = 12 } = {}) {
    const html = renderHtml();
    for (let i = 0; i < maxTries; i++) {
      const port = this.port + i;
      try {
        await this._listen(port, html);
        this.port = port;
        return this.url;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(`端口 ${this.port}~${this.port + maxTries - 1} 都被占用，起不了扫码页`);
  }

  _listen(port, html) {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const path = (req.url || '/').split('?')[0];
        try {
          if (path === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          } else if (path === '/qr.png') {
            const png = await this._renderPng();
            res.writeHead(200, {
              'Content-Type': 'image/png',
              'Cache-Control': 'no-store',
              'Content-Length': png.length,
            });
            res.end(png);
          } else if (path === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ ...this.state, port: this.port }));
          } else {
            res.writeHead(404);
            res.end('not found');
          }
        } catch (e) {
          res.writeHead(500);
          res.end(String(e?.message ?? e));
        }
      });
      server.on('error', (e) => {
        server.removeAllListeners();
        reject(e);
      });
      server.listen(port, '127.0.0.1', () => {
        this._server = server;
        resolve();
      });
    });
  }

  async _renderPng() {
    if (this._png && this._pngFor === this._content) return this._png;
    if (!this._content) throw new Error('还没有二维码');
    const { default: QRCode } = await import('qrcode');
    this._png = await QRCode.toBuffer(this._content, { width: 460, margin: 2 });
    this._pngFor = this._content;
    return this._png;
  }

  async stop() {
    const s = this._server;
    this._server = null;
    if (!s) return;
    await new Promise((r) => s.close(() => r()));
  }
}

const STATUS_TEXT = {
  wait: '等待扫码',
  scaned: '已扫码，请在手机上确认',
  confirmed: '✅ 已确认',
  expired: '二维码已过期，正在换新的…',
};

function renderHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信 Agent 桥 · 扫码登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 16px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #f5f5f7; color: #1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #f5f5f7; } }
  .card { background: #fff; border-radius: 18px; padding: 32px 36px; text-align: center;
          box-shadow: 0 8px 40px rgba(0,0,0,.08); max-width: 420px; }
  @media (prefers-color-scheme: dark) { .card { background: #2c2c2e; box-shadow: none; } }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 13px; opacity: .6; margin-bottom: 20px; }
  .qr { width: 300px; height: 300px; border-radius: 12px; background: #fff; padding: 8px;
        box-sizing: border-box; object-fit: contain; }
  .qr.dim { opacity: .25; }
  .status { margin-top: 18px; font-size: 15px; min-height: 24px; font-weight: 500; }
  .timer { font-size: 13px; opacity: .55; margin-top: 4px; min-height: 18px; }
  .err { margin-top: 14px; font-size: 13px; color: #d70015; word-break: break-all; }
  .ok { color: #34c759; }
  .steps { text-align: left; margin: 22px auto 0; font-size: 13px; opacity: .75; max-width: 300px; }
  .steps li { margin: 6px 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>微信 Agent 桥</h1>
    <div class="sub">用手机微信扫下面这张码</div>
    <img id="qr" class="qr" alt="登录二维码">
    <div class="status" id="status">正在获取二维码…</div>
    <div class="timer" id="timer"></div>
    <div class="err" id="err"></div>
    <ol class="steps">
      <li>微信 → 右上角 + → 扫一扫</li>
      <li>扫完在手机上点确认</li>
      <li>码过期会自动换新的，不用刷新页面</li>
    </ol>
  </div>
<script>
(function () {
  var img = document.getElementById('qr');
  var statusEl = document.getElementById('status');
  var timerEl = document.getElementById('timer');
  var errEl = document.getElementById('err');
  var TEXT = ${JSON.stringify(STATUS_TEXT)};
  var shownAt = -1;
  var expiresAt = 0;
  var done = false;

  function tick() {
    if (done || !expiresAt) { timerEl.textContent = ''; return; }
    var left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    timerEl.textContent = left > 0 ? ('本张码还剩 ' + left + ' 秒') : '正在换新的码…';
  }
  setInterval(tick, 500);

  function poll() {
    fetch('/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.updatedAt !== shownAt) {
          shownAt = s.updatedAt;
          img.src = '/qr.png?t=' + s.updatedAt;
          img.classList.remove('dim');
        }
        expiresAt = s.expiresAt || 0;
        statusEl.textContent = TEXT[s.status] || s.status || '';
        statusEl.className = 'status' + (s.status === 'confirmed' ? ' ok' : '');
        errEl.textContent = s.error || '';
        if (s.done) {
          done = true;
          img.classList.add('dim');
          timerEl.textContent = '';
          statusEl.textContent = '✅ 绑定成功' + (s.accountId ? '（' + s.accountId + '）' : '');
          statusEl.className = 'status ok';
          return; // 停止轮询
        }
      })
      .catch(function () { /* 服务重启中，下一轮再来 */ });
  }
  var h = setInterval(function () { if (done) clearInterval(h); else poll(); }, 2000);
  poll();
})();
</script>
</body>
</html>`;
}
