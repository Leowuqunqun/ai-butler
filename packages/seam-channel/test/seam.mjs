/**
 * seam-channel 的测试 —— 验证"这个能力位真的能被实现、被消费"。
 *
 * 被测对象是**编译产物**（lib/），也就是说测试跑的是消费者拿到的那份东西。
 * 假通道用 TypeScript 写在 test/fixtures/，先编译再加载：
 * 这样类型契约（抽象成员有没有漏）和运行行为一起被验证。
 *
 *   node --test test/seam.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { ChannelService, quotedMedia } from '@butler/seam-channel';
import { FakeChannel, MemoryService } from './.build/fake-channel.js';

/** 只实现抽象成员的最小通道：用来验证基类给的默认行为 */
class MinimalChannel extends ChannelService {
  id = 'minimal';
  started = false;
  async start() { this.started = true; }
  async stop() { this.started = false; }
  async sendText() { return { chunks: 1 }; }
  async sendFile() { return { size: 0 }; }
  push(msg) { this.emitMessage({ channel: this.id, fromId: 'u', ...msg }); }
}

// ───────────────────────── 加载与身份 ─────────────────────────

test('实现类作为 cordis 插件加载后，ctx.channel 就位且双身份成立', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, { maxChars: 50 });

    assert.ok(ctx.channel, 'ctx.channel 必须就位');
    assert.ok(ctx.channel instanceof FakeChannel, '是实现类的实例');
    assert.ok(ctx.channel instanceof ChannelService, '也是 seam 的实例——核心层只按 seam 消费');
    assert.equal(ctx.channel.id, 'fake');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约方法转发到实现', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, {});
    const ch = ctx.channel;

    await ch.start();
    assert.equal(ch.started, true, 'start 要生效');

    const r = await ch.sendText('u1', '你好', { contextToken: 'tk' });
    assert.deepEqual(r, { chunks: 1 });
    assert.deepEqual(ch.sent[0], { to: 'u1', text: '你好', opts: { contextToken: 'tk' } });

    const f = await ch.sendFile('u1', '/tmp/a.pdf');
    assert.equal(f.fileName, 'a.pdf');
    assert.equal(ch.sentFiles[0].path, '/tmp/a.pdf');

    await ch.setTyping('u1', true);
    assert.deepEqual(ch.typing[0], { to: 'u1', on: true });
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── static Config ─────────────────────────

test('static Config：默认值生效、传入值覆盖，且解析成普通对象', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, { maxChars: 50 });

    const cfg = ctx.channel.config;
    assert.equal(cfg.greeting, '你好', '未传的字段要拿到 schema 默认值');
    assert.equal(cfg.maxChars, 50, '传了的字段要覆盖默认值');
    // 本项目的用法：cordis 4 + schemastery 解析出来就是普通值，不需要 .get()
    assert.equal(typeof cfg.maxChars, 'number');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── static inject 门控 ─────────────────────────

