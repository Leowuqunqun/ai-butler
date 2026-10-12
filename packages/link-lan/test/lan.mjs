/**
 * link-lan 的测试 —— 全部离线，全部跑在 127.0.0.1 上。
 *
 * 分三层：
 *   ① 线协议（纯函数）—— 分片解析是这里最容易错的地方
 *   ② 节点服务端 —— 认证、方法分发、错误回流
 *   ③ 端到端 —— 真起一个 LanNode，真用 ctx.link 连过去，真跑一次调用
 *
 * 端口一律用 0（让系统分配），否则并行跑测试会撞端口。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { LinkService } from '@butler/seam-link';
import {
  LanLink, LanNode, LanSession,
  PROTOCOL_VERSION, createFrameParser, encodeFrame, isServerFrame,
} from '@butler/link-lan';

const SECRET = 'a-long-enough-secret-for-tests';

// ───────────────────────── ① 线协议 ─────────────────────────

test('协议：encodeFrame 产出标准 SSE', () => {
  assert.equal(encodeFrame({ type: 'progress', line: '干活中' }), 'data: {"type":"progress","line":"干活中"}\n\n');
});

test('协议：一块数据里有多帧，全部解析出来', () => {
  const p = createFrameParser();
  const frames = p.push(encodeFrame({ type: 'progress', line: 'a' }) + encodeFrame({ type: 'done', result: 1 }));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].line, 'a');
  assert.deepEqual(frames[1], { type: 'done', result: 1 });
});

test('协议：**切在半个 JSON 中间**也能拼回来（真实网络就是这么切的）', () => {
  const p = createFrameParser();
  const full = encodeFrame({ type: 'progress', line: '整理桌面完成' });

  // 逐字节喂 —— 最狠的切法
  const got = [];
  for (const ch of full) got.push(...p.push(ch));

  assert.equal(got.length, 1);
  assert.equal(got[0].line, '整理桌面完成');
  assert.equal(p.leftover(), '', '帧收全了，缓冲区该是空的');
});

test('协议：半截帧留在缓冲区里，不报错也不吐假帧', () => {
  const p = createFrameParser();
  const full = encodeFrame({ type: 'done', result: { a: 1 } });
  const half = full.slice(0, Math.floor(full.length / 2));

  assert.deepEqual(p.push(half), [], '半截帧不该被当成帧吐出来');
  assert.notEqual(p.leftover(), '', '要留着等下一块数据');
  assert.equal(p.push(full.slice(half.length)).length, 1, '补上后半截就出来了');
});

test('协议：忽略 event: / id: / 注释行（SSE 允许有，我们不用）', () => {
  const p = createFrameParser();
  const frames = p.push(': 心跳\nid: 7\nevent: tick\ndata: {"type":"done","result":null}\n\n');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { type: 'done', result: null });
});

test('协议：isServerFrame 认得出自家帧、认不出别的东西', () => {
  assert.equal(isServerFrame({ type: 'progress', line: 'x' }), true);
  assert.equal(isServerFrame({ type: 'nope' }), false);
  assert.equal(isServerFrame(null), false);
  assert.equal(isServerFrame('done'), false);
});

// ───────────────────────── ② 节点服务端 ─────────────────────────

/** 起一个节点并保证收干净 */
async function withNode(options, fn) {
  const node = new LanNode({ id: 'node-test', alias: '测试机', secret: SECRET, ...options });
  await node.start();
  try {
    return await fn(node);
  } finally {
    await node.stop();
  }
}

