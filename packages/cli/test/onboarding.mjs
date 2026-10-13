import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_KEY_PORT, ensureChannelSecrets, ensureChannelToken, ensureModelKey } from '../lib/onboarding.js';
import { credentialsFileOf } from '../lib/credentials.js';
import { channelSecretNeeds, injectChannelSecrets, saveSecret, secretOf, secretsFileOf } from '../lib/secrets.js';

const REF = 'DEEPSEEK_API_KEY';

/**
 * 每个用例自己挑一个端口：并行跑测试时端口会撞。
 * 40000 以上是动态端口区，撞上的概率低；真撞了 `listen()` 自己会往后挪。
 */
let nextPort = 41_000 + (process.pid % 500);
function pickPort() {
  nextPort += 7;
  return nextPort;
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'butler-key-'));
}

/** 收集日志，好断言"跟用户说了什么" */
function logger() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

/** 起页面 → 返回一个能对着它发请求的客户端（以及收尾用的句柄） */
function starter(opts = {}) {
  const home = opts.home ?? tempHome();
  const log = logger();
  const opened = [];
  const controller = new AbortController();
  const promise = ensureModelKey({
    dshHome: home,
    ref: REF,
    log: log.log,
    port: opts.port ?? pickPort(),
    timeoutMs: opts.timeoutMs ?? 4000,
    open: opts.open ?? ((url) => opened.push(url)),
    ...(opts.autoOpen === undefined ? {} : { autoOpen: opts.autoOpen }),
    env: opts.env ?? {},
    globalCredentialsFile: opts.globalCredentialsFile ?? join(home, 'no-such-dsh', '.credentials.yaml'),
    // 默认假装对方说"能用"：这些用例不许走网络。（校验本身另有 model-key.mjs 盯着）
    verifyKey: opts.verifyKey ?? (async () => ({ ok: true, blocking: false, why: '这把 key 能用' })),
    signal: controller.signal,
    ...(opts.force === undefined ? {} : { force: opts.force }),
  });
  return { home, log, opened, promise, controller };
}

/** 收尾：中断 + 等它真的结束。用例失败时也要跑到（挂在 t.after 上） */
async function stop(s) {
  s.controller.abort();
  await s.promise.catch(() => {});
}

/** 等 URL 出现再发请求 —— 不然会撞上"服务器还没起来" */
async function waitForUrl(s) {
  for (let i = 0; i < 200; i += 1) {
    if (s.opened.length) return new URL(s.opened[0]);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`一直没打开页面。日志：${s.log.lines.join(' | ')}`);
}

/** 守门那层同理：从日志里取地址 */
async function waitForUrl2(s) {
  for (let i = 0; i < 200; i += 1) {
    const line = s.log.lines.find((l) => l.includes('http://127.0.0.1:'));
    if (line) return new URL(line.trim());
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`日志里一直没有地址：${s.log.lines.join(' | ')}`);
}

/** 从日志里取页面地址 —— `--no-open` / 浏览器打不开时，`opened` 里什么都没有 */
async function urlFromLog(s) {
  for (let i = 0; i < 200; i += 1) {
    const line = s.log.lines.find((l) => l.includes('http://127.0.0.1:'));
    if (line) return new URL(line.trim());
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`日志里一直没有地址：${s.log.lines.join(' | ')}`);
}

// ───────────────────────── 该问才问 ─────────────────────────

test('凭据文件里已经有 key：不起页面、不打开浏览器', async (t) => {
  const home = tempHome();
  writeFileSync(credentialsFileOf(home), `version: 1\nrefs:\n  ${REF}: "sk-already"\n`, { mode: 0o600 });

  const s = starter({ home });
  t.after(() => stop(s));
  assert.equal(await s.promise, 'present');
  assert.deepEqual(s.opened, [], '有 key 就不该再弹页面');
  assert.match(s.log.lines.join('\n'), /模型 key：已经有了/);
});

test('启动环境里有 key：也算已经有了（DSH 会优先用它）', async (t) => {
  const s = starter({ env: { [REF]: 'sk-from-env' } });
  t.after(() => stop(s));
  assert.equal(await s.promise, 'present');
  assert.deepEqual(s.opened, []);
  assert.match(s.log.lines.join('\n'), /启动环境/);
});

