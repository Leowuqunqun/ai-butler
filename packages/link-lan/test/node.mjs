/**
 * NodeService（节点侧）的测试 —— 全部离线，跑在 127.0.0.1 上。
 *
 * 这里验的是一件完整的事：**中枢连过来，本机的 agent 真的干活，进度和结果真的回去**。
 * 假 agent 用 JS 直接继承 `AgentService`：抽象成员漏了就报错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Server } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { NodeService } from '@butler/link-lan/node';
import { LanSession, LanLink } from '@butler/link-lan';

const SECRET = 'a-long-enough-secret-for-tests';

/** 假 agent：把收到的请求原样记下来，按脚本回流进度和结果 */
class FakeAgent extends AgentService {
  id = 'fake';
  cancellable = true;
  seen = [];
  /** 下一次 run 要返回什么 */
  reply = { text: '干完了' };
  /** 进度行 */
  lines = ['在找那个文件夹'];
  /** 挂住不返回，直到 signal 触发 */
  hang = false;

  async run(req) {
    this.seen.push(req);
    for (const line of this.lines) req.onProgress?.(line);
    if (this.hang) {
      return new Promise((resolve) => {
        req.signal?.addEventListener('abort', () => resolve({ text: '被取消了' }));
      });
    }
    return { sessionId: `s-${this.seen.length}`, ...this.reply };
  }
}

/**
 * 起一个容器：假 agent + 节点服务。
 *
 * 假 agent **通过 `ctx.plugin` 装载**（不是 `new FakeAgent(ctx)`）——
 * 只有这样，`static inject` 那道门控才是真的被测到。
 */
async function withNode(config = {}, fn) {
  const ctx = new Context();
  // 身份文件写到临时目录 —— 测试跑在真 $HOME 上的话会往用户家里写东西
  const home = mkdtempSync(join(tmpdir(), 'butler-node-home-'));
  try {
    await ctx.plugin(FakeAgent);
    await ctx.plugin(NodeService, {
      id: 'node-home', alias: '家里那台', secret: SECRET, port: 0,
      identityFile: join(home, 'node.json'),
      ...config,
    });
    await ctx.node.start();
    return await fn({ ctx, agent: ctx.agent, node: ctx.node });
  } finally {
    await ctx.fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  }
}

/** 这类用例不关心身份，但**不能让节点往真实 $HOME 里写** */
const throwawayIdentity = () => join(mkdtempSync(join(tmpdir(), 'butler-node-home-')), 'node.json');

const clientFor = (node) => new LanSession('node-home', `http://127.0.0.1:${node.address.port}`, SECRET);

// ───────────────────────── 门控与配置 ─────────────────────────

