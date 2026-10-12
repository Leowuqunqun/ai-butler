/**
 * seam-link 的测试 —— 验证"这个能力位真的能被实现、被消费"。
 *
 * 被测对象是**编译产物**（lib/），也就是说测试跑的是消费者拿到的那份东西。
 * 假链路用 TypeScript 写在 test/fixtures/，先编译再加载：
 * 这样类型契约（抽象成员有没有漏）和运行行为一起被验证。
 *
 *   node --test test/seam.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { LinkService } from '@butler/seam-link';
import { FakeLink, MemoryService } from './.build/fake-link.js';

/**
 * 只实现抽象成员的最小链路。
 *
 * 它的存在意义只有一个：**证明 `check?()` 是可选的** ——
 * 用实现了 check 的 FakeLink 去验这件事是验不出来的（它当然有）。
 */
class MinimalLink extends LinkService {
  id = 'minimal';
  async discover() { return []; }
  async connect(deviceId) {
    return {
      deviceId,
      request: async () => ({}),
      onClose: () => () => {},
      close: async () => {},
    };
  }
}

// ───────────────────────── 加载与身份 ─────────────────────────

test('实现类作为 cordis 插件加载后，ctx.link 就位且双身份成立', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, { secret: 's3' });

    assert.ok(ctx.link, 'ctx.link 必须就位');
    assert.ok(ctx.link instanceof FakeLink, '是实现类的实例');
    assert.ok(ctx.link instanceof LinkService, '也是 seam 的实例——中枢只按 seam 消费');
    assert.equal(ctx.link.id, 'fake');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约方法转发到实现', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, { peers: [{ id: 'node-home', alias: '家里那台', host: '10.0.0.9' }] });

    const devices = await ctx.link.discover();
    assert.ok(devices.some((d) => d.id === 'node-home'), '静态节点表要进结果');

    const session = await ctx.link.connect('node-home');
    assert.equal(session.deviceId, 'node-home');
    assert.equal(ctx.link.sessions.length, 1, '会话要落在实现上');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── discover 的语义 ─────────────────────────

test('discover：看得见 ≠ 连得上，online 和 lastSeen 是两件事', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});

    const devices = await ctx.link.discover();
    const far = devices.find((d) => d.id === 'node-far');

    // 它照样出现在结果里（看得见），只是 online: false。
    // 这条是 seam 的约定：discover 不许阻塞等某台机器上线。
    assert.ok(far, '连不上的设备也要出现在结果里');
    assert.equal(far.online, false);
    assert.equal(far.lastSeen, null, '从没听到过就是 null，不是 0');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('discover：看得见的设备带 id/alias/os/capabilities/link 五要素', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, { peers: [{ id: 'node-home', alias: '家里那台', host: '10.0.0.9', port: 9000 }] });

    const home = (await ctx.link.discover()).find((d) => d.id === 'node-home');
    assert.equal(home.alias, '家里那台');
    assert.equal(home.os, 'linux');
    assert.deepEqual(home.capabilities, ['agent']);
    assert.equal(home.link, 'fake', '要说是从哪条链路看见的');
    assert.equal(typeof home.lastSeen, 'number', '听见了就有时间戳');
    assert.equal(home.online, true);
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── 会话 ─────────────────────────