// ───────────────────────── ★ 贴进去 ─────────────────────────

test('★ 贴一个 key：写进凭据文件（0600），页面告诉他"存好了"', async (t) => {
  const s = starter();
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  assert.match(url.href, /^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{32}\/$/);

  // 页面真的能打开，而且把"写到哪个文件"讲清楚了
  const pageRes = await fetch(url);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /填模型 key/);
  assert.match(html, new RegExp(credentialsFileOf(s.home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, /platform\.deepseek\.com/, '要告诉他去哪儿拿 key');

  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-pasted-by-user' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, source: 'typed' });

  assert.equal(await s.promise, 'saved');
  const file = credentialsFileOf(s.home);
  assert.equal(readFileSync(file, 'utf8'), `version: 1\nrefs:\n  ${REF}: "sk-pasted-by-user"\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'key 文件必须只有本人可读');
  assert.match(s.log.lines.join('\n'), /存好了 ✓/);
  assert.equal(s.log.lines.join('\n').includes('sk-pasted-by-user'), false, 'key 不许打日志');
});

test('存好之后页面就关了（不留一个没人管的监听端口）', async (t) => {
  const s = starter();
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-x' }),
  });
  await s.promise;

  await assert.rejects(() => fetch(new URL('key', url), { method: 'POST', body: '{}' }));
});

test('空 key：页面报错，服务继续等着（不能当成"存好了"）', async (t) => {
  const s = starter({ timeoutMs: 300 });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '   ' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);

  assert.equal(await s.promise, 'skipped', '拒绝之后要等超时，而不是假装成功');
});

test('提交的内容太大：413，而不是把进程撑爆', async (t) => {
  const s = starter({ timeoutMs: 300 });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-' + 'x'.repeat(20000) }),
  });
  assert.equal(res.status, 413);
  assert.equal(await s.promise, 'skipped');
});

// ───────────────────────── 令牌、跳过、复制、超时 ─────────────────────────

test('没有那一串随机数：一律 404（别的网页猜不到它）', async (t) => {
  const s = starter();
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  const port = url.port;

  const wrong = await fetch(`http://127.0.0.1:${port}/s/${'0'.repeat(32)}/`);
  assert.equal(wrong.status, 404);
  const root = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(root.status, 404);

  // 收尾：跳过，把服务器关掉
  const skip = await fetch(new URL('skip', url), { method: 'POST' });
  assert.equal(skip.status, 200);
  assert.equal(await s.promise, 'skipped');
});

test('跳过：不当成失败，而且告诉他回头怎么办', async (t) => {
  const s = starter();
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('skip', url), { method: 'POST' });

  assert.equal(await s.promise, 'skipped');
  assert.match(s.log.lines.join('\n'), /先跳过[\s\S]*butler run/);
});

test('你 dsh 里没有那把：不给"从 dsh 复制"这个按钮（别给一个点了没用的按钮）', async (t) => {
  const home = tempHome();
  const s = starter({ home, globalCredentialsFile: join(home, '.dsh', '.credentials.yaml') });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const html = await (await fetch(url)).text();
  assert.equal(html.includes('用我在 dsh 里已有的那把'), false);

  await fetch(new URL('skip', url), { method: 'POST' });
  await s.promise;
});

test('★ 你 dsh 里已经有一把：一键复制过来，不用重新找 key', async (t) => {
  const home = tempHome();
  const globalFile = join(home, '.dsh', '.credentials.yaml');
  mkdirSync(join(home, '.dsh'), { recursive: true, mode: 0o700 });
  writeFileSync(globalFile, `version: 1\nrefs:\n  ${REF}: "sk-from-dsh"\n`, { mode: 0o600 });

  const s = starter({ home, globalCredentialsFile: globalFile });
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  assert.match(await (await fetch(url)).text(), /用我在 dsh 里已有的那把/);

  const res = await fetch(new URL('from-dsh', url), { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(await s.promise, 'saved');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-from-dsh/);
});

test('没人理：等到超时就往后走（没 key 也能先把微信登上）', async (t) => {
  const s = starter({ timeoutMs: 120 });
  t.after(() => stop(s));
  await waitForUrl(s);

  const started = Date.now();
  assert.equal(await s.promise, 'skipped');
  assert.ok(Date.now() - started >= 100, '该等够时间再放弃');
  assert.match(s.log.lines.join('\n'), /先跳过/);
});

test('Ctrl-C（中断）：立刻收手，并关掉服务器', async (t) => {
  const s = starter({ timeoutMs: 60_000 });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  s.controller.abort();
  assert.equal(await s.promise, 'skipped');
  await assert.rejects(() => fetch(url));
});

test('★ --no-open：不开浏览器，而且**不说**开了（自启动走的就是这条）', async (t) => {
  const s = starter({ autoOpen: false });
  t.after(() => stop(s));
  const url = await urlFromLog(s);

  assert.deepEqual(s.opened, [], 'autoOpen:false 就不该去碰浏览器');
  const said = s.log.lines.join('\n');
  assert.match(said, /没自动开浏览器/, '要照实说');
  assert.doesNotMatch(said, /已经自动打开/, '不能谎称开了 —— 用户会去等一个永远不出现的窗口');

  // 不开浏览器 ≠ 不能用：页面照旧能贴
  const r = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-no-open' }),
  });
  assert.equal(r.status, 200);
  assert.equal(await s.promise, 'saved', '不自动开浏览器，别的照旧');
});