test('static inject：依赖没就位时服务不出现，补上后自动就位', async () => {
  const ctx = new Context();
  try {
    // 先只加载通道：它 inject 'memory'，而 memory 还不存在
    await ctx.plugin(FakeChannel, {});
    assert.equal(ctx.channel, undefined, '依赖缺失时不该注册服务位');

    // 依赖到位 → 通道应当自动就位
    await ctx.plugin(MemoryService);
    assert.ok(ctx.channel instanceof FakeChannel, '依赖到位后应自动注册');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 消息分发 ─────────────────────────

test('onMessage：多个消费者都收到，重复注册会被去重', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, {});
    const ch = ctx.channel;

    const a = [];
    const b = [];
    const ha = (m) => a.push(m);
    ch.onMessage(ha);
    ch.onMessage(ha); // 故意重复
    ch.onMessage((m) => b.push(m));

    ch.push({ text: 'hi' });
    assert.equal(a.length, 1, '重复注册的 handler 只该收到一次');
    assert.equal(b.length, 1);
    assert.equal(a[0].channel, 'fake');
    assert.equal(a[0].fromId, 'u1');
    assert.equal(a[0].text, 'hi');

    // offMessage 之后不再收
    ch.offMessage(ha);
    ch.push({ text: 'again' });
    assert.equal(a.length, 1, '注销后不该再收到');
    assert.equal(b.length, 2);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('附件按契约原样传递（本机路径 + 元数据）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, {});
    let got = null;
    ctx.channel.onMessage((m) => { got = m; });

    ctx.channel.push({ text: '看看这个' }, [
      { path: '/tmp/inbox/a.png', name: 'a.png', mime: 'image/png', size: 12, kind: 'image' },
    ]);

    assert.equal(got.files.length, 1);
    assert.equal(got.files[0].path, '/tmp/inbox/a.png');
    assert.equal(got.files[0].kind, 'image');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('一个消费者抛错不影响其他消费者，也不打断通道', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeChannel, {});
    const ch = ctx.channel;

    let reached = 0;
    ch.onMessage(() => { throw new Error('消费者炸了'); });
    ch.onMessage(() => { reached += 1; });

    assert.doesNotThrow(() => ch.push({ text: 'x' }), '消费者抛错不该冒到通道的收信循环');
    assert.equal(reached, 1, '后面的消费者仍然要收到');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 基类默认行为 ─────────────────────────

test('setTyping 基类默认是 no-op（不支持该能力的通道不用管它）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MinimalChannel);
    await assert.doesNotReject(() => ctx.channel.setTyping('u', true), 'best-effort，不许抛错');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('重复实现同一个服务位会抛错（一个 context 只能有一个通道）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(MinimalChannel);
    // 注意：ctx.plugin() 返回的是 Fiber 而不是 Promise，所以不能用 assert.rejects。
    // 另外必须先把 memory 就位，否则 FakeChannel 会因为 inject 未满足而根本不构造，
    // 也就撞不上重复注册（那属于 inject 门控，见上一个用例）。
    let threw = null;
    try {
      await ctx.plugin(FakeChannel, {});
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, '加载第二个通道实现必须报错，而不是静默覆盖');
    assert.match(threw.message, /channel/, `错误信息要指明是哪个服务位：${threw.message}`);
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 生命周期 ─────────────────────────

test('卸载时：服务位消失、实现的 effect 清理被执行、消费者被摘掉', async () => {
  const memory = { disposed: false };
  const ctx = new Context();
  await ctx.plugin(MemoryService);
  const mem = ctx.memory;
  await ctx.plugin(FakeChannel, {});
  const ch = ctx.channel;

  const seen = [];
  ch.onMessage((m) => seen.push(m));
  await ch.start();
  assert.equal(ch.started, true);

  await ctx.fiber.dispose();

  assert.equal(ctx.channel, undefined, '卸载后服务位要消失');
  assert.equal(ch.started, false, '实现注册在 ctx.effect 上的清理要被执行');
  assert.equal(mem.disposed, true, '依赖服务的清理也要被执行');
  assert.equal(memory.disposed, false, '（这个标记没被用上，只为可读性）');
});

test('check 是**可选**的：没实现的通道照样是合法的通道', async () => {
  const ctx = new Context();
  await ctx.plugin(MemoryService);   // 夹具 inject 了 memory，缺它根本不会被构造
  await ctx.plugin(FakeChannel);
  try {
    // 这条保证的是"加了这个约定没有把已有实现变成非法"。
    // 真实现（微信通道 / dsh / exec / 内核）都实现了它，但**不许**变成必须的。
    assert.equal(ctx.channel.check, undefined);
    assert.equal(typeof ctx.channel.sendText, 'function', '别的成员一切照旧');
  } finally { await ctx.fiber.dispose(); }
});

test('★ "引用的是媒体"只有一种写法（两个通道不许各写一套）', () => {
  // 这个函数存在的唯一理由：同一个字段会被内核放进提示词，
  // 两个通道各拼一套就会出现"用微信 agent 看到文件名、用 Telegram 只看到[一个文件]"。
  assert.equal(quotedMedia('image'), '[图片]');
  assert.equal(quotedMedia('voice'), '[语音]');
  assert.equal(quotedMedia('video'), '[视频]');
  assert.equal(quotedMedia('file', '季度报表.xlsx'), '[文件（季度报表.xlsx）]');
  assert.equal(quotedMedia('file'), '[文件]', '没名字就只报类别，不编一个');
  assert.equal(quotedMedia('unknown'), '[消息]', '认不出来就别假装知道是什么');
  assert.equal(quotedMedia('file', ' 多  空格\n名 '), '[文件（多 空格 名）]', '名字先压成一行');
});
