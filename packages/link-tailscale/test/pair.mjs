/**
 * 尾巴网络链路的**配对** —— 跟局域网那条同一套一次性配对码。
 *
 *   node --test test/pair.mjs
 *
 * 这一套要钉死的是「**不懂技术的人也能把第二台机器交给管家**」：
 * 用户只在微信里发一行（那台电脑屏幕上打出来的地址 + 配对码），
 * **不需要**在两台机器上把同一串密钥抄对；配过一次之后，中枢重启也还记得。
 *
 * 所有用例都在本机循环地址上跑真节点、真 HTTP、真 SSE，**不碰真尾巴网络**
 * —— 密钥空着时这条链路压根不去读 `tailscale status`，所以这里也不需要假 CLI。
 */

import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { LanNode, isUsableInterface } from '@butler/link-lan';
import { TailscaleLink } from '@butler/link-tailscale';

const SECRET_A = 'secret-for-node-a-0123456789';
const SECRET_B = 'secret-for-node-b-9876543210';

const tmp = () => mkdtempSync(join(tmpdir(), 'butler-tail-pair-'));

/** 起一个真节点：真听端口、真派发方法，跑完收干净 */
async function withNode({ id, alias, secret }, fn) {
  const node = new LanNode({ id, alias, secret, port: 0, capabilities: ['agent'] });
  node.on('agent.run', async (params) => ({ text: `${alias}说：${params.text}`, sessionId: 's-1' }));
  await node.start();
  try {
    return await fn(node);
  } finally {
    await node.stop();
  }
}

/**
 * 起一个中枢链路。
 *
 * `peersFile` 一律指到临时目录 —— 这几条用例配的是**测试节点**，
 * 绝不能把关系写进用户真实的那份名册。
 */
async function withLink(dir, fn, config = {}) {
  const ctx = new Context();
  await ctx.plugin(TailscaleLink, {
    secret: '',
    peersFile: join(dir, 'peers.json'),
    pingTimeoutMs: 400,
    ...config,
  });
  try {
    return await fn(ctx.link, ctx);
  } finally {
    await ctx.fiber.dispose();
  }
}

const readRoster = (dir) => JSON.parse(readFileSync(join(dir, 'peers.json'), 'utf8'));

// ───────────────────────── 配对 ─────────────────────────