test('★ 浏览器打不开也照实说（服务器上没有 xdg-open / open 那种情况）', async (t) => {
  const s = starter({ open: () => { throw new Error('没有浏览器'); } });
  t.after(() => stop(s));
  await urlFromLog(s);

  const said = s.log.lines.join('\n');
  assert.match(said, /没自动开浏览器/);
  assert.doesNotMatch(said, /已经自动打开/);
});

test('浏览器真的开了，才说"已经自动打开"', async (t) => {
  const s = starter();
  t.after(() => stop(s));
  await urlFromLog(s);
  assert.match(s.log.lines.join('\n'), /已经自动打开/);
  assert.equal(s.opened.length, 1);
});

test('打开浏览器失败不影响流程（地址在终端里已经打了）', async (t) => {
  const s = starter({ open: () => { throw new Error('没有浏览器'); } });
  t.after(() => stop(s));

  // open 抛了，但流程还在 —— 用**日志里那个地址**去贴（终端用户就是这么做的）
  let line;
  for (let i = 0; i < 200 && !line; i += 1) {
    line = s.log.lines.find((l) => l.includes('http://127.0.0.1:'));
    if (!line) await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(line, `日志里得有地址：${s.log.lines.join(' | ')}`);
  const url = new URL(line.trim());

  await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-via-terminal' }),
  });
  assert.equal(await s.promise, 'saved');
});

test('默认端口是 8137，跟扫码页（8099）错开', () => {
  assert.equal(DEFAULT_KEY_PORT, 8137);
});

// ─────────────────── 通道凭据（Telegram 的 bot token）───────────────────

/**
 * 和 `starter()` 一个套路，只是问的东西换成通道凭据。
 * `rows` 就是配置里那几行 —— 这一关会**当场把它们填好**（那是它的产出）。
 */
function gateStarter(rows, opts = {}) {
  const dir = opts.dir ?? tempHome();
  const log = logger();
  const opened = [];
  const controller = new AbortController();
  const promise = ensureChannelSecrets(rows, {
    butlerDir: dir,
    log: log.log,
    port: opts.port ?? pickPort(),
    timeoutMs: opts.timeoutMs ?? 4000,
    open: opts.open ?? ((url) => opened.push(url)),
    ...(opts.autoOpen === undefined ? {} : { autoOpen: opts.autoOpen }),
    signal: controller.signal,
    ...(opts.force === undefined ? {} : { force: opts.force }),
  });
  return { dir, rows, log, opened, promise, controller };
}

const TG_ROW = () => ({ name: '@butler/channel-telegram', config: { botToken: '' } });