test('static inject：没有 agent 的机器上，节点服务根本不会被构造', async () => {
  const ctx = new Context();
  try {
    // 只装节点，不装 agent —— 就该什么都没有
    await ctx.plugin(NodeService, { id: 'node-home', secret: SECRET, identityFile: throwawayIdentity() });
    assert.equal(ctx.node, undefined, '没有人干活的节点不该出现');

    // 依赖到位 → 先前那次注册自动就位（不用重新注册）
    await ctx.plugin(FakeAgent);
    assert.ok(ctx.node instanceof NodeService, 'agent 到位后节点才该出现');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('构造：id 和密钥都可以不写 —— 节点自己生成，上岗时**存下来**', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-identity-'));
  const file = join(dir, 'node.json');
  try {
    // ① 只是**装载**（比如 doctor）不该在用户家里造文件出来
    const peek = new Context();
    await peek.plugin(FakeAgent);
    await peek.plugin(NodeService, { identityFile: file });
    assert.equal(existsSync(file), false, '装载 ≠ 上线，连文件系统也算上');
    await peek.fiber.dispose();

    // ② 真上岗了才落盘
    const ctx = new Context();
    await ctx.plugin(FakeAgent);
    await ctx.plugin(NodeService, { identityFile: file, port: 0 });
    const first = { ...ctx.node.identity };
    await ctx.node.start();
    assert.match(first.id, /^node-[0-9a-f]{6}$/, 'id 长得像 node-3f9a1c');
    assert.ok(first.secret.length >= 32, '自己生成的密钥不能短');
    assert.ok(existsSync(file), '上岗之后身份必须落盘');
    await ctx.fiber.dispose();

    // ③ 再起一次：**同一个身份**。不然中枢那边配过的关系每次重启都断
    const ctx2 = new Context();
    await ctx2.plugin(FakeAgent);
    await ctx2.plugin(NodeService, { identityFile: file, port: 0 });
    assert.deepEqual(ctx2.node.identity, first);
    await ctx2.fiber.dispose();

    // ④ 权限 0600：这份文件里躺着一把能遥控这台电脑的密钥
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `身份文件权限应该是 0600，实际 ${mode.toString(8)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('构造：配置里的 id 跟存下来的对不上，当场拦住并说清楚怎么办', async () => {
  // 悄悄按配置改掉的话，中枢那边记着的还是老 id，现象是"那台电脑不见了"，
  // 而且没有任何线索 —— 宁可不启动。
  const dir = mkdtempSync(join(tmpdir(), 'butler-identity-'));
  const file = join(dir, 'node.json');
  try {
    const ctx = new Context();
    await ctx.plugin(FakeAgent);
    await ctx.plugin(NodeService, { id: 'node-home', identityFile: file, port: 0 });
    await ctx.node.start();
    await ctx.fiber.dispose();

    const ctx2 = new Context();
    await ctx2.plugin(FakeAgent);
    await assert.rejects(
      async () => { await ctx2.plugin(NodeService, { id: 'node-office', identityFile: file, port: 0 }); },
      /id 一旦定下就别改/,
    );
    await ctx2.fiber.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('构造：配置里写了 id 和密钥，就照配置的用（手写配置仍然算数）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-identity-'));
  try {
    const ctx = new Context();
    await ctx.plugin(FakeAgent);
    await ctx.plugin(NodeService, { id: 'node-home', secret: SECRET, identityFile: join(dir, 'node.json') });
    assert.deepEqual(ctx.node.identity, { id: 'node-home', secret: SECRET });
    await ctx.fiber.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start 幂等；alias 不给就用主机名', async () => {
  await withNode({ port: 0 }, async ({ node }) => {
    const port = node.address.port;
    await node.start();
    assert.equal(node.address.port, port, '重复 start 不该起第二个监听');
    assert.equal(node.listening, true);
    assert.ok(node.alias.length > 0, 'alias 没配就落到主机名，不能是空字符串');
  });
});

// ───────────────────────── 端到端 ─────────────────────────

test('端到端：中枢连过来，本机 agent 干活，进度和结果都回去', async () => {
  await withNode({ cwd: '/tmp' }, async ({ node, agent }) => {
    const session = clientFor(node);
    const events = [];
    const result = await session.request('agent.run', { text: '整理桌面' }, { onEvent: (e) => events.push(e) });

    assert.equal(result.text, '干完了');
    assert.deepEqual(events.map((e) => e.type), ['progress', 'done']);
    assert.deepEqual(events[0].line, '在找那个文件夹');

    assert.equal(agent.seen.length, 1);
    assert.equal(agent.seen[0].text, '整理桌面');
    assert.equal(agent.seen[0].cwd, '/tmp', '中枢没指定工作目录就用本机配的');
    await session.close();
  });
});

test('端到端：中枢指定的 cwd 优先于本机配置', async () => {
  await withNode({ cwd: '/tmp' }, async ({ node, agent }) => {
    const session = clientFor(node);
    await session.request('agent.run', { text: 'x', cwd: '/别的目录' });
    assert.equal(agent.seen[0].cwd, '/别的目录');
    await session.close();
  });
});

test('端到端：sessionId 透过去、带回来 —— 会话状态由**中枢**记，节点不记', async () => {
  await withNode({}, async ({ node, agent }) => {
    const session = clientFor(node);

    const first = await session.request('agent.run', { text: '第一句' });
    assert.equal(agent.seen[0].sessionId, null, '第一次是 null');
    assert.equal(first.sessionId, 's-1');

    const second = await session.request('agent.run', { text: '第二句', sessionId: first.sessionId });
    assert.equal(agent.seen[1].sessionId, 's-1', '中枢把上次的 id 带回来了');
    assert.equal(second.sessionId, 's-2');
    await session.close();
  });
});

// ───────────────────────── 远端产出的文件：铸凭证 + 按块取回 ─────────────────────────

test('端到端：**附件不能透传路径**，只给一张取件凭证', async () => {
  await withNode({}, async ({ node, agent }) => {
    agent.reply = {
      text: '生成好了',
      files: [{ path: '/home/leo/报表.xlsx', name: '报表.xlsx', size: 12, mime: 'application/x' }],
    };

    const session = clientFor(node);
    const result = await session.request('agent.run', { text: '做个报表' });

    assert.equal(result.text, '生成好了');
    assert.equal(typeof result.files?.[0]?.token, 'string', '要铸一张凭证');
    assert.equal(result.files[0].name, '报表.xlsx');
    assert.equal(JSON.stringify(result).includes('/home/leo'), false,
      '**报出去的那份里一个路径片段都不能有** —— 那台机器上的目录结构不该外泄');
    await session.close();
  });
});

test('端到端：拿凭证真的能把文件取回来（分块、内容一致）', async () => {
  await withNode({}, async ({ node, agent }) => {
    const body = Buffer.alloc(512 * 1024 + 300, 0x42);      // 刚过一个块，逼出第二次取件
    const file = join(tmpdir(), `butler-node-${randomBytes(4).toString('hex')}.bin`);
    writeFileSync(file, body);
    try {
      agent.reply = { text: '好了', files: [{ path: file, name: '大文件.bin' }] };

      const session = clientFor(node);
      const run = await session.request('agent.run', { text: '发我那个大文件' });
      const token = run.files[0].token;

      const chunks = [];
      let offset = 0;
      for (;;) {
        const c = await session.request('file.read', { token, offset });
        assert.equal(c.size, body.length, '每次都要报总大小，中枢才好播报进度');
        if (c.data) chunks.push(Buffer.from(c.data, 'base64'));
        offset += c.data ? Buffer.from(c.data, 'base64').length : 0;
        if (c.eof) break;
      }

      assert.deepEqual(Buffer.concat(chunks), body, '取回来的字节要跟那台机器上一模一样');
      await session.close();
    } finally {
      rmSync(file, { force: true });
    }
  });
});

test('凭证用完就还：file.drop 之后再也取不到', async () => {
  await withNode({}, async ({ node, agent }) => {
    const file = join(tmpdir(), `butler-node-${randomBytes(4).toString('hex')}.txt`);
    writeFileSync(file, '内容');
    try {
      agent.reply = { text: '好了', files: [{ path: file, name: 'a.txt' }] };
      const session = clientFor(node);
      const run = await session.request('agent.run', { text: '发个文件' });
      const token = run.files[0].token;

      assert.equal((await session.request('file.read', { token })).data, Buffer.from('内容').toString('base64'));
      await session.request('file.drop', { token });
      await assert.rejects(() => session.request('file.read', { token }), /取件凭证已经失效/);
      await session.close();
    } finally {
      rmSync(file, { force: true });
    }
  });
});

test('不认识的凭证：说人话，而且不区分"没铸过"和"过期了"（别当探测工具）', async () => {
  await withNode({}, async ({ node }) => {
    const session = clientFor(node);
    await assert.rejects(
      () => session.request('file.read', { token: 'deadbeef' }),
      /取件凭证已经失效/,
    );
    await session.close();
  });
});

test('凭证会过期：十分钟没人来取就作废', async () => {
  await withNode({}, async ({ node, agent }) => {
    const file = join(tmpdir(), `butler-node-${randomBytes(4).toString('hex')}.txt`);
    writeFileSync(file, '内容');
    const realNow = Date.now;
    try {
      agent.reply = { text: '好了', files: [{ path: file, name: 'a.txt' }] };
      const session = clientFor(node);
      const token = (await session.request('agent.run', { text: '发个文件' })).files[0].token;
      assert.equal(node.offerCount, 1);

      Date.now = () => realNow() + 11 * 60_000;         // 十一分钟后再来
      assert.equal(node.offerCount, 0, '过期的凭证该被清掉，不能在内存里越积越多');
      await assert.rejects(() => session.request('file.read', { token }), /取件凭证已经失效/);
      await session.close();
    } finally {
      Date.now = realNow;
      rmSync(file, { force: true });
    }
  });
});

test('agent 交出来的文件其实不在了：说清楚是哪一个、为什么', async () => {
  await withNode({}, async ({ node, agent }) => {
    agent.reply = { text: '好了', files: [{ path: '/tmp/这个文件真的不存在-zzz.xlsx', name: '报表.xlsx' }] };
    const session = clientFor(node);
    const token = (await session.request('agent.run', { text: '发个文件' })).files[0].token;

    await assert.rejects(
      () => session.request('file.read', { token }),
      (e) => /报表\.xlsx/.test(e.message) && /已经没有这个文件/.test(e.message),
      '要把文件名字带上，中枢才好原话告诉用户',
    );
    await session.close();
  });
});

test('端到端：中枢取消 → 本机 agent 的 signal 真的响', async () => {
  await withNode({}, async ({ node, agent }) => {
    agent.hang = true;
    const session = clientFor(node);
    const ctrl = new AbortController();

    const p = session.request('agent.run', { text: '一个很久的活' }, { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 60));       // 等它真的进到 agent 里
    ctrl.abort();
    await p.catch(() => {});                            // 中枢这边断了，本来就该抛

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(agent.seen[0].signal.aborted, true, '取消要能一路传到本机的 agent');
    await session.close();
  });
});

// ───────────────────────── 收尾 ─────────────────────────

test('stop：端口真的放掉了（同一个端口能重新绑上）', async () => {
  const ctx = new Context();
  await ctx.plugin(FakeAgent);
  await ctx.plugin(NodeService, {
    id: 'node-home', secret: SECRET, port: 0, host: '127.0.0.1',
    identityFile: throwawayIdentity(),
  });
  const node = ctx.node;

  await node.start();
  const port = node.address.port;
  await node.stop();
  assert.equal(node.listening, false);
  assert.equal(node.address, null);
  await node.stop();                       // 幂等

  // 真的放掉了才能重新绑上 —— 只把标志位改掉是骗自己
  const again = new Server();
  await new Promise((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((r) => again.close(r));
  await ctx.fiber.dispose();
});

test('卸载容器：监听自动收掉，不留半截', async () => {
  const ctx = new Context();
  await ctx.plugin(FakeAgent);
  await ctx.plugin(NodeService, {
    id: 'node-home', secret: SECRET, port: 0, host: '127.0.0.1',
    identityFile: throwawayIdentity(),
  });
  const node = ctx.node;
  await node.start();
  const port = node.address.port;

  await ctx.fiber.dispose();               // 走 ctx.effect 的清理
  assert.equal(node.listening, false);

  const again = new Server();
  await new Promise((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((r) => again.close(r));
});

test('lanAddresses：报的必须是**真能连上的那个**地址', async () => {
  // 只听 0.0.0.0（默认）时，回环对别的机器没用，不该报出来
  await withNode({ host: '0.0.0.0' }, async ({ node }) => {
    const list = node.lanAddresses();
    assert.ok(Array.isArray(list));
    assert.ok(!list.some((a) => a.startsWith('127.')), '回环地址对别的机器没用，不该报出来');
  });

  // 只听了 127.0.0.1 时，**实话实说**就是回环 —— 报一个局域网地址反而是谎报：
  // 用户照着发过来只会得到"连不上"，而且猜不出为什么。（命令体会额外警告一句）
  await withNode({ host: '127.0.0.1' }, async ({ node }) => {
    const list = node.lanAddresses();
    assert.deepEqual(list, [`127.0.0.1:${node.address.port}`]);
    assert.equal(node.pairingInfo().loopbackOnly, true, '命令行靠这个标记加警告');
    for (const a of list) assert.match(a, /^\d+\.\d+\.\d+\.\d+:\d+$/);
  });
});

// ───────────────────────── 跟中枢侧真的对上 ─────────────────────────

test('两端真的对得上：用 LanLink（中枢侧）连 NodeService（节点侧）', async () => {
  await withNode({ alias: '家里那台', port: 0, host: '127.0.0.1' }, async ({ node }) => {
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET, pingTimeoutMs: 500,
        peers: [{ id: 'node-home', alias: '家里那台', host: '127.0.0.1', port: node.address.port }],
      });

      const [home] = await ctx.link.discover();
      assert.equal(home.online, true, 'discover 要认得出来');
      assert.equal(home.alias, '家里那台', 'alias 来自节点自己的配置');
      assert.deepEqual(home.capabilities, ['agent']);

      const session = await ctx.link.connect('node-home');
      const lines = [];
      const result = await session.request('agent.run', { text: '把桌面理一理' }, {
        onEvent: (e) => e.type === 'progress' && lines.push(e.line),
      });

      assert.equal(result.text, '干完了');
      assert.deepEqual(lines, ['在找那个文件夹']);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
