/**
 * `ctx.agent` seam 的测试 —— 验证"这个能力位真的能被实现、被消费"。
 *
 * 被测对象是**编译产物**（lib/），也就是消费者拿到的那份东西。
 * 假 agent 用 TypeScript 写在 test/fixtures/，先编译再加载：
 * 这样类型契约（抽象成员有没有漏）和运行行为一起被验证。
 *
 *   node --test test/seam.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { FakeAgent, MemoryService } from './.build/fake-agent.js';

/** 只实现抽象成员的最小实现：用来验证基类给的默认行为 */
class MinimalAgent extends AgentService {
  id = 'minimal';
  async run() { return { text: 'ok' }; }
}

// ───────────────────────── 加载与身份 ─────────────────────────

test('实现类作为 cordis 插件加载后，ctx.agent 就位且双身份成立', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent, { greeting: '嗨' });

    assert.ok(ctx.agent, 'ctx.agent 必须就位');
    assert.ok(ctx.agent instanceof FakeAgent, '是实现类的实例');
    assert.ok(ctx.agent instanceof AgentService, '也是 seam 的实例——核心层只按 seam 消费');
    assert.equal(ctx.agent.id, 'fake');
    assert.equal(ctx.agent.label, '假 agent');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('一个 context 只能有一个 agent 实现，重复注册要抛错', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent);

    let threw = false;
    try {
      await ctx.plugin(FakeAgent);
    } catch (e) {
      threw = true;
      assert.match(String(e.message), /agent/, '错误里应当点明是哪个服务位');
    }
    assert.ok(threw, '重复注册必须抛错，不能静默覆盖');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 契约字段 ─────────────────────────

test('请求里的每个契约字段都真的传到了实现', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent);

    const ac = new AbortController();
    const progress = [];
    const files = [{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 3, kind: 'image' }];

    const r = await ctx.agent.run({
      text: '看下这张图',
      files,
      sessionId: 's-9',
      cwd: '/tmp/work',
      onProgress: (l) => progress.push(l),
      signal: ac.signal,
    });

    const seen = ctx.agent.seen.at(-1);
    assert.equal(seen.text, '看下这张图');
    assert.deepEqual(seen.files, files, '附件要原样传下去（多模态后端靠它）');
    assert.equal(seen.sessionId, 's-9', '会话 id 要传下去（续接靠它）');
    assert.equal(seen.cwd, '/tmp/work', '工作目录要传下去');
    assert.equal(typeof seen.onProgress, 'function', '进度回调要传下去');
    assert.equal(seen.signal, ac.signal, '取消信号要传下去');
    assert.deepEqual(progress, ['跑了一半'], '实现调 onProgress 时回调要真的被调到');

    // 返回值也要原样透出
    assert.equal(r.sessionId, 's-9', '传了 sessionId 就沿用');
    assert.equal(r.text, '你好：看下这张图');
    assert.equal(r.files?.[0]?.path, '/tmp/a.png');
    assert.equal(r.files?.[0]?.caption, '你要的文件');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('没传 sessionId 时首次是新会话，实现返回的 id 会被沿用', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent);
    const r = await ctx.agent.run({ text: '第一次', cwd: '/tmp' });
    assert.equal(r.sessionId, 's-1');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('cancellable 由实现自己声明，基类默认 false', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent);
    assert.equal(ctx.agent.cancellable, true, '假实现声明了支持取消');
  } finally {
    await ctx.fiber.dispose();
  }

  const ctx2 = new Context();
  try {
    await ctx2.plugin(MinimalAgent);
    assert.equal(ctx2.agent.cancellable, false, '不声明就是 false——不能假装支持');
    assert.equal(ctx2.agent.label, undefined, '不给 label 就是 undefined，不编造');
  } finally {
    await ctx2.fiber.dispose();
  }
});

// ───────────────────────── 配置 ─────────────────────────

test('Config 的默认值生效，传入值覆盖（解析结果是普通对象）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent, { greeting: '嗨' });

    assert.equal(ctx.agent.config.greeting, '嗨', '传了的要用上');
    assert.equal(ctx.agent.config.delayMs, 0, '没传的拿默认值');
    assert.equal(ctx.agent.config.boom, false);
    // schemastery 解析出来的是普通对象，不是 dsh 那种 .get()
    assert.equal(typeof ctx.agent.config, 'object');
    assert.equal(typeof ctx.agent.config.greeting, 'string');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('异步实现：run 返回 Promise，核心层 await 得到结果', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent, { delayMs: 20 });
    const t0 = Date.now();
    const r = await ctx.agent.run({ text: '慢的', cwd: '/tmp' });
    assert.ok(Date.now() - t0 >= 15, '应当真的等了');
    assert.equal(r.text, '你好：慢的');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 失败 ─────────────────────────

test('实现抛异常时如实冒出来（核心层负责兜住并转述）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeAgent, { boom: true });
    await assert.rejects(
      () => ctx.agent.run({ text: 'x', cwd: '/tmp' }),
      /假 agent 故意炸了/,
      'seam 不吞异常——吞了核心层就没法如实告诉用户',
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('实现返回 error 是正常路径，不是异常', async () => {
  class ErrorAgent extends AgentService {
    id = 'err';
    async run() { return { error: '模型没配 key' }; }
  }

  const ctx = new Context();
  try {
    await ctx.plugin(ErrorAgent);
    const r = await ctx.agent.run({ text: 'x', cwd: '/tmp' });
    assert.equal(r.error, '模型没配 key', 'error 要原样透出，核心层才能如实转述');
    assert.equal(r.text, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── inject 门控与卸载 ─────────────────────────

test('inject 没满足时插件根本不会被构造（这是 cordis 的正确行为）', async () => {
  const ctx = new Context();
  try {
    // 故意不加载 MemoryService
    await ctx.plugin(FakeAgent);
    assert.equal(ctx.agent, undefined, '依赖没满足，服务位不该出现');

    // 依赖到位之后自己出现
    await ctx.plugin(MemoryService);
    assert.ok(ctx.agent, '依赖满足后应当自动就位');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('卸载：服务位消失，effect 里的收尾被执行', async () => {
  const ctx = new Context();
  await ctx.plugin(MemoryService);
  await ctx.plugin(FakeAgent);
  const agent = ctx.agent;

  await ctx.fiber.dispose();
  assert.equal(ctx.agent, undefined, '服务位要消失');
  assert.equal(agent.runCount, -1, 'effect 里的收尾要被执行');
});

test('check 是**可选**的：没实现的大脑照样是合法的大脑', async () => {
  const ctx = new Context();
  await ctx.plugin(MemoryService);   // 夹具 inject 了 memory，缺它根本不会被构造
  await ctx.plugin(FakeAgent);
  try {
    // 这条保证的是"加了这个约定没有把已有实现变成非法"。
    // 真实现（dsh / exec）都实现了它，但**不许**变成必须的。
    assert.equal(ctx.agent.check, undefined);
    assert.equal(typeof ctx.agent.run, 'function', '别的成员一切照旧');
  } finally { await ctx.fiber.dispose(); }
});