/** 直接打一下节点的 HTTP 接口，绕过客户端 —— 用来测认证这类边界 */
async function rawCall(node, { secret = SECRET, method = 'link.ping', protocol = PROTOCOL_VERSION, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (secret !== null) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(`http://127.0.0.1:${node.port}/butler/call`, {
    method: 'POST',
    headers,
    body: body ?? JSON.stringify({ method, params: null, protocol }),
  });
  return { status: res.status, text: await res.text() };
}

test('节点：没配密钥也起得来，但**密钥一把都不少**（自己生成的）', () => {
  // 这一条以前是"没密钥就拒绝构造"。改的是**谁来出这把密钥**，不是要不要密钥：
  // 让用户在两个文件里各抄一段随机串，就是让用户卡在第一步。
  const a = new LanNode({ id: 'x' });
  const b = new LanNode({ id: 'x' });
  assert.ok(a.secret.length >= 32, `自己生成的密钥不能短（实际 ${a.secret.length} 位）`);
  assert.notEqual(a.secret, b.secret, '每台机器各自生成，不该撞上');
  assert.equal(new LanNode({ id: 'x', secret: SECRET }).secret, SECRET, '配置里给了就用配置的');
});

test('节点：start 幂等，stop 可以重复调、也可以在没 start 时调', async () => {
  const node = new LanNode({ id: 'x', secret: SECRET, port: 0 });
  await node.stop();                    // 没 start 过就 stop，不该炸
  await node.start();
  const port = node.port;
  await node.start();                   // 重复 start 不该起第二个
  assert.equal(node.port, port);
  await node.stop();
  await node.stop();
});

test('节点：port 0 会拿到系统分配的真实端口', async () => {
  await withNode({ port: 0 }, async (node) => {
    assert.ok(node.port > 0, '要能拿到真实端口，测试才不用赌端口没被占');
  });
});

test('节点：认证 —— 没带密钥 / 密钥不对 一律 401，且不说哪里不对', async () => {
  await withNode({ port: 0 }, async (node) => {
    assert.equal((await rawCall(node, { secret: null })).status, 401);
    assert.equal((await rawCall(node, { secret: 'wrong-secret-value' })).status, 401);
    assert.equal((await rawCall(node, { secret: '' })).status, 401);
    // 密钥长度不同也要走同一条路（timingSafeEqual 长度不等会抛，得先挡掉）
    assert.equal((await rawCall(node, { secret: 'x' })).status, 401);
  });
});

test('节点：密钥对就走得通，内置的 link.ping 能报出自己是谁', async () => {
  await withNode({ port: 0, capabilities: ['agent', 'files'] }, async (node) => {
    const r = await rawCall(node);
    assert.equal(r.status, 200);
    const frame = JSON.parse(r.text.split('\n').find((l) => l.startsWith('data:')).slice(5));
    assert.equal(frame.type, 'done');
    assert.equal(frame.result.id, 'node-test');
    assert.equal(frame.result.alias, '测试机');
    assert.deepEqual(frame.result.capabilities, ['agent', 'files']);
    assert.equal(frame.result.protocol, PROTOCOL_VERSION);
  });
});

test('节点：不认识的方法回一帧 error，而不是装作成功', async () => {
  await withNode({ port: 0 }, async (node) => {
    const r = await rawCall(node, { method: 'nope.nothing' });
    assert.equal(r.status, 200, '接口是对的，错的是方法名 —— 所以要能进流里说');
    assert.match(r.text, /不认识方法 nope\.nothing/);
    assert.match(r.text, /NO_METHOD/);
  });
});

test('节点：协议版本对不上要明说，并说清楚该怎么办', async () => {
  await withNode({ port: 0 }, async (node) => {
    const r = await rawCall(node, { protocol: 'butler-lan/0' });
    assert.equal(r.status, 400);
    assert.match(r.text, /协议版本对不上/);
    assert.match(r.text, /升到同一版/, '要给用户下一步，不能只说版本不对');
  });
});

test('节点：请求体不是 JSON / 路径不对 分别给出 400 和 404', async () => {
  await withNode({ port: 0 }, async (node) => {
    assert.equal((await rawCall(node, { body: 'not json at all' })).status, 400);
    const res = await fetch(`http://127.0.0.1:${node.port}/nope`, { method: 'POST' });
    assert.equal(res.status, 404);
    const get = await fetch(`http://127.0.0.1:${node.port}/butler/call`);
    assert.equal(get.status, 404, 'GET 不该被当成调用');
  });
});

test('节点：方法报进度 → 帧按顺序到达；方法抛错 → error 帧带原话', async () => {
  await withNode({ port: 0 }, async (node) => {
    node.on('demo.work', async (_p, ctx) => {
      ctx.emit('第一步');
      ctx.emit('第二步');
      return { ok: true };
    });
    node.on('demo.boom', async () => {
      throw Object.assign(new Error('那台机器上的东西被锁住了'), { code: 'LOCKED' });
    });

    const okRes = await rawCall(node, { method: 'demo.work' });
    const order = okRes.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)).type);
    assert.deepEqual(order, ['progress', 'progress', 'done']);

    const bad = await rawCall(node, { method: 'demo.boom' });
    assert.match(bad.text, /那台机器上的东西被锁住了/, '错误原话要带出去，那是给用户看的那句');
    assert.match(bad.text, /LOCKED/, '机器可读的 code 也要带');
  });
});