test('request：进度回流到**这一次请求**的 onEvent，返回值就是结果', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});
    const session = await ctx.link.connect('node-home');

    const events = [];
    const result = await session.request('agent.run', { text: '整理桌面' }, {
      onEvent: (e) => events.push(e),
    });

    assert.deepEqual(result, { ok: true, method: 'agent.run' });
    assert.deepEqual(events.map((e) => e.type), ['progress', 'done'], '进度先来，结果最后');
    assert.equal(events[0].line, '正在干活');
    assert.deepEqual(session.calls[0], { method: 'agent.run', params: { text: '整理桌面' } });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('事件都带 callId —— 一次会话上跑多个调用也不会串话', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});
    const session = await ctx.link.connect('node-home');

    const events = [];
    await session.request('a.one', {}, { onEvent: (e) => events.push(e) });
    await session.request('b.two', {}, { onEvent: (e) => events.push(e) });

    assert.ok(events.length >= 4);
    for (const e of events) {
      assert.equal(typeof e.callId, 'string', `事件 ${e.type} 缺 callId`);
      assert.ok(e.callId.length > 0);
    }
    // 两条调用的 callId 不同源 —— 中枢才能把进度归对人
    assert.notEqual(events[0].callId, events[2].callId);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('不传 onEvent 也能正常拿到结果（进度是可选能力，不是必须的）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});
    const session = await ctx.link.connect('node-home');

    const r = await session.request('agent.run', {});
    assert.deepEqual(r, { ok: true, method: 'agent.run' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('connect 连不上要**抛**，不是返回一个半死的会话', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});

    // 这条保证的是失败**当场**暴露，而不是拖到第一次 request 才暴露；
    // 中间那段时间调用方会以为一切正常。
    await assert.rejects(async () => ctx.link.connect('node-far'), /连不上/);
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── onClose / close ─────────────────────────

test('onClose：订阅、取消订阅、掉线回调', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});
    const session = await ctx.link.connect('node-home');

    const seen = [];
    const off = session.onClose((reason) => seen.push(reason));

    session.drop('网络断了');
    assert.deepEqual(seen, ['网络断了']);

    off();
    session.drop('又断了一次');
    assert.deepEqual(seen, ['网络断了'], '取消订阅之后不该再收到');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('close：幂等，重复关不会重复回调 onClose', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, {});
    const session = await ctx.link.connect('node-home');

    let closed = 0;
    session.onClose(() => { closed += 1; });

    await session.close();
    await session.close();
    await session.close();

    assert.equal(session.closed, 1, '重复调用只该真的关一次');
    assert.equal(closed, 1, 'onClose 也只该响一次');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── static Config ─────────────────────────

test('static Config：默认值生效、传入值覆盖，且解析成普通对象', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink, { secret: 'only-this' });

    const cfg = ctx.link.config;
    assert.equal(cfg.secret, 'only-this', '传了的字段要覆盖默认值');
    assert.deepEqual(cfg.peers, [], '未传的字段要拿到 schema 默认值');
    // 本项目的用法：cordis 4 + schemastery 解析出来就是普通值，不需要 .get()
    assert.equal(typeof cfg.secret, 'string');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── static inject 门控 ─────────────────────────

test('static inject：依赖没就位时服务不出现，补上后自动就位', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeLink, {});
    assert.equal(ctx.link, undefined, '依赖缺失时不该注册服务位');

    await ctx.plugin(MemoryService);
    assert.ok(ctx.link instanceof FakeLink, '依赖到位后应自动注册');
  } finally {
    await ctx.fiber.dispose();
  }
});

// ───────────────────────── check 可选 / 卸载 ─────────────────────────

test('check 是**可选**的：没实现的链路照样是合法的链路', async () => {
  const ctx = new Context();
  try {
    // 这里**必须**用 MinimalLink，不能用 FakeLink —— 后者实现了 check，
    // 拿它去验"可选"是自欺欺人（断言必然失败，而且失败原因跟契约无关）。
    await ctx.plugin(MinimalLink);
    // 这条保证的是"加了这个约定没有把已有实现变成非法"。
    // 真实现（link-lan）实现了它，但**不许**变成必须的。
    assert.equal(ctx.link.check, undefined);
    assert.equal(typeof ctx.link.discover, 'function', '别的成员一切照旧');
  } finally { await ctx.fiber.dispose(); }
});

test('check：实现在就能被 doctor 拿到，且形状与别的 seam 相同', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(MemoryService);
    await ctx.plugin(FakeLink);
    ctx.link.checks = [
      { name: '和家里那台的链路', ok: true, detail: '看得见 2 台' },
      { name: '共享密钥', ok: false, detail: '没配', fix: '在配置里填上 secret' },
    ];

    const items = await ctx.link.check();
    assert.equal(items.length, 2);
    assert.equal(items[1].ok, false);
    assert.ok(items[1].fix, '没过的检查必须带 fix');
  } finally { await ctx.fiber.dispose(); }
});

test('卸载：服务位消失，实现与依赖的清理都执行', async () => {
  const ctx = new Context();
  const mem = new MemoryService(ctx);
  await ctx.plugin(FakeLink, {});

  const link = ctx.link;
  const session = await link.connect('node-home');
  const seen = [];
  session.onClose((r) => seen.push(r));

  await ctx.fiber.dispose();

  assert.equal(ctx.link, undefined, '卸载后服务位要消失');
  assert.equal(mem.disposed, true, '依赖服务的清理也要被执行');
});
