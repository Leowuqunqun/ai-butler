/**
 * `turn.mjs` 的测试 —— 全离线，不需要 DSH。
 *
 * 这里验的是**跟 DSH 打交道的那几步**：会话怎么找、消息长什么样、
 * 回复从哪来、出错时监听器有没有摘干净。假的 agent/session 只实现
 * 真正用到的那么几个方法（`whenIdle` / `followup` / `deriveMessages`），
 * 别的都不假装有 —— 用了不存在的 API 就会红。
 *
 *   node --test test/turn.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  errorTextOf,
  joinText,
  lastAssistantText,
  resolveAgent,
  runTurn,
  sessionIdFor,
  userMessage,
} from '../src/turn.mjs';

// ───────────────────────── 假 DSH ─────────────────────────

class FakeSession {
  constructor(id = 'wechat-x') {
    this.id = id;
    this.seq = 0;
    this.messages = [];
  }
  deriveMessages() {
    return this.messages;
  }
}

class FakeAgent {
  constructor(session) {
    this.session = session;
    this.followups = [];
    this.idles = 0;
    this.onFollowup = null;
  }
  async whenIdle() {
    this.idles += 1;
  }
  followup(message) {
    this.followups.push(message);
    this.onFollowup?.(message);
  }
}

/** 一个能记下所有调用的假 agents 服务 */
function fakeAgents({ live, resumeThrows, onCreate } = {}) {
  const calls = { get: [], resume: [], create: [] };
  return {
    calls,
    get(id) {
      calls.get.push(id);
      return live;
    },
    async resume(options) {
      calls.resume.push(options);
      if (resumeThrows !== false) throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      const session = new FakeSession(options.resumeSessionId);
      return { agent: new FakeAgent(session) };
    },
    async create(options) {
      calls.create.push(options);
      const session = new FakeSession(options.sessionId);
      const agent = new FakeAgent(session);
      onCreate?.(agent);
      return { agent };
    },
  };
}

const model = { currentSelection: () => ({ provider: 'deepseek', model: 'v4-flash', reasoningEffort: 'low' }) };

// ───────────────────────── 小工具 ─────────────────────────

test('sessionIdFor：同一个人永远同一个会话，不同人不同会话', () => {
  const a = sessionIdFor('user-1');
  assert.equal(a, sessionIdFor('user-1'), '确定性');
  assert.notEqual(a, sessionIdFor('user-2'));
  assert.match(a, /^wechat-[0-9a-f]{16}$/);
  // 长的/奇怪的 userId 也压成定长，不会跑出奇怪字符
  assert.match(sessionIdFor('a/b\\c d😀'), /^wechat-[0-9a-f]{16}$/);
});

test('userMessage：形状对齐 DSH 的 createUserMessage', () => {
  const message = userMessage('你好', { kind: 'wechat', from: 'u1' });
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }]);
  assert.deepEqual(message.source, { kind: 'wechat', from: 'u1' });
  assert.ok(Object.isFrozen(message));
  assert.equal(userMessage('x').source.kind, 'wechat', '默认 source 是 wechat');
});

test('userMessage：能无损过 JSON（DSH 写事件时会当场校验，undefined 会被拒）', () => {
  // 真机探针抓出来的教训：DSH 的 snapshotJsonValue 要求数据能无损 JSON 往返。
  // `{ messageId: undefined }` 这种键 stringify 之后会消失，于是整条事件被拒：
  //   session event "agent/inbox/spliced" carries non-JSON-serializable data
  const message = userMessage('正文', { kind: 'wechat', from: 'u1', messageId: undefined, extra: undefined });
  assert.deepEqual(Object.keys(message.source), ['kind', 'from'], 'undefined 值的键必须被丢掉');

  // 无损判据：往返之后一模一样（DSH 的校验就是这个意思）
  const roundTrip = JSON.parse(JSON.stringify(message));
  assert.deepEqual(roundTrip, { ...message });
  assert.equal(JSON.stringify(roundTrip), JSON.stringify(message));
});