test('★ 守门这条路也得把 autoOpen 传下去（`butler run` 走的正是它）', async (t) => {
  // 这条是补漏：直连页面的用例当时全绿，可 run 走的是**守门**这一层，
  // 而它当年是逐个字段手写转发的 —— autoOpen 就这么被丢在了半路上。
  const s = gateStarter([TG_ROW()], { autoOpen: false });
  t.after(() => stop(s));
  const url = await waitForUrl2(s);

  assert.deepEqual(s.opened, [], 'autoOpen:false 时守门这层也不该去碰浏览器');
  const said = s.log.lines.join('\n');
  assert.match(said, /没自动开浏览器/, 'run 那条路也得照实说');
  assert.doesNotMatch(said, /已经自动打开/, '不能谎称开了');

  const r = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '123456:FAKE' }),
  });
  assert.equal(r.status, 200);
  // gate 返回的是"填好哪几个字段"，不是 saved/skipped（它是 run 的接线，不是页面）
  assert.deepEqual(await s.promise, ['botToken'], '不自动开浏览器，别的照旧走完');
});

test('token 页面：说清楚去哪儿拿（@BotFather 是链接）、存到哪个文件、不是模型 key', async (t) => {
  const s = gateStarter([TG_ROW()]);
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  const html = await (await fetch(url)).text();
  assert.match(html, /填一下 Telegram 的 bot token/);
  assert.match(html, /https:\/\/t\.me\/BotFather/, '@BotFather 要能点');
  assert.match(html, new RegExp(secretsFileOf(s.dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(html.includes('模型 key'), false, '问 token 的页面上不该提模型 key');
  assert.equal(html.includes('用我在 dsh 里已有的那把'), false, 'token 没有"从 dsh 搬"这条路');
});

test('★ 贴进 token：写进 0600 的凭据文件，并**填进通道那一行**', async (t) => {
  const rows = [TG_ROW()];
  const s = gateStarter(rows);
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '123456:ABC-DEF' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, source: 'typed' });
  // gate 返回的是"填了哪几个字段"，不是 saved/skipped —— 它是 run 的接线，不是页面
  assert.deepEqual(await s.promise, ['botToken']);

  const file = secretsFileOf(s.dir);
  assert.equal(secretOf(file, 'telegram', 'botToken'), '123456:ABC-DEF');
  assert.equal(statSync(file).mode & 0o777, 0o600, '凭据文件必须 0600');
  assert.equal(rows[0].config.botToken, '123456:ABC-DEF', '要当场填进那一行（容器还没起）');
  assert.equal(s.log.lines.join('\n').includes('123456:ABC-DEF'), false, 'token 不许打日志');
});

/** 守门页的地址在同一台服务器上**复用同一个端口** —— 第 n 页要等它真的起来 */
async function pageAt(s, nth) {
  for (let i = 0; i < 400; i += 1) {
    if (s.opened.length >= nth) return new URL(s.opened[nth - 1]);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`第 ${nth} 页一直没打开。日志：${s.log.lines.join(' | ')}`);
}

const FS_ROW = () => ({ name: '@butler/channel-feishu', config: { appId: '', appSecret: '' } });

/**
 * 飞书是**唯一要两项**凭据的通道（`app_id` + `app_secret`）—— "两项只填进去一项"
 * 正是这里最容易出的错。分两半测：
 *
 * ① **数据那一半**（离线）：两个 need 的定义与顺序；两项都在凭据文件里时，
 *    `injectChannelSecrets` 必须**两项都填**进那一行。
 * ② **页面那一半**：只 GET 首页，断言提示里那条命令是能照着跑的。
 *
 * ⚠️ **驱动两页的整条流程测不了**：飞书页面的校验是**真校验** —— 点保存到"存好了"
 *    之间实测有 **~2.5 秒**，那是一次真 API 往返（编的 app_id 当然会失败，页面会给出
 *    "我知道，就要存这一把"那条出口）。离线用例不碰网络，所以到 ② 为止；
 *    页面交互那一半由 telegram 那几条用例盯着（同一套代码）。
 */
test('★★ 飞书两项凭据：两个 need、两项都必须填进那一行（唯一的两项通道）', async (t) => {
  // ① 数据那一半
  assert.deepEqual(
    channelSecretNeeds(FS_ROW()).map((n) => [n.channel, n.key]),
    [['feishu', 'appId'], ['feishu', 'appSecret']],
    '两个 need、顺序也得对（先问 app_id）',
  );

  const dir = tempHome();
  const file = secretsFileOf(dir);
  saveSecret(file, 'feishu', 'appId', 'cli_from_page');
  saveSecret(file, 'feishu', 'appSecret', 'secret_from_page');
  const row = FS_ROW();
  assert.deepEqual(injectChannelSecrets([row], file), ['appId', 'appSecret'], '两项都要注入');
  assert.equal(row.config.appId, 'cli_from_page');
  assert.equal(row.config.appSecret, 'secret_from_page', '只填一项是最容易出的错');
  assert.equal(statSync(file).mode & 0o777, 0o600, '凭据文件必须 0600');

  // ② 页面那一半：只 GET，不发 POST（那一步会真打 API）
  const rows = [FS_ROW()];
  const s = gateStarter(rows);
  t.after(() => stop(s));
  const html = await (await fetch(await pageAt(s, 1))).text();
  assert.match(html, /probe\/(run\.sh|smoke\.mjs)/,
    '飞书的提示里要有探针那条命令 —— 光说"去后台建个应用"等于没说');
  assert.match(html, /--save/, '而且要带 --save —— 不带只会连一下，不会把凭据存下来');
  assert.match(html, /不需要开发者后台|不用开发者后台/, '要说清它比"去后台建应用"省事');
});

/**
 * Ctrl-C 之后不许再等。
 *
 * `signal` 早就接上了，但 `addEventListener('abort')` 对**已经中断过**的信号**不会再响**
 * （那件事发生完了）。于是：第一项被中断 → 循环走到第二项 → 又等满一个 timeout。
 * 飞书是唯一要两项的通道，所以它最明显（实测 4.2 秒，看着就是"卡住了"）。
 */
test('★★ 中断之后立刻收工：飞书那两项不许为第二项再等满一个超时', async (t) => {
  const rows = [FS_ROW()];
  const s = gateStarter(rows, { timeoutMs: 3000 });
  t.after(() => stop(s));
  await pageAt(s, 1); // 第一页起来了

  const t0 = Date.now();
  s.controller.abort();
  const filled = await s.promise;
  const waited = Date.now() - t0;

  assert.ok(waited < 1000, `中断要立刻收工，实际等了 ${waited}ms —— 在终端里看着就是卡住`);
  assert.deepEqual(filled, [], '一项都没填上（跳过了）');
  assert.equal(s.opened.length, 1, '中断之后不许再为第二项开一个页面');
});

test('空白 token 不算数：报错，而且继续等（不能当成存好了）', async (t) => {
  const rows = [TG_ROW()];
  const s = gateStarter(rows);
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '   ' }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
  assert.equal(rows[0].config.botToken, '', '没存上就不该动那一行');
});

