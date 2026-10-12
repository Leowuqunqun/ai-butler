/**
 * 端到端：**真的把 cordis 这条路跑起来**
 *
 *   node --test test/with-core.mjs
 *
 * 前面两个包的测试都是分开验的：`core` 对着一个**假** agent，`agent-dsh` 对着一个**假** dsh。
 * 这里把它们接起来 —— 真 `core` 驱动真 `agent-dsh` 驱动真子进程 ——
 * 验证的是**接缝**：进度真的传到了用户手里吗？会话锁真的被恢复了吗？
 *
 * 全离线，不联网、不调模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';
import { ButlerCore } from '@butler/core';
import { DshAgent } from '@butler/agent-dsh';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fixtures', 'fake-dsh.mjs');

/** 最小的假通道：只记下发出去了什么 */
class FakeChannel extends ChannelService {
  id = 'fake';
  sent = [];
  typing = [];
  started = false;

  constructor(ctx) { super(ctx); }
  async start() { this.started = true; }
  async stop() { this.started = false; }
  async sendText(to, text, opts) { this.sent.push({ to, text, opts }); return { chunks: 1 }; }
  async sendFile(to, path) { return { fileName: path, size: 0 }; }
  async setTyping(to, on) { this.typing.push({ to, on }); }

  push(text) {
    this.emitMessage({ channel: this.id, fromId: 'u1', contextToken: 'tk', text });
  }
}

async function setup(coreCfg = {}, agentCfg = {}) {
  const home = mkdtempSync(join(tmpdir(), 'e2e-home-'));
  const work = mkdtempSync(join(tmpdir(), 'e2e-work-'));
  // 开场白默认关掉：这些端到端用例量的都是「agent 的正文原样出去」，多一句自我介绍会把它搅浑
  writeFileSync(join(home, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(DshAgent, { bin: FAKE, patchFile: '/tmp/p.yml', home, timeoutMs: 10_000, ...agentCfg });
  await ctx.plugin(ButlerCore, {
    workspace: work,
    stateFile: join(home, 'state.json'),
    progressIntervalMs: 0,
    ...coreCfg,
  });
  return {
    ctx,
    channel: ctx.channel,
    core: ctx.core,
    home,
    work,
    texts: () => ctx.channel.sent.map((s) => s.text),
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, what, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`等「${what}」超时（${ms}ms）`);
    await sleep(5);
  }
}

// ───────────────────────── ─────────────────────────

test('端到端：通道 → 内核 → agent-dsh（真子进程）→ 回话到通道', async () => {
  const t = await setup();
  try {
    await t.core.start();
    assert.equal(t.channel.started, true, '内核 start 要把通道拉起来');

    t.channel.push('ok');
    await waitFor(() => t.channel.sent.length > 0, '回话');

    assert.equal(t.texts()[0], '干完了', 'agent 的正文原样出去，内核不加装饰');
    assert.equal(t.channel.sent[0].opts.quote, 'ok', '"在回哪句"作为字段交给通道');
    assert.deepEqual(t.channel.typing, [{ to: 'u1', on: true }, { to: 'u1', on: false }], '正在输入成对');
  } finally { await t.cleanup(); }
});

test('端到端：**工具级进度真的送到了用户手里**（这是那个"221 秒没声音"的解法）', async () => {
  const t = await setup({ progressIntervalMs: 40 });
  try {
    await t.core.start();
    t.channel.push('slow');       // 假 dsh：先报一条 tool_call，再磨 400ms

    // 等到**某一条**播报里出现了工具进度（第一条可能还赶不上子进程启动）
    await waitFor(() => t.texts().some((x) => /🔧 read/.test(x)), '带工具进度的播报');
    const ping = t.texts().find((x) => /🔧 read/.test(x));
    assert.match(ping, /config\.ts/, '还要说清在读哪个文件');

    // 给用户的话里不能出现内部细节
    for (const line of t.texts()) {
      assert.equal(/上限 \d+s|profile=|DSH_HOME|--patch/.test(line), false, `内部细节漏进聊天窗口了：${line}`);
    }

    await waitFor(() => t.texts().some((x) => /磨完了/.test(x)), '最终结果');
  } finally { await t.cleanup(); }
});

test('端到端：会话跨两条消息续接（真子进程里也成立）', async () => {
  const t = await setup();
  try {
    await t.core.start();

    t.channel.push('ok');
    await waitFor(() => t.channel.sent.length === 1, '第一次回话');

    t.channel.push('echo-args');
    await waitFor(() => t.channel.sent.length === 2, '第二次回话');

    // 取最后一行非空内容：正文里不该再有引用行（那是通道的事），但别把这条
    // **会话续接**的断言绑死在"第几行"上。
    const body = t.texts()[1].split('\n').filter((l) => l.trim()).at(-1);
    const argv = JSON.parse(body);
    const i = argv.indexOf('--session-id');
    assert.ok(i >= 0, '第二条必须带上会话 id，否则每次都从零开始');
    assert.match(argv[i + 1], /^fake-/, '带的应当是第一次返回的那个');
  } finally { await t.cleanup(); }
});

test('端到端：会话被占用 → 内核丢掉旧会话重试 → 用户拿到结果而不是报错', async () => {
  const t = await setup();
  try {
    await t.core.start();

    // 先来一条正常的，攒下一个会话
    t.channel.push('ok');
    await waitFor(() => t.channel.sent.length === 1, '第一次回话');

    // 这次带着旧会话，假 dsh 会报"已被写句柄占用"
    t.channel.push('lock-once');
    await waitFor(() => t.texts().some((x) => /换了个新会话，过了/.test(x)), '重试成功');

    assert.equal(
      t.texts().some((x) => /agent 出错|会话被别的进程占着/.test(x)),
      false,
      '恢复成功了就不该把错误丢给用户——用户根本不需要知道底层换过会话',
    );
  } finally { await t.cleanup(); }
});

test('端到端：agent 出错时如实转述（不静默、不假装成功）', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push('err');
    await waitFor(() => t.channel.sent.length > 0, '回话');
    assert.match(t.texts()[0], /（agent 出错，\d+s）/);
    assert.match(t.texts()[0], /模型没配 key/);
  } finally { await t.cleanup(); }
});

test('端到端：agent 跑着的时候停机，能被立刻掐断（子进程也要被回收）', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push('hang');
    await waitFor(() => t.channel.typing.length > 0, '开始跑了');

    const t0 = Date.now();
    await t.core.stop();
    assert.ok(Date.now() - t0 < 2000, `停机不该干等（实际 ${Date.now() - t0}ms）`);
    assert.equal(t.channel.started, false);
  } finally { await t.cleanup(); }
});

test('端到端：陌生人指挥不动这台机器（安全边界在真实组合下也成立）', async () => {
  const t = await setup();
  try {
    await t.core.start();

    // 第一条认主
    t.channel.push('ok');
    await waitFor(() => t.channel.sent.length === 1, '主人这条有回话');

    // 换个 id 说话：不该有任何反应，更不该跑 agent
    t.ctx.channel.emitMessage({ channel: 'fake', fromId: 'intruder', text: 'ok' });
    await sleep(200);
    assert.equal(t.channel.sent.length, 1, '陌生人连回话都不该有');
  } finally { await t.cleanup(); }
});
