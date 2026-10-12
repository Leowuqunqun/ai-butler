/**
 * `plugin.mjs` 的测试 —— **真 cordis、真微信通道类**，只有 DSH 是假的。
 *
 * 为什么要这么较真：这个包里最容易"装上了却起不来"的地方，不是业务逻辑，
 * 而是**接线**——`ctx.plugin(通道类)` 能不能在真容器里挂上、Config 会不会被
 * 校验、`ctx.get('channel')` 拿不拿得到、消息会不会真的走到 agent。
 * 这些只有把真容器拉起来才验得到，所以这里：
 *
 *   - 真 `new Context()`（cordis 4，跟 DSH 里跑的是同一个包）
 *   - 真 `WechatChannel`（微信通道类，从 wechat-agent-bridge import）
 *   - 假 DSH：只实现我们真正用到的 `ctx.agents` / `ctx.sessions` / `ctx.agentDefaultModel`
 *
 * 两处故意"作弊"，都是为了**不出网**：
 *   - `autostart: false`：不启动通道 = 不会去登录微信、不会起长轮询；
 *   - 把 `channel.sendText` 换成记录器：否则它会拿空 token 去请求真的 iLink 服务。
 *     收信那半边（`emitMessage` → 我们的桥）全程是真的。
 *
 *   node --test test/plugin.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context, Service } from '@deepseek-ai/cordis';
import { WechatChannel } from 'wechat-agent-bridge';

import { Config, apply, inject, name } from '../src/plugin.mjs';
import { ownerState } from '../src/bridge.mjs';
import { sessionIdFor } from '../src/turn.mjs';

// ───────────────────────── 假 DSH（只有这三个服务） ─────────────────────────

class FakeAgents extends Service {
  constructor(ctx) {
    super(ctx, 'agents');
    this.created = [];
    this.resumed = [];
    this.followups = [];
    this.live = new Map();
  }
  /** 真 DSH 里 `create` 出来的 agent 就是"活着的" —— 假的也要这样，否则会一直新建 */
  get(id) {
    return this.live.get(id);
  }
  async resume(options) {
    this.resumed.push(options);
    throw Object.assign(new Error('没有这份会话'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
  }
  async create(options) {
    this.created.push(options);
    const session = {
      id: options.sessionId,
      seq: 0,
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '假 agent 的回复' }] }],
    };
    const agent = {
      session,
      whenIdle: async () => {},
      followup: (message) => this.followups.push(message),
    };
    this.live.set(options.sessionId, agent);
    return { agent };
  }
}

class FakeSessions extends Service {
  constructor(ctx) {
    super(ctx, 'sessions');
    this.flushed = [];
  }
  async flush(session) {
    this.flushed.push(session);
  }
}

class FakeModel extends Service {
  constructor(ctx) {
    super(ctx, 'agentDefaultModel');
  }
  currentSelection() {
    return { provider: 'fake-provider', model: 'fake-model' };
  }
}

/** 已经占着通道位的假通道（用来验"不能有两个通道"） */
class FakeChannel extends Service {
  constructor(ctx) {
    super(ctx, 'channel');
  }
}

/** 把三个假服务挂起来，返回 ctx */
async function fakeHost() {
  const ctx = new Context();
  await ctx.plugin(FakeAgents);
  await ctx.plugin(FakeSessions);
  await ctx.plugin(FakeModel);
  return ctx;
}

/** 轮询等一个条件成立（桥故意不 await，测试得自己等） */
async function waitFor(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等超时了：条件一直没成立');
}

/** 临时状态目录 */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-plugin-test-'));
}

// ───────────────────────── 契约 ─────────────────────────

test('插件契约：名字、依赖、配置默认值', () => {
  assert.equal(name, 'butler-wechat');
  // 只依赖 dsh-base 里就有的服务 —— web profile 和 headless profile 都能挂。
  // 依赖 sessionController / workspaceRegistry / webServer 的话就只有 web 能用了。
  assert.deepEqual([...inject].sort(), ['agentDefaultModel', 'agents', 'sessions']);

  const defaults = Config({});
  assert.equal(defaults.autostart, true);
  assert.equal(defaults.claim, true);
  assert.equal(defaults.typing, true);
  assert.equal(defaults.quoteReply, true);
  assert.equal(defaults.qrPage, true);
  assert.equal(defaults.qrPort, 8099);
  assert.deepEqual(defaults.owner, []);

  assert.equal(Config({ owner: ['u1'], qrPort: 9001 }).owner[0], 'u1');
  assert.throws(() => Config({ qrPort: 'not-a-number' }), '类型不对要拦住');
});