test('已经存过一次：直接填进那一行，不再打扰他（不起页面）', async () => {
  const dir = tempHome();
  saveSecret(secretsFileOf(dir), 'telegram', 'botToken', '999:STORED');
  const rows = [TG_ROW()];
  const opened = [];
  const filled = await ensureChannelSecrets(rows, {
    butlerDir: dir,
    log: () => {},
    open: (url) => opened.push(url),
  });
  assert.deepEqual(filled, ['botToken']);
  assert.equal(rows[0].config.botToken, '999:STORED');
  assert.deepEqual(opened, [], '存过了还弹页面就是骚扰');
});

test('★ 配置里手写的 token 优先级最高：不起页面、一个字节都不改', async () => {
  const dir = tempHome();
  saveSecret(secretsFileOf(dir), 'telegram', 'botToken', '999:STORED');
  const rows = [{ name: '@butler/channel-telegram', config: { botToken: '456:HAND-WRITTEN' } }];
  const opened = [];
  const filled = await ensureChannelSecrets(rows, {
    butlerDir: dir,
    log: () => {},
    open: (url) => opened.push(url),
  });
  assert.deepEqual(filled, []);
  assert.equal(rows[0].config.botToken, '456:HAND-WRITTEN');
  assert.deepEqual(opened, []);
});