test('配对：拿那台电脑屏幕上的一行，换回它自己的密钥（当场落盘，0600）', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        const device = await link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });

        assert.equal(device.id, 'node-home');
        assert.equal(device.alias, '家里那台');
        assert.equal(device.online, true);
        assert.equal(device.link, 'tailscale', '对外要说清是哪条链路收的');

        const file = join(dir, 'peers.json');
        assert.ok(existsSync(file), '配过一次就该落盘');
        assert.equal(statSync(file).mode & 0o777, 0o600, '名册里装着密钥，必须是 0600');
        const saved = readRoster(dir);
        assert.equal(saved.length, 1);
        assert.equal(saved[0].secret, SECRET_A, '存的是**那台机器自己的**密钥');
        assert.equal(saved[0].host, '127.0.0.1');

        // 配过之后，连尾巴网络都不用读就该看得见它（密钥空着就不去探全网）
        const seen = await link.discover();
        assert.deepEqual(seen.map((d) => d.id), ['node-home']);
        assert.equal(seen[0].online, true);
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('配对：码不对就当场说人话，而且一个字节都不落盘', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        await assert.rejects(
          () => link.pair({ host: '127.0.0.1', port: node.port, code: 'ZZZZZZ' }),
          (e) => /配对码|码/.test(e.message),
        );
        assert.equal(existsSync(join(dir, 'peers.json')), false, '没配成就不该有名册');

        // 位数都不对时，连那台机器都不该去打扰 —— 直接告诉用户抄错了
        await assert.rejects(
          () => link.pair({ host: '127.0.0.1', port: node.port, code: 'AB' }),
          (e) => /6 位/.test(e.message),
        );
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('配对：地址都没给就说清去哪抄（不许拿着空地址去连）', async () => {
  const dir = tmp();
  try {
    await withLink(dir, async (link) => {
      await assert.rejects(
        () => link.pair({ host: '   ', code: '4A7K2M' }),
        (e) => /地址/.test(e.message) && /butler node/.test(e.message),
      );
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── 落盘 / 重启 ─────────────────────────

test('重启：配过的关系不因为中枢重启就没了，而且用的是配对时那把密钥', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        await link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
      });

      // 第二个实例 = 中枢重启：名册从文件读回来，密钥不空所以真的连得上
      await withLink(dir, async (link) => {
        const seen = await link.discover();
        assert.deepEqual(seen.map((d) => d.id), ['node-home']);
        assert.equal(seen[0].online, true, '节点还开着，就该是在线');

        const session = await link.connect('node-home');
        const out = await session.request('agent.run', { text: '你好' });
        assert.match(String(out.text), /家里那台说：你好/);
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('每台一把：两台机器两把密钥，各连各的（一台泄漏不等于全都泄漏）', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-a', alias: 'A 机', secret: SECRET_A }, async (a) => {
      await withNode({ id: 'node-b', alias: 'B 机', secret: SECRET_B }, async (b) => {
        await withLink(dir, async (link) => {
          await link.pair({ host: '127.0.0.1', port: a.port, code: a.pairingCode });
          await link.pair({ host: '127.0.0.1', port: b.port, code: b.pairingCode });

          const saved = readRoster(dir);
          assert.equal(saved.length, 2);
          assert.deepEqual(
            saved.map((p) => p.secret).sort(),
            [SECRET_A, SECRET_B].sort(),
            '每台存的是它自己那把，不是一把通用的',
          );

          for (const id of ['node-a', 'node-b']) {
            const session = await link.connect(id);
            const out = await session.request('agent.run', { text: '在吗' });
            assert.match(String(out.text), /在吗/, `${id} 该用自己那把密钥连上`);
          }
          assert.equal((await link.discover()).filter((d) => d.online).length, 2);
        });
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('重配同一台：不留两份（不然 @ 的时候可能指到旧地址去）', async () => {
  const dir = tmp();
  try {
    // 同一台机器换个端口再配一次 —— 配对码是一次性的，所以第二次是**另起一个节点**，
    // 但两边用的是同一个管家 id（真实场景：那台机器换了端口、或者重装了一次）
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (first) => {
      await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (second) => {
        await withLink(dir, async (link) => {
          await link.pair({ host: '127.0.0.1', port: first.port, code: first.pairingCode });
          await link.pair({ host: '127.0.0.1', port: second.port, code: second.pairingCode });

          const saved = readRoster(dir);
          assert.equal(saved.length, 1, '同一个 id 只该有一条');
          assert.equal(saved[0].port, second.port, '留下来的该是**刚配的**那个地址');
          assert.equal((await link.discover()).length, 1);
        });
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('名册读不动：当场抛，不许当成「还没配过」（那会让人以为设备丢了）', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'peers.json'), '{ 这不是 JSON');
    const ctx = new Context();
    await assert.rejects(
      async () => { await ctx.plugin(TailscaleLink, { secret: '', peersFile: join(dir, 'peers.json') }); },
      (e) => /名册|读|JSON/.test(e.message),
    );
    await ctx.fiber.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── 忘掉 / 自检 ─────────────────────────

test('忘掉：名册里真的没了；没配过的说不知道，探到的说不能删', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        await link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });

        assert.equal(await link.forget('node-home'), 'forgotten');
        assert.equal(readRoster(dir).length, 0, '忘了就该从名册里删掉');
        assert.deepEqual(await link.discover(), [], '忘了之后不该再列出来');

        assert.equal(await link.forget('node-home'), 'unknown');
        assert.equal(await link.forget('压根没有这台'), 'unknown');
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('自检：还没收设备时说的是「下一步做什么」，密钥空着不算错', async () => {
  const dir = tmp();
  try {
    await withLink(dir, async (link) => {
      const items = await link.check();

      const pairItem = items.find((i) => i.name === '配对过的设备');
      assert.ok(pairItem, '自检必须有这一条：它是新用户唯一的指路牌');
      assert.equal(pairItem.ok, false, '一台设备都没有时不该显示一切正常');
      assert.match(pairItem.detail, /butler node/, '要说清去哪拿那一行');
      assert.match(pairItem.fix ?? '', /配对/, '要给出能直接抄的那句命令');

      const secretItem = items.find((i) => i.name === '共享密钥');
      assert.equal(secretItem.ok, true, '配对是推荐路径，密钥空着不是错误');
      assert.match(secretItem.detail, /配对/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('自检：配过设备之后，那一条要显示有几台、记在哪', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        await link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
        const pairItem = (await link.check()).find((i) => i.name === '配对过的设备');
        assert.equal(pairItem.ok, true);
        assert.match(pairItem.detail, /1 台/);
        assert.match(pairItem.detail, /重启还在/);
      });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── 顺带：地址该给用户看哪些 ─────────────────────────

test('地址判据：容器/网桥的滤掉，VPN 的留着（尾巴地址就在 utun 上）', () => {
  // 抄了没用、还会让配对看起来坏了的：容器和网桥
  for (const name of ['docker0', 'br-1a2b3c', 'veth9f8e', 'lo0']) {
    assert.equal(isUsableInterface(name), false, `${name} 不该给用户抄`);
  }
  // ⚠️ 这条是**真出过事**的：macOS 上 Tailscale 的尾巴地址在 utun 上，
  // 滤掉它 = 节点屏幕上打不出那句能抄的话 = 跨网配对没法指路
  for (const name of ['utun3', 'tun0', 'tap1', 'en0', 'eth0', 'tailscale0']) {
    assert.equal(isUsableInterface(name), true, `${name} 可能正是唯一够得着的地址`);
  }
});

// ───────────────────────── 名册读不动时，别把用户堵死 ─────────────────────────

test('尾巴网络读不动但有配对设备：照样把它们列出来（网络那件事交给自检去说）', async () => {
  const dir = tmp();
  try {
    await withNode({ id: 'node-home', alias: '家里那台', secret: SECRET_A }, async (node) => {
      await withLink(dir, async (link) => {
        await link.pair({ host: '127.0.0.1', port: node.port, code: node.pairingCode });
      });

      // 这一次：配了共享密钥（于是会去读尾巴网络）但 CLI 根本不存在 —— 读网络必失败
      await withLink(dir, async (link) => {
        const seen = await link.discover();
        assert.deepEqual(seen.map((d) => d.id), ['node-home'], '手里有配对过的，就不该整条链路报错');
        assert.equal(seen[0].online, true);
      }, { secret: 'a-shared-secret-long-enough', binary: '/nonexistent/tailscale' });
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