// ───────────────────────── 真挂一次 ─────────────────────────

test('真挂一次：通道进来、消息一路走到 agent、回复往回送', async () => {
  const home = tempHome();
  const ctx = await fakeHost();
  await ctx.plugin({ name, inject, Config, apply }, { home, autostart: false, cwd: '/work' });

  const channel = ctx.get('channel');
  assert.ok(channel instanceof WechatChannel, '通道真的挂上了（ctx.channel 是我们的通道）');
  assert.equal(channel.started, false, 'autostart=false 就不该开始收信');

  // 出网那一步换掉（不然它会拿空 token 去请求真的 iLink 服务）
  const sent = [];
  channel.sendText = async (to, text, opts) => {
    sent.push({ to, text, opts });
    return { chunks: 1 };
  };
  channel.setTyping = async () => {};

  // 微信来了一条消息
  channel.emitMessage({ channel: 'wechat', fromId: 'u1', text: '帮我把标题改成蓝色', contextToken: 'tk-1' });
  await waitFor(() => ctx.agents.followups.length > 0);

  // 认主：第一条消息的人成为主人，并且被记在状态目录里
  assert.equal(ownerState(home).read()?.owner, 'u1');
  assert.equal(sent[0].text.includes('认主'), true, '第一条先回开场白');

  // 会话：按人固定，工作目录来自配置
  assert.equal(ctx.agents.created.length, 1);
  assert.equal(ctx.agents.created[0].sessionId, sessionIdFor('u1'));
  assert.equal(ctx.agents.created[0].meta.cwd, '/work');
  assert.deepEqual(ctx.agents.created[0].agentOptions, { provider: 'fake-provider', model: 'fake-model' });

  // 话真的进了 agent，且带着微信身份
  assert.deepEqual(ctx.agents.followups[0].content, [{ type: 'text', text: '帮我把标题改成蓝色' }]);
  assert.equal(ctx.agents.followups[0].source.kind, 'wechat');

  // 回复回到了微信那头（假 agent 走兜底路径拿到正文）
  await waitFor(() => sent.length >= 2);
  assert.equal(sent.at(-1).to, 'u1');
  assert.equal(sent.at(-1).text, '假 agent 的回复');
  assert.equal(sent.at(-1).opts.contextToken, 'tk-1');
  assert.equal(ctx.sessions.flushed.length, 1, '跑完 flush 一次');

  rmSync(home, { recursive: true, force: true });
});

test('同一个人的第二条消息：复用同一个会话，不再新建', async () => {
  const home = tempHome();
  const ctx = await fakeHost();
  await ctx.plugin({ name, inject, Config, apply }, { home, autostart: false });
  const channel = ctx.get('channel');
  channel.sendText = async () => ({ chunks: 1 });
  channel.setTyping = async () => {};

  channel.emitMessage({ channel: 'wechat', fromId: 'u1', text: '第一句' });
  await waitFor(() => ctx.agents.followups.length === 1);
  channel.emitMessage({ channel: 'wechat', fromId: 'u1', text: '第二句' });
  await waitFor(() => ctx.agents.followups.length === 2);

  assert.equal(ctx.agents.created.length, 1, '第二句不该再建会话');
  assert.equal(ctx.agents.created[0].sessionId, sessionIdFor('u1'));
  assert.equal(ctx.agents.followups[1].content[0].text, '第二句');

  rmSync(home, { recursive: true, force: true });
});

test('已经有别的通道了：报一句人能看懂的话，而不是 cordis 的重复服务错误', async () => {
  const home = tempHome();
  const ctx = await fakeHost();
  await ctx.plugin(FakeChannel);
  await assert.rejects(async () => {
    await ctx.plugin({ name, inject, Config, apply }, { home, autostart: false });
  }, /已经有一个通道/);
  rmSync(home, { recursive: true, force: true });
});
