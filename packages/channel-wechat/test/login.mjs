/**
 * 「第一次启动自己登录」的测试 —— **全部离线**。
 *
 *   node --test test/login.mjs
 *
 * 这条路是小白路上最容易断的一截：他刚敲完 `butler run`，如果这里错了，
 * 得到的是一句让他去敲**另一条他猜不出名字的命令**的话。
 *
 * 测法：真起一个本地扫码页（真 HTTP、只监听 127.0.0.1），喂一个假客户端。
 * 于是"码真的进了页面""浏览器真的被指向那个地址""登录态真的落了盘"
 * 全都能验，而**一条网都不用连**。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QrPage } from '../src/qr-page.mjs';
import { Store } from '../src/store.mjs';
import { browserOpener, loginWithQrPage, openCommand } from '../src/login.mjs';

const cleanups = [];
after(async () => {
  for (const fn of cleanups) await fn();
});

/** 一个用完就扔的数据目录 */
function tempStore() {
  const home = mkdtempSync(join(tmpdir(), 'wab-login-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return new Store(home);
}

/** 每次挑一个不太可能被占的端口（真被占了 QrPage 会自己往后找） */
let nextPort = 8300 + (process.pid % 400);
const pickPort = () => nextPort++;

/** 一个听话的假客户端：按剧本走 */
function fakeClient(script) {
  return {
    calls: 0,
    async login(opts) {
      this.calls += 1;
      if (this.calls > 1) throw new Error('login 不该被调第二次');
      return script(opts);
    },
  };
}

const CREDS = { baseUrl: 'https://ilink.test', botToken: 'tok-123', ilinkUserId: 'me-42' };

// ───────────────────────── 打开浏览器 ─────────────────────────

test('打开浏览器的命令：三个平台各自对', () => {
  assert.deepEqual(openCommand('darwin', 'http://127.0.0.1:8099'), {
    cmd: 'open', args: ['http://127.0.0.1:8099'],
  });
  assert.deepEqual(openCommand('linux', 'http://127.0.0.1:8099'), {
    cmd: 'xdg-open', args: ['http://127.0.0.1:8099'],
  });
  // Windows 上 `start` 是 cmd 内置的，而且第一个参数是窗口标题（空串），不然 URL 会被当成标题
  assert.deepEqual(openCommand('win32', 'http://127.0.0.1:8099'), {
    cmd: 'cmd', args: ['/c', 'start', '', 'http://127.0.0.1:8099'],
  });
});

test('开不出来浏览器：**吃掉错误**，不能让登录失败', () => {
  // 精简的 Linux 上没有 xdg-open —— 报 ENOENT，但不能把登录带崩
  const spawnFn = () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); };
  assert.doesNotThrow(() => browserOpener('linux', spawnFn)('http://127.0.0.1:1'));
});

test('开不出来浏览器（异步报错）：也不抛', async () => {
  const spawnFn = () => ({
    on() { /* 不注册也行 */ },
    unref() {},
    kill() {},
  });
  assert.doesNotThrow(() => browserOpener('darwin', spawnFn)('http://127.0.0.1:1'));
});

// ───────────────────────── 整条流程 ─────────────────────────

test('★ 第一次启动：起页 → 开浏览器 → 扫码 → 落盘 → 页面显示成功', async () => {
  const store = tempStore();
  const port = pickPort();
  const inner = new QrPage({ port, log: () => {} });
  const page = spyPage(inner);
  const opened = [];
  let served = null;

  const client = fakeClient(async (opts) => {
    opts.onQr?.({ content: 'QR-CONTENT-1', cycle: 1 });
    opts.onStatus?.('scaned');            // 协议里就是这么拼的（少一个 n）
    // 这张码**真的能通过 HTTP 读到**（真服务器、真请求，只是没连网）
    served = await (await fetch(`${inner.url}/status`)).json();
    return CREDS;
  });

  const creds = await loginWithQrPage({
    client, store, page, log: () => {},
    open: (url) => opened.push(url),
    settleMs: 0, failMs: 0,
  });

  // ① 登录态真的落了盘 —— 而且**游标被清掉**（换了账号就是换了一条消息流）
  assert.deepEqual(creds, CREDS);
  assert.equal(store.readToken().botToken, 'tok-123');
  assert.equal(store.readCursor(), '');

  // ② 浏览器被指向**扫码页真实的那个地址**
  //    （不是配置里写的那个 —— 端口被占时 QrPage 会自己往后挪）
  assert.equal(opened.length, 1, '该打开一次浏览器');
  assert.equal(opened[0], inner.url);
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+$/);

  // ③ 码真的进了页面
  assert.ok(served.updatedAt > 0, `页面该收到码：${JSON.stringify(served)}`);
  assert.equal(served.cycle, 1);
  assert.equal(served.status, 'scaned');

  // ④ 收场：页面显示"绑定成功"，然后被关掉（不留监听端口）
  assert.deepEqual(page.seen.finished, [{ accountId: 'me-42' }]);
  assert.equal(inner.state.done, true);
  assert.equal(inner.state.status, 'confirmed');
  assert.equal(inner.state.accountId, 'me-42');
  assert.equal(page.seen.stopped, 1);
});