// ───────────────────────── ③ 端到端 ─────────────────────────

test('端到端：真节点 + 真会话，一次调用拿到结果', async () => {
  await withNode({ port: 0 }, async (node) => {
    node.on('agent.run', async (params, ctx) => {
      ctx.emit(`收到：${params.text}`);
      return { text: '干完了' };
    });

    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET);
    const events = [];
    const result = await session.request('agent.run', { text: '整理桌面' }, { onEvent: (e) => events.push(e) });

    assert.deepEqual(result, { text: '干完了' });
    assert.deepEqual(events.map((e) => e.type), ['progress', 'done']);
    assert.equal(events[0].line, '收到：整理桌面');
    assert.ok(events.every((e) => typeof e.callId === 'string' && e.callId), '每帧都要带 callId');
    await session.close();
  });
});

test('端到端：节点报的错，会话里以异常抛出，code 保留', async () => {
  await withNode({ port: 0 }, async (node) => {
    node.on('agent.run', async () => { throw Object.assign(new Error('那台电脑上的会话被占用了'), { code: 'SESSION_LOCKED' }); });
    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET);

    await assert.rejects(
      () => session.request('agent.run', {}),
      (e) => {
        assert.match(e.message, /会话被占用/);
        assert.equal(e.code, 'SESSION_LOCKED', '中枢要靠 code 决定换会话重试');
        return true;
      },
    );
    await session.close();
  });
});

test('端到端：密钥不对，报的是人话（不是 HTTP 401）', async () => {
  await withNode({ port: 0 }, async (node) => {
    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, 'wrong-secret-value');
    await assert.rejects(() => session.request('link.ping', {}), /密钥不对/);
    await session.close();
  });
});

test('端到端：对面不吭声 → 空闲超时，会话脱落并通知订阅者', async () => {
  await withNode({ port: 0 }, async (node) => {
    node.on('slow.one', () => new Promise(() => {}));   // 永远不返回
    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET, { idleTimeoutMs: 150 });

    const closed = [];
    session.onClose((r) => closed.push(r));

    await assert.rejects(() => session.request('slow.one', {}), /没动静|没应答/);
    assert.equal(session.isClosed, true, '超时之后这条会话就废了');
    assert.equal(closed.length, 1, '要通知订阅者，中枢才能马上告诉用户');
  });
});

test('端到端：**报进度就不算没动静** —— 长任务不会被超时误杀', async () => {
  await withNode({ port: 0 }, async (node) => {
    node.on('slow.but.talkative', async (_p, ctx) => {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 60));
        ctx.emit(`第 ${i + 1} 步`);
      }
      return '做完了';
    });
    // 空闲超时 150ms，而整个调用要 240ms —— 靠中途的进度帧续命
    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET, { idleTimeoutMs: 150 });
    const lines = [];
    const r = await session.request('slow.but.talkative', {}, { onEvent: (e) => e.type === 'progress' && lines.push(e.line) });

    assert.equal(r, '做完了');
    assert.equal(lines.length, 4, '四步进度都要收到');
    await session.close();
  });
});

test('端到端：节点关了 → 传输层错误让会话脱落', async () => {
  const node = new LanNode({ id: 'node-test', alias: '测试机', secret: SECRET, port: 0 });
  await node.start();
  const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET);

  const closed = [];
  session.onClose((r) => closed.push(r));
  await node.stop();                                  // 节点没了

  await assert.rejects(() => session.request('link.ping', {}));
  assert.equal(closed.length, 1, '连不上要让会话脱落');
  assert.match(closed[0], /没人在听|够不着|断了|没应答/, '要说清楚是哪种连不上');
});