test('joinText：只要文本块，工具调用块被略过', () => {
  assert.equal(joinText([{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(joinText(undefined), '');
  assert.equal(joinText([{ type: 'text', text: 42 }]), '');
});

test('lastAssistantText：倒着找最后一条有正文的 assistant', () => {
  const session = new FakeSession();
  session.messages = [
    { role: 'user', content: [{ type: 'text', text: '问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一版' }] },
    { role: 'assistant', content: [{ type: 'text', text: '   ' }] },
    { role: 'assistant', content: [{ type: 'text', text: '最后这版' }] },
  ];
  assert.equal(lastAssistantText(session), '最后这版');
  session.messages = [{ role: 'user', content: [{ type: 'text', text: '只有问' }] }];
  assert.equal(lastAssistantText(session), '');
});

test('errorTextOf：只有真错误才给文本', () => {
  assert.equal(errorTextOf({ kind: 'completed' }), '');
  assert.equal(errorTextOf(undefined), '');
  assert.equal(errorTextOf({ kind: 'error', error: { code: 'X', message: '炸了' } }), 'X: 炸了');
});

// ───────────────────────── resolveAgent ─────────────────────────

test('resolveAgent：活着就直接用，不 create 不 resume', async () => {
  const live = new FakeAgent(new FakeSession('wechat-1'));
  const agents = fakeAgents({ live });
  const { agent, how } = await resolveAgent({ agents, model }, { sessionId: 'wechat-1', cwd: '/tmp' });
  assert.equal(agent, live);
  assert.equal(how, 'live');
  assert.deepEqual(agents.calls.create, []);
  assert.deepEqual(agents.calls.resume, []);
});

test('resolveAgent：没有活的就 resume（接上上次的上下文）', async () => {
  const agents = fakeAgents({ resumeThrows: false });
  const { how } = await resolveAgent({ agents, model }, { sessionId: 'wechat-2', cwd: '/tmp' });
  assert.equal(how, 'resume');
  assert.equal(agents.calls.resume[0].resumeSessionId, 'wechat-2');
  assert.equal(agents.calls.create.length, 0);
});

test('resolveAgent：resume 说没有这份会话，就新建（第一次说话的正常路径）', async () => {
  const agents = fakeAgents({ resumeThrows: true });
  const { how } = await resolveAgent({ agents, model }, { sessionId: 'wechat-3', cwd: '/work' });
  assert.equal(how, 'create');
  const options = agents.calls.create[0];
  assert.equal(options.sessionId, 'wechat-3');
  assert.equal(options.meta.cwd, '/work');
  assert.deepEqual(options.agentOptions, { provider: 'deepseek', model: 'v4-flash' });
});

// ───────────────────────── runTurn ─────────────────────────

test('runTurn：把话交给 agent，从实时事件里取回复', async () => {
  const handlers = [];
  let created;
  const agents = fakeAgents({
    onCreate: (agent) => {
      created = agent;
      agent.onFollowup = () => {
        // DSH 会通过 session/event 把这一轮的 assistant 消息送出来
        agent.session.seq += 2;
        handlers.forEach((h) => h(agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到，已经改好了' }] } } }));
        handlers.forEach((h) => h(agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } }));
      };
    },
  });
  const flushes = [];
  const result = await runTurn(
    {
      agents,
      sessions: { flush: async (s) => flushes.push(s) },
      model,
      onEvent: (handler) => {
        handlers.push(handler);
        return () => handlers.splice(handlers.indexOf(handler), 1);
      },
      log: () => {},
    },
    { sessionId: 'wechat-9', text: '把标题改成蓝色', cwd: '/w', source: { kind: 'wechat', from: 'u9' } },
  );

  assert.equal(result.text, '收到，已经改好了');
  assert.equal(result.how, 'create');
  assert.equal(result.reason.kind, 'completed');

  assert.equal(created.followups.length, 1, '话真的交给了 agent');
  assert.deepEqual(created.followups[0].content, [{ type: 'text', text: '把标题改成蓝色' }]);
  assert.ok(created.idles >= 2, '跑之前与跑之后各等一次 idle');
  assert.equal(flushes.length, 1, '跑完要 flush 一次（尽量落盘）');
  assert.equal(handlers.length, 0, '一轮结束必须摘掉监听器');
});

test('runTurn：消息真的送到了 agent 手里，source 带上微信身份', async () => {
  let seen;
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('nope');
    },
    create: async (options) => {
      const agent = new FakeAgent(new FakeSession(options.sessionId));
      agent.onFollowup = (message) => {
        seen = message;
      };
      return { agent };
    },
  };
  await runTurn({ agents, model, log: () => {} }, { sessionId: 's', text: 'hello', cwd: '/w', source: { kind: 'wechat', from: 'u1' } });
  assert.equal(seen.role, 'user');
  assert.deepEqual(seen.content, [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(seen.source, { kind: 'wechat', from: 'u1' });
});

test('runTurn：实时事件没收到东西，退回去从会话里推导（deriveMessages）', async () => {
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('nope');
    },
    create: async (options) => {
      const agent = new FakeAgent(new FakeSession(options.sessionId));
      agent.onFollowup = () => {
        agent.session.messages = [
          { role: 'user', content: [{ type: 'text', text: '问' }] },
          { role: 'assistant', content: [{ type: 'text', text: '兜底拿到的正文' }] },
        ];
      };
      return { agent };
    },
  };
  const result = await runTurn({ agents, model, log: () => {} }, { sessionId: 's', text: 'x', cwd: '/w' });
  assert.equal(result.text, '兜底拿到的正文');
});

test('runTurn：一轮失败也要摘掉监听器（不能留在 ctx 上）', async () => {
  const handlers = [];
  const agents = {
    get: () => undefined,
    resume: async () => {
      throw new Error('nope');
    },
    create: async (options) => {
      const agent = new FakeAgent(new FakeSession(options.sessionId));
      agent.onFollowup = () => {
        throw new Error('followup 炸了');
      };
      return { agent };
    },
  };
  await assert.rejects(
    runTurn(
      {
        agents,
        model,
        onEvent: (handler) => {
          handlers.push(handler);
          return () => handlers.splice(handlers.indexOf(handler), 1);
        },
        log: () => {},
      },
      { sessionId: 's', text: 'x', cwd: '/w' },
    ),
    /followup 炸了/,
  );
  assert.equal(handlers.length, 0, '失败路径也要摘干净');
});
