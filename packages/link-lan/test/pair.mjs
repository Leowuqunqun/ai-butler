/**
 * **配对**的测试 —— 中枢和节点两头都跑真的，HTTP 真的过 127.0.0.1。
 *
 * 这一组验的是一条完整的链路：**用户不用抄任何密钥，也不用改配置文件。**
 *
 *   那台电脑起 butler node → 屏幕上打出「配对 192.168.1.9:41338 4A7-K2M」
 *        ↓ 用户把这一行发到微信里
 *   中枢拿这个码换回那台机器的身份和密钥 → 收下 → **落盘**
 *        ↓ 中枢重启
 *   名册还在，用户接着说「@家里那台 …」就还能用
 *
 * 里面最关键的一条断言是：**中枢自己的配置里一把密钥都没有，
 * 却真的能连上那台机器**（密钥是配对时从那台机器上换回来的）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LanLink, LanNode, PROTOCOL_VERSION, normalizePairCode, pairWithNode } from '@butler/link-lan';

/** 起一台真节点：密钥**不传**，让它自己生成（这才是真实路径） */
async function startNode(options = {}) {
  const node = new LanNode({
    id: 'node-home',
    alias: '家里那台',
    host: '127.0.0.1',
    port: 0,
    capabilities: ['agent'],
    ...options,
  });
  await node.start();
  return node;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'butler-pair-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── ① 配对码本身 ─────────────────────────

test('配对码：形如 4A7-K2M，抄的时候大小写、横线、空格都算数', async () => {
  const node = await startNode();
  try {
    assert.match(node.pairingCode, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    assert.doesNotMatch(node.pairingCode, /[01OIL]/, '去掉了念不清、抄不对的那几个字符');

    // 用户抄成什么样都得认：小写、少横线、多空格
    const raw = node.pairingCode;
    const forms = [raw, raw.toLowerCase(), raw.replace('-', ''), ` ${raw} `, raw.replace('-', ' ')];
    for (const [i, form] of forms.entries()) {
      assert.equal(normalizePairCode(form), normalizePairCode(raw), `第 ${i} 种抄法要认得`);
    }
  } finally {
    await node.stop();
  }
});

// ───────────────────────── ② 拿码换身份和密钥 ─────────────────────────

test('配对：码对 → 换回身份和**那把密钥**，而且只认一次', async () => {
  const node = await startNode();
  try {
    const got = await pairWithNode({ host: '127.0.0.1', port: node.port, code: node.pairingCode });

    assert.equal(got.id, 'node-home');
    assert.equal(got.alias, '家里那台');
    assert.deepEqual(got.capabilities, ['agent']);
    assert.ok(got.os);
    // ★ 这把密钥就是那台机器自己生成的那把 —— 中枢从此不用跟用户要密钥
    assert.equal(got.secret, node.secret);

    // 用过的码当场作废：再试一次会被明确告知，而不是重复发一遍密钥
    await assert.rejects(
      () => pairWithNode({ host: '127.0.0.1', port: node.port, code: node.pairingCode }),
      /已经用过了/,
    );
  } finally {
    await node.stop();
  }
});

test('配对：码不对 → 告诉用户去核对那台电脑屏幕，而不是"认证失败"', async () => {
  const node = await startNode();
  try {
    await assert.rejects(
      () => pairWithNode({ host: '127.0.0.1', port: node.port, code: 'ZZZ-ZZZ' }),
      /配对码不对/,
    );
  } finally {
    await node.stop();
  }
});

test('配对：连错 5 次，这个码当场作废（留着不限次数就是个能慢慢猜的口子）', async () => {
  const node = await startNode();
  try {
    for (let i = 0; i < 4; i++) {
      await assert.rejects(
        () => pairWithNode({ host: '127.0.0.1', port: node.port, code: 'ZZZ-ZZZ' }),
        /配对码不对/,
        `第 ${i + 1} 次还该说"不对"`,
      );
    }
    await assert.rejects(
      () => pairWithNode({ host: '127.0.0.1', port: node.port, code: 'ZZZ-ZZZ' }),
      /试错太多次/,
    );

    // 作废之后，**正确的码也不认了** —— 否则"作废"没有意义
    await assert.rejects(
      () => pairWithNode({ host: '127.0.0.1', port: node.port, code: node.pairingCode }),
      /试错太多次/,
    );
    // 重新起一个码，又能配了（用户不用重启整台机器）
    const fresh = node.refreshPairCode();
    const got = await pairWithNode({ host: '127.0.0.1', port: node.port, code: fresh });
    assert.equal(got.id, 'node-home');
  } finally {
    await node.stop();
  }
});

test('配对：码过期 → 说清楚"重起一次 butler node"', async () => {
  const node = await startNode({ pairTtlMs: 1 });
  try {
    await sleep(10);
    await assert.rejects(
      () => pairWithNode({ host: '127.0.0.1', port: node.port, code: node.pairingCode }),
      /过期了/,
    );
  } finally {
    await node.stop();
  }
});

test('配对：够不着那台电脑 → 说的是"连不上"，不是"配对码不对"', async () => {
  // 用户要做的动作完全不同：一个是去开那台机器，一个是回去核对码
  await assert.rejects(
    () => pairWithNode({ host: '127.0.0.1', port: 1, code: 'ABC-DEF', timeoutMs: 1000 }),
    /连不上|没有回应/,
  );
});

test('配对：普通密钥那条路**走不到** link.pair —— 配对只能靠配对码', async () => {
  const node = await startNode();
  try {
    const res = await fetch(`http://127.0.0.1:${node.port}/butler/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${node.secret}` },
      body: JSON.stringify({ method: 'link.pair', params: null, protocol: PROTOCOL_VERSION }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /不认识方法 link\.pair/, '带着密钥也不该能调它');
  } finally {
    await node.stop();
  }
});

// ───────────────────────── ③ 中枢侧：收下、落盘、重启还记得 ─────────────────────────

/** 起一个中枢。注意默认**一把密钥都不给** —— 这就是配对之后的正常配置 */
async function startHub(peersFile, extra = {}) {
  const ctx = new Context();
  await ctx.plugin(LanLink, { peersFile, ...extra });
  return ctx;
}

test('中枢：收下一台设备后**真的能连上它**（中枢自己一把密钥都没有）', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'peers.json');
  const node = await startNode();
  const ctx = await startHub(file);
  t.after(async () => { await ctx.fiber.dispose(); await node.stop(); rmSync(dir, { recursive: true, force: true }); });

  assert.equal(ctx.link.config.secret, '', '这个用例的前提：中枢没配任何密钥');

  const info = await ctx.link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
  assert.equal(info.id, 'node-home');
  assert.equal(info.alias, '家里那台');
  assert.equal(info.online, true);
  assert.equal(info.link, 'lan');

  // 连上去真的说上话：密钥是配对时换回来的那一把
  const session = await ctx.link.connect('node-home');
  const ping = await session.request('link.ping', {});
  assert.equal(ping.id, 'node-home');
  await session.close();
});

