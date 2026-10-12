/**
 * `bridge.mjs` 的测试 —— 全离线，连 DSH 和微信都不需要。
 *
 * 这里验的是**最容易出事的那几件**：谁能使唤这台电脑（认主）、
 * 连发多条会不会打架（排队）、回复带不带引用、出错时人还收不收得到话。
 *
 *   node --test test/bridge.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WELCOME, WechatBridge, buildPrompt, decide } from '../src/bridge.mjs';

// ───────────────────────── 假的通道与状态 ─────────────────────────

function fakeChannel() {
  return {
    sent: [],
    typing: [],
    failSend: false,
    async sendText(to, text, opts) {
      if (this.failSend) throw new Error('发不出去');
      this.sent.push({ to, text, opts });
      return { chunks: 1 };
    },
    async setTyping(to, on, opts) {
      this.typing.push({ to, on, opts });
    },
  };
}

function fakeState(owner = null) {
  return {
    owner,
    writes: [],
    read() {
      return this.owner ? { owner: this.owner } : null;
    },
    write(value) {
      this.owner = value;
      this.writes.push(value);
    },
  };
}

/** 造一个桥：runner 是假的，只记下每轮拿到什么 */
function makeBridge({ config = {}, runner, channel = fakeChannel(), state = fakeState() } = {}) {
  const bridge = new WechatBridge({
    channel,
    agents: {},
    cwd: '/work',
    config,
    state,
    runner: runner ?? (async (_deps, input) => ({ text: `回复：${input.text}` })),
    log: () => {},
  });
  return { bridge, channel, state };
}

const msg = (over = {}) => ({ channel: 'wechat', fromId: 'u1', text: '你好', ...over });