test('码真的进了页面：/status 一开始是空的，update 之后才有', async () => {
  const store = tempStore();
  const page = new QrPage({ port: pickPort(), log: () => {} });

  let before = null;
  const client = fakeClient(async (opts) => {
    before = await (await fetch(`${page.url}/status`)).json();
    opts.onQr?.({ content: 'X', cycle: 3 });
    return CREDS;
  });

  await loginWithQrPage({
    client, store, page, log: () => {}, open: () => {}, settleMs: 0, failMs: 0,
  });

  assert.equal(before.cycle, 0, '还没出码时页面不该显示有码');
  assert.equal(before.updatedAt, 0, '还没出码时不该有 updatedAt');
});

/** 页面替身：真的那个页面负责 HTTP，这层只把"被调了什么"记下来 */
function spyPage(inner, seen = { failed: [], finished: [], stopped: 0 }) {
  return {
    seen,
    start: () => inner.start(),
    update: (a) => inner.update(a),
    setStatus: (s) => inner.setStatus(s),
    finish: (a) => { seen.finished.push(a); inner.finish(a); },
    fail: (m) => { seen.failed.push(m); inner.fail(m); },
    stop: async () => { seen.stopped += 1; await inner.stop(); },
    get url() { return inner.url; },
  };
}

test('扫码超时：说清"重新跑一次"，而不是只丢一句超时；失败也要显示在页面上', async () => {
  const store = tempStore();
  const page = spyPage(new QrPage({ port: pickPort(), log: () => {} }));
  const client = fakeClient(async () => {
    throw new Error('登录超时（12 分钟无人确认）');
  });

  await assert.rejects(
    () => loginWithQrPage({
      client, store, page, log: () => {}, open: () => {}, settleMs: 0, failMs: 0,
    }),
    (e) => {
      assert.match(e.message, /重新跑一次 butler run/, `要给出下一步：${e.message}`);
      return true;
    },
  );
  assert.equal(store.readToken(), null, '失败不该留下半个登录态');
  assert.match(page.seen.failed[0], /超时/, '页面上要显示失败原因（关页太快就什么都看不见）');
  assert.equal(page.seen.stopped, 1, '失败也要把页面收掉，不能留个监听端口在那');
  assert.deepEqual(page.seen.finished, [], '失败就不该显示"绑定成功"');
});

test('扫码中途 Ctrl-C：如实说"已取消"，不冒充故障', async () => {
  const store = tempStore();
  const page = new QrPage({ port: pickPort(), log: () => {} });
  const client = fakeClient(async (opts) => {
    opts.shouldStop?.();
    throw new Error('登录已被取消');
  });

  await assert.rejects(
    () => loginWithQrPage({
      client, store, page, log: () => {}, open: () => {},
      shouldStop: () => true, settleMs: 0, failMs: 0,
    }),
    /取消/,
  );
});

test('网络不通：错误里带上"检查能不能上网 + 重新跑一次"', async () => {
  const store = tempStore();
  const page = new QrPage({ port: pickPort(), log: () => {} });
  const client = fakeClient(async () => {
    throw new Error('fetch failed');
  });

  await assert.rejects(
    () => loginWithQrPage({
      client, store, page, log: () => {}, open: () => {}, settleMs: 0, failMs: 0,
    }),
    (e) => {
      assert.match(e.message, /fetch failed/);
      assert.match(e.message, /重新跑一次 butler run/);
      return true;
    },
  );
});

test('页面起不来（端口全被占）：报错要能照着做，而不是静默等超时', async () => {
  const store = tempStore();
  const page = {
    async start() { throw new Error('端口 8099~8110 都被占用，起不了扫码页'); },
    update() {}, setStatus() {}, finish() {}, fail() {}, async stop() {},
  };

  await assert.rejects(
    () => loginWithQrPage({
      client: fakeClient(async () => CREDS), store, page, log: () => {},
      open: () => {}, settleMs: 0, failMs: 0,
    }),
    /都被占用/,
  );
});

test('成功之后页面会被关掉（不留一个没人管的监听端口）', async () => {
  const store = tempStore();
  const port = pickPort();
  const page = new QrPage({ port, log: () => {} });

  await loginWithQrPage({
    client: fakeClient(async () => CREDS), store, page, log: () => {},
    open: () => {}, settleMs: 0, failMs: 0,
  });

  await assert.rejects(() => fetch(`${page.url}/status`), '页面该已经被关掉');
});