test('端到端：close 幂等，onClose 只响一次', async () => {
  await withNode({ port: 0 }, async (node) => {
    const session = new LanSession('node-test', `http://127.0.0.1:${node.port}`, SECRET);
    let closed = 0;
    session.onClose(() => { closed += 1; });

    await session.close();
    await session.close();
    assert.equal(closed, 1);

    await assert.rejects(() => session.request('link.ping', {}), /链路已经断了/, '关掉之后不该还能发请求');
  });
});

// ───────────────────────── ④ 作为 cordis 插件 ─────────────────────────

test('插件：加载后 ctx.link 就位，双身份成立', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, { secret: SECRET });
    assert.ok(ctx.link instanceof LanLink);
    assert.ok(ctx.link instanceof LinkService, '中枢只按 seam 消费');
    assert.equal(ctx.link.id, 'lan');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('插件：中枢可以一把密钥都不配（那是配对的起点），但手写了设备却不给密钥就拒绝', async () => {
  // ① 空配置：合法。设备是**后来配对收进来**的，每台带一把自己的密钥。
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, {});
    assert.equal(ctx.link.check().length, 2, '一把密钥都没配也该起得来');
  } finally {
    await ctx.fiber.dispose();
  }

  // ② 手写了设备又不给密钥：当场拒绝。这是配置错误 —— 连上去只会得到 401，
  //    而用户从"连接失败"里看不出为什么。
  const ctx2 = new Context();
  try {
    await assert.rejects(
      async () => { await ctx2.plugin(LanLink, { peers: [{ id: 'node-home', alias: '家里那台', host: '10.0.0.9' }] }); },
      /没给密钥/,
    );
  } finally {
    await ctx2.fiber.dispose();
  }
});