/** 等桥内部的队列跑空（它故意不 await，测试得自己等） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// ───────────────────────── 认主 ─────────────────────────

test('decide：没有主人时，第一个说话的人认主', () => {
  const state = fakeState();
  const verdict = decide(msg({ fromId: 'u9' }), { owners: [], claim: true }, state);
  assert.equal(verdict.action, 'run');
  assert.equal(verdict.claimed, true);
  assert.deepEqual(state.writes, ['u9'], '认主要记下来');
});

test('decide：认主关掉又没配 owner，谁都不服务', () => {
  const state = fakeState();
  const verdict = decide(msg(), { owners: [], claim: false }, state);
  assert.equal(verdict.action, 'ignore');
  assert.deepEqual(state.writes, []);
});

test('主人已经记在文件里了：他自己说话照常跑', async () => {
  const state = fakeState('u1');
  const { bridge, channel } = makeBridge({ state });
  await bridge.handle(msg({ fromId: 'u1', text: '接着干' }));
  assert.equal(channel.sent.at(-1).text, '回复：接着干');
  assert.deepEqual(state.writes, [], '已经有主人就不该再认一次');
});

test('第一条消息：认主 + 回一句开场白 + 照样把这条消息办了', async () => {
  const { bridge, channel, state } = makeBridge();
  await bridge.handle(msg({ fromId: 'u1', text: '帮我看看这个 bug' }));

  assert.deepEqual(state.writes, ['u1']);
  assert.equal(channel.sent.length, 2);
  assert.equal(channel.sent[0].text, WELCOME);
  assert.equal(channel.sent[1].text, '回复：帮我看看这个 bug');
});

test('陌生人：一个字都不回，也不跑 agent', async () => {
  let ran = 0;
  const { bridge, channel } = makeBridge({
    state: fakeState('owner-1'),
    runner: async () => {
      ran += 1;
      return { text: '不该发生' };
    },
  });
  await bridge.handle(msg({ fromId: 'stranger' }));
  assert.equal(ran, 0);
  assert.deepEqual(channel.sent, []);
});

test('配了 owner 就按配置来：连认主都不发生', async () => {
  const { bridge, channel, state } = makeBridge({ config: { owner: ['u7'] } });
  await bridge.handle(msg({ fromId: 'u1' }));
  assert.deepEqual(state.writes, [], '配了 owner 就不该再认别人');
  assert.deepEqual(channel.sent, []);

  await bridge.handle(msg({ fromId: 'u7', text: '我在' }));
  assert.equal(channel.sent.at(-1).text, '回复：我在');
});

// ───────────────────────── 排队 ─────────────────────────

test('同一个人连发三条：串行，顺序不乱', async () => {
  const order = [];
  const gates = [];
  const { bridge } = makeBridge({
    state: fakeState('u1'),
    runner: async (_deps, input) => {
      order.push(`开始 ${input.text}`);
      await new Promise((resolve) => gates.push(resolve));
      order.push(`结束 ${input.text}`);
      return { text: input.text };
    },
  });

  bridge.onMessage(msg({ text: '一' }));
  bridge.onMessage(msg({ text: '二' }));
  bridge.onMessage(msg({ text: '三' }));
  await settle();

  assert.deepEqual(order, ['开始 一'], '第二条必须等第一条跑完');

  gates.shift()();
  await settle();
  assert.deepEqual(order, ['开始 一', '结束 一', '开始 二']);
  gates.shift()();
  await settle();
  assert.deepEqual(order, ['开始 一', '结束 一', '开始 二', '结束 二', '开始 三']);

  gates.shift()();
  await settle();
  assert.deepEqual(order.at(-1), '结束 三');
});

test('两个人同时说话：互不阻塞（各排各的队）', async () => {
  const started = [];
  const gates = [];
  const { bridge } = makeBridge({
    config: { owner: ['u1', 'u2'] },
    runner: async (_deps, input) => {
      started.push(input.text);
      await new Promise((resolve) => gates.push(resolve));
      return { text: input.text };
    },
  });

  bridge.onMessage(msg({ fromId: 'u1', text: '第一个人' }));
  await settle();
  bridge.onMessage(msg({ fromId: 'u2', text: '第二个人' }));
  await settle();
  assert.deepEqual(started, ['第一个人', '第二个人'], '第一个人还挂着，第二个人照样开跑（各排各的队）');

  gates.forEach((resolve) => resolve());
  await settle();
});

// ───────────────────────── 回复的样子 ─────────────────────────

test('回复带上 contextToken 与引用（默认）', async () => {
  const { bridge, channel } = makeBridge({ state: fakeState('u1') });
  await bridge.handle(msg({ text: '这句', contextToken: 'tk-1', quote: '被引用的那句' }));
  const reply = channel.sent.at(-1);
  assert.equal(reply.to, 'u1');
  assert.equal(reply.opts.contextToken, 'tk-1');
  assert.equal(reply.opts.quote, '被引用的那句');
});

test('quoteReply=false 时不带引用', async () => {
  const { bridge, channel } = makeBridge({ state: fakeState('u1'), config: { quoteReply: false } });
  await bridge.handle(msg({ quote: '被引用的那句' }));
  assert.equal(channel.sent.at(-1).opts.quote, undefined);
});

test('typing：一轮前后各发一次（真忙的时候人才知道在干活）', async () => {
  const { bridge, channel } = makeBridge({ state: fakeState('u1') });
  await bridge.handle(msg({ contextToken: 'tk' }));
  assert.deepEqual(
    channel.typing.map((t) => t.on),
    [true, false],
  );
  assert.equal(channel.typing[0].opts.contextToken, 'tk');
});

test('typing=false 时一次都不发', async () => {
  const { bridge, channel } = makeBridge({ state: fakeState('u1'), config: { typing: false } });
  await bridge.handle(msg());
  assert.deepEqual(channel.typing, []);
});

// ───────────────────────── 交给 agent 的话 ─────────────────────────

test('buildPrompt：正文、引用、附件（给本机路径）都在里面', () => {
  const prompt = buildPrompt({
    text: '这张图里的字是什么',
    quote: '上面的那条',
    files: [{ path: '/tmp/a.jpg', name: 'a.jpg', kind: 'image' }],
  });
  assert.match(prompt, /这张图里的字是什么/);
  assert.match(prompt, /上面的那条/);
  assert.match(prompt, /\/tmp\/a\.jpg/);
  assert.match(prompt, /原名 a\.jpg/);
});

test('空消息也有话说（不能把空字符串丢给 agent）', () => {
  assert.equal(buildPrompt({}), '（对方发来一条空消息）');
  assert.equal(buildPrompt({ text: '   ' }), '（对方发来一条空消息）');
});

test('桥把 prompt 原样交给 runner', async () => {
  const seen = [];
  const { bridge } = makeBridge({
    state: fakeState('u1'),
    runner: async (_deps, input) => {
      seen.push(input);
      return { text: 'ok' };
    },
  });
  await bridge.handle(msg({ text: '原文', files: [{ path: '/tmp/x.pdf', kind: 'file' }] }));
  assert.match(seen[0].text, /原文/);
  assert.match(seen[0].text, /\/tmp\/x\.pdf/);
  assert.equal(seen[0].cwd, '/work');
  assert.equal(seen[0].source.kind, 'wechat');
  assert.match(seen[0].sessionId, /^wechat-[0-9a-f]{16}$/);
});

// ───────────────────────── 出错的样子 ─────────────────────────

test('一轮抛错：告诉人出了什么事，通道继续能收下一条', async () => {
  let n = 0;
  const { bridge, channel } = makeBridge({
    state: fakeState('u1'),
    runner: async () => {
      n += 1;
      if (n === 1) throw new Error('模型调用失败');
      return { text: '第二条成功了' };
    },
  });

  await bridge.handle(msg({ text: '第一条' }));
  assert.match(channel.sent.at(-1).text, /我这边出错了：模型调用失败/);

  await bridge.handle(msg({ text: '第二条' }));
  assert.equal(channel.sent.at(-1).text, '第二条成功了');
});

test('一轮没跑完（turn/end 带错误）：把错误原样报给人', async () => {
  const { bridge, channel } = makeBridge({
    state: fakeState('u1'),
    runner: async () => ({ text: '', reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '太频繁了' } } }),
  });
  await bridge.handle(msg());
  assert.match(channel.sent.at(-1).text, /这轮没跑完：RATE_LIMIT: 太频繁了/);
});

test('没有正文也没有错误：说实话，不假装成功', async () => {
  const { bridge, channel } = makeBridge({ state: fakeState('u1'), runner: async () => ({ text: '   ' }) });
  await bridge.handle(msg());
  assert.match(channel.sent.at(-1).text, /没有产出文本/);
});

test('连回话都发不出去时，不能把桥带崩', async () => {
  const channel = fakeChannel();
  channel.failSend = true;
  const { bridge } = makeBridge({ state: fakeState('u1'), channel });
  await bridge.handle(msg()); // 不抛就算过
  assert.deepEqual(channel.sent, []);
});

// ───────────────────────── 卸载 ─────────────────────────

test('dispose 之后不再接新消息', async () => {
  let ran = 0;
  const { bridge } = makeBridge({
    state: fakeState('u1'),
    runner: async () => {
      ran += 1;
      return { text: 'ok' };
    },
  });
  await bridge.dispose();
  await bridge.onMessage(msg());
  assert.equal(ran, 0);
});