test('微信的配置走这一关时什么都不做（它靠扫码，没有 token 这回事）', async () => {
  const dir = tempHome();
  const rows = [{ name: 'wechat-agent-bridge/plugin', config: { home: dir } }];
  const opened = [];
  const filled = await ensureChannelSecrets(rows, { butlerDir: dir, log: () => {}, open: (u) => opened.push(u) });
  assert.deepEqual(filled, []);
  assert.deepEqual(opened, []);
});

test('跳过也不算失败：如实说后果，让通道自己去说缺什么', async (t) => {
  const rows = [TG_ROW()];
  const s = gateStarter(rows);
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('skip', url), { method: 'POST' });
  assert.deepEqual(await s.promise, []);
  assert.equal(rows[0].config.botToken, '', '跳过了就不能假装填上了');
  assert.match(s.log.lines.join('\n'), /先跳过[\s\S]*butler run/);
});

test('ensureChannelToken 单独用也行（不走 gate）：有就直接过', async () => {
  const dir = tempHome();
  saveSecret(secretsFileOf(dir), 'telegram', 'botToken', '111:KEPT');
  const lines = [];
  const outcome = await ensureChannelToken({
    butlerDir: dir,
    channel: 'telegram',
    key: 'botToken',
    name: 'Telegram 的 bot token',
    hint: '在 Telegram 里找 @BotFather 发 /newbot',
    log: (l) => lines.push(l),
    open: () => { throw new Error('不该弹页面'); },
  });
  assert.equal(outcome, 'present');
  assert.match(lines.join('\n'), /已经有了/);
});

// ─────────────────── `--again`：想换一把的时候 ───────────────────

const seedKey = (home, value) =>
  writeFileSync(credentialsFileOf(home), `version: 1\nrefs:\n  ${REF}: "${value}"\n`, { mode: 0o600 });

test('★ --again：已经存过 key 也重新问一遍，贴了新的就换成新的', async (t) => {
  const home = tempHome();
  seedKey(home, 'sk-OLD');
  const s = starter({ home, force: true });
  t.after(() => stop(s));

  const url = await waitForUrl(s); // 起了页面 = 真的又问了
  const res = await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'sk-NEW' }),
  });
  assert.equal(res.status, 200);
  assert.equal(await s.promise, 'saved');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-NEW/);
  assert.equal(/sk-OLD/.test(readFileSync(credentialsFileOf(home), 'utf8')), false, '旧的该被顶掉');
  assert.match(s.log.lines.join('\n'), /再问你一次/);
});

test('★ --again 但点了跳过：原来那把**还得在**（问一次不等于清空）', async (t) => {
  const home = tempHome();
  seedKey(home, 'sk-OLD');
  const s = starter({ home, force: true });
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('skip', url), { method: 'POST' });
  assert.equal(await s.promise, 'skipped');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-OLD/, '跳过了就不该动它');
});

test('--again 但 key 来自启动环境：如实说"存文件不生效"，别让他白贴一遍', async (t) => {
  const home = tempHome();
  seedKey(home, 'sk-FILE');
  const s = starter({ home, force: true, env: { [REF]: 'sk-ENV' } });
  t.after(() => stop(s));
  assert.equal(await s.promise, 'present');
  assert.deepEqual(s.opened, [], '环境变量说了算，就别弹页面了');
  assert.match(s.log.lines.join('\n'), /先把启动环境里的 DEEPSEEK_API_KEY 去掉/);
});

test('★ --again 换 token：贴了新的就换成新的', async (t) => {
  const dir = tempHome();
  saveSecret(secretsFileOf(dir), 'telegram', 'botToken', '111:OLD');
  const rows = [TG_ROW()];
  const s = gateStarter(rows, { dir, force: true });
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('key', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: '222:NEW' }),
  });
  assert.deepEqual(await s.promise, ['botToken']);
  assert.equal(secretOf(secretsFileOf(dir), 'telegram', 'botToken'), '222:NEW');
  assert.equal(rows[0].config.botToken, '222:NEW');
});