test('中枢：收下的设备**落盘**（0600），而且重启之后还记得', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'peers.json');
  const node = await startNode();
  const ctx = await startHub(file);
  t.after(async () => { rmSync(dir, { recursive: true, force: true }); });

  try {
    await ctx.link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
    await ctx.fiber.dispose();

    // 文件里是那台机器的地址和密钥，权限 0600
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'node-home');
    assert.equal(saved[0].secret, node.secret, '密钥得存下来，否则重启就断了');
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // ★ 换个进程（新的 LanLink 实例）起来：名册还在，**用户不用重配**
    const ctx2 = await startHub(file);
    try {
      const devices = await ctx2.link.discover();
      assert.equal(devices.length, 1);
      assert.equal(devices[0].id, 'node-home');
      assert.equal(devices[0].online, true, '重启之后照样连得上');
    } finally {
      await ctx2.fiber.dispose();
    }
  } finally {
    await node.stop();
  }
});

test('中枢：名册文件坏了就不启动，并说清楚是哪个文件、怎么修', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'peers.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 静默当成空名册的话，现象是"我配过的设备都不见了"，而且没有任何线索
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');

  const ctx = new Context();
  await assert.rejects(async () => { await ctx.plugin(LanLink, { peersFile: file }); }, /名册读不动/);
  await ctx.fiber.dispose();
});

test('中枢：忘掉一台设备 —— 忘得掉、记得住，手写在配置里的忘不掉', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'peers.json');
  const node = await startNode();
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await node.stop(); rmSync(dir, { recursive: true, force: true }); });

  await ctx.plugin(LanLink, {
    peersFile: file,
    // 手写的一台（有共享密钥，所以合法）
    secret: 'a-long-enough-secret-for-tests',
    peers: [{ id: 'node-office', alias: '公司那台', host: '10.0.0.9' }],
  });

  await ctx.link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });

  assert.equal(await ctx.link.forget('node-home'), 'forgotten');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [], '忘掉之后文件里也不该留着');
  assert.equal((await ctx.link.discover()).some((d) => d.id === 'node-home'), false);

  assert.equal(await ctx.link.forget('node-home'), 'unknown');
  assert.equal(
    await ctx.link.forget('node-office'), 'static',
    '手写在配置里的忘不掉 —— 忘了下次重启它又回来了，只会更困惑',
  );
});

test('中枢：配对参数不对时，说的是用户该改什么', async (t) => {
  const dir = tempDir();
  const ctx = await startHub(join(dir, 'peers.json'));
  t.after(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }); });

  await assert.rejects(() => ctx.link.pair({ host: '', code: 'ABC-DEF' }), /那台电脑的地址/);
  await assert.rejects(() => ctx.link.pair({ host: '10.0.0.9', code: 'ABC' }), /6 位/);
});

test('中枢：同一个地址重新配一次，不会留下两份记录', async (t) => {
  const dir = tempDir();
  const file = join(dir, 'peers.json');
  const node = await startNode();
  const ctx = await startHub(file);
  t.after(async () => { await ctx.fiber.dispose(); await node.stop(); rmSync(dir, { recursive: true, force: true }); });

  await ctx.link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
  node.refreshPairCode();
  await ctx.link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });

  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1, '同一台机器只该有一条');
});