test('插件：节点配置缺字段就拒绝装载，并点名是哪一台', async () => {
  const ctx = new Context();
  try {
    await assert.rejects(
      async () => { await ctx.plugin(LanLink, { secret: SECRET, peers: [{ id: 'node-home', alias: '', host: '10.0.0.9' }] }); },
      /缺了 id、别名或地址/,
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('插件：discover 报出配了几台，在线的一台 lastSeen 有时间戳', async () => {
  await withNode({ port: 0, alias: '家里那台' }, async (node) => {
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET,
        pingTimeoutMs: 300,
        peers: [
          { id: 'node-test', alias: '家里那台', host: '127.0.0.1', port: node.port },
          { id: 'node-gone', alias: '公司那台', host: '127.0.0.1', port: 1 },   // 1 号端口不会有人听
        ],
      });

      const devices = await ctx.link.discover();
      assert.equal(devices.length, 2, '连不上的也要报出来 —— 用户问的是"我有几台"');

      const home = devices.find((d) => d.id === 'node-test');
      assert.equal(home.online, true);
      assert.equal(typeof home.lastSeen, 'number');
      assert.equal(home.alias, '家里那台');
      assert.deepEqual(home.capabilities, ['agent']);
      assert.equal(home.link, 'lan');

      const gone = devices.find((d) => d.id === 'node-gone');
      assert.equal(gone.online, false);
      assert.equal(gone.lastSeen, null, '从没连上过就是 null');
      assert.equal(gone.os, 'unknown', '连不上就不知道对面是什么系统，别瞎猜');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

test('插件：connect 一台没登记的设备，错误里要列出登记了哪些', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, { secret: SECRET, peers: [{ id: 'node-home', alias: '家里那台', host: '127.0.0.1', port: 1 }] });
    await assert.rejects(
      () => ctx.link.connect('node-typo'),
      (e) => {
        assert.match(e.message, /不认识这台设备/);
        assert.match(e.message, /家里那台/, '要列出现有的，用户才知道是不是自己名字打错了');
        return true;
      },
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('插件：connect 一台离线设备要**当场**抛，带上"最后在线"', async () => {
  await withNode({ port: 0 }, async (node) => {
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET, pingTimeoutMs: 300,
        peers: [{ id: 'node-test', alias: '家里那台', host: '127.0.0.1', port: node.port }],
      });

      const session = await ctx.link.connect('node-test');       // 先成功一次，记下 lastSeen
      assert.equal(session.deviceId, 'node-test');
      await node.stop();                                          // 然后把它关掉

      await assert.rejects(
        () => ctx.link.connect('node-test'),
        (e) => {
          assert.match(e.message, /连不上家里那台/);
          assert.match(e.message, /最后在线/, '要能说出"最后在线什么时候" —— 用户靠这句判断是不是自己忘了开机');
          return true;
        },
      );
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

test('插件：会话缓存复用；关掉之后再 connect 会重新握手', async () => {
  await withNode({ port: 0 }, async (node) => {
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET, pingTimeoutMs: 300,
        peers: [{ id: 'node-test', alias: '家里那台', host: '127.0.0.1', port: node.port }],
      });

      const a = await ctx.link.connect('node-test');
      const b = await ctx.link.connect('node-test');
      assert.equal(a, b, '同一台设备不该反复握手');

      await a.close();
      const c = await ctx.link.connect('node-test');
      assert.notEqual(c, a, '关掉之后要能重新连上');
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

test('插件：端到端 —— 通过 ctx.link 真的把一次调用跑到节点上', async () => {
  await withNode({ port: 0, capabilities: ['agent'] }, async (node) => {
    node.on('agent.run', async (params, ctx) => {
      ctx.emit('在找那个文件夹');
      return { text: `找到了：${params.what}` };
    });

    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET, pingTimeoutMs: 300,
        peers: [{ id: 'node-test', alias: '家里那台', host: '127.0.0.1', port: node.port }],
      });

      const [home] = await ctx.link.discover();
      assert.equal(home.online, true);

      const session = await ctx.link.connect(home.id);
      const lines = [];
      const result = await session.request('agent.run', { what: '报销' }, {
        onEvent: (e) => e.type === 'progress' && lines.push(e.line),
      });

      assert.deepEqual(result, { text: '找到了：报销' });
      assert.deepEqual(lines, ['在找那个文件夹']);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

// ───────────────────────── ⑤ 自检 ─────────────────────────

test('自检：配了节点就过；密钥太短要报警并给出办法', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, {
      secret: 'short',
      peers: [{ id: 'node-home', alias: '家里那台', host: '10.0.0.9' }],
    });

    const items = ctx.link.check();
    const peers = items.find((i) => i.name === '认识的设备');
    const secret = items.find((i) => i.name === '密钥');

    assert.equal(peers.ok, true);
    assert.match(peers.detail, /家里那台/);

    assert.equal(secret.ok, false, '5 位密钥在局域网里几分钟就能猜出来');
    assert.match(secret.fix, /openssl rand/, '要给出具体办法，不是"请配置安全的密钥"');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('自检：一台设备都还没收下时给的是"下一步做什么"，不是红叉', async () => {
  // 刚装好、还没配对不是**错误状态** —— 给一个红叉只会让人以为装坏了。
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, { secret: SECRET });
    const peers = ctx.link.check().find((i) => i.name === '认识的设备');

    assert.equal(peers.ok, true);
    assert.match(peers.detail, /一台都还没有/);
    assert.match(peers.fix, /butler node/);
    assert.match(peers.fix, /配对/);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('自检：**不去 ping 节点** —— 节点关机是"你没开电脑"，不是"配置错了"', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(LanLink, {
      secret: SECRET, pingTimeoutMs: 300,
      peers: [{ id: 'node-gone', alias: '公司那台', host: '127.0.0.1', port: 1 }],
    });

    const t0 = Date.now();
    const items = ctx.link.check();
    assert.ok(Date.now() - t0 < 100, `自检不该做重活（花了 ${Date.now() - t0}ms）`);
    assert.equal(items.length, 2, '只报配置本身，不报在线状态');
  } finally {
    await ctx.fiber.dispose();
  }
});