test('★ --again 换 token 但跳过：原来那串必须还在行里（不能把管家弄哑）', async (t) => {
  const dir = tempHome();
  saveSecret(secretsFileOf(dir), 'telegram', 'botToken', '111:OLD');
  const rows = [TG_ROW()];
  const s = gateStarter(rows, { dir, force: true });
  t.after(() => stop(s));
  const url = await waitForUrl(s);
  await fetch(new URL('skip', url), { method: 'POST' });
  assert.deepEqual(await s.promise, ['botToken'], '旧的那串该被注入回去');
  assert.equal(rows[0].config.botToken, '111:OLD');
  assert.equal(secretOf(secretsFileOf(dir), 'telegram', 'botToken'), '111:OLD');
  assert.match(s.log.lines.join('\n'), /还是用你原来那串/);
});

test('没给 --again 的时候，存过就不问（默认行为一个字没变）', async () => {
  const home = tempHome();
  seedKey(home, 'sk-OLD');
  const opened = [];
  const outcome = await ensureModelKey({
    dshHome: home,
    ref: REF,
    log: () => {},
    open: (url) => opened.push(url),
    env: {},
    globalCredentialsFile: join(home, 'nope', '.credentials.yaml'),
  });
  assert.equal(outcome, 'present');
  assert.deepEqual(opened, []);
});

// ─────────── ★ 先验再存：贴错了要当场说，不能等几小时后 ───────────

const write = (url, body) => fetch(new URL('key', url), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('★ 对方说这把 key 不对：页面上当场说清楚，**而且一个字节都不写**', async (t) => {
  const home = tempHome();
  const s = starter({
    home,
    verifyKey: async (key) => (key === 'sk-typo'
      ? { ok: false, blocking: true, why: '对方说这把 key 不对（401）', hint: '去 platform.deepseek.com 重新复制一整串' }
      : { ok: true, blocking: false, why: '这把 key 能用' }),
  });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const res = await write(url, { key: 'sk-typo' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /401/);
  assert.match(body.hint, /重新复制/, '要说下一步，不能只说"不对"');
  assert.equal(existsSync(credentialsFileOf(home)), false, '存一把错的 = 埋一个哑雷');

  // 页面还能接着用：改对了照样存得上
  const ok = await write(url, { key: 'sk-GOOD' });
  assert.equal(ok.status, 200);
  assert.equal(await s.promise, 'saved');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-GOOD/);
});

test('★ 没法确认（网络不通）：照样存，但页面上明说"没确认"', async (t) => {
  const home = tempHome();
  const s = starter({
    home,
    verifyKey: async () => ({ ok: false, blocking: false, why: '没能连上对方（网络不通），没法确认这把 key' }),
  });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const res = await write(url, { key: 'sk-offline' });
  const body = await res.json();
  assert.equal(body.ok, true, '连不上不该拦着人 —— 他自己知道网络的情况');
  assert.match(body.warning, /没法确认/, '但绝不许让他以为验过了');
  assert.equal(await s.promise, 'saved');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-offline/);
});

test('能用：存下去，不带那句"没确认"', async (t) => {
  const home = tempHome();
  const s = starter({ home });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const body = await (await write(url, { key: 'sk-fine' })).json();
  assert.equal(body.ok, true);
  assert.equal(body.warning, undefined);
  assert.equal(await s.promise, 'saved');
});

test('★ 校验没过也**绝不把人堵死**：他自己确认过就能存下', async (t) => {
  const home = tempHome();
  const s = starter({
    home,
    verifyKey: async () => ({ ok: false, blocking: true, why: '对方说这把 key 不对（401）', hint: '重新复制一整串' }),
  });
  t.after(() => stop(s));
  const url = await waitForUrl(s);

  const refused = await write(url, { key: 'sk-OTHER-PROVIDER' });
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.equal(body.allowAnyway, true, '页面上必须出现一个能过去的按钮');

  // 校验是替人把关，不是替人做主：他说了"我知道"，就存
  const forced = await write(url, { key: 'sk-OTHER-PROVIDER', force: true });
  assert.equal(forced.status, 200);
  assert.equal(await s.promise, 'saved');
  assert.match(readFileSync(credentialsFileOf(home), 'utf8'), /sk-OTHER-PROVIDER/);
});
