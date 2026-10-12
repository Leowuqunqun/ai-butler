/**
 * `ctx.link` 的第二个真实现 —— 端到端。
 *
 *   node --test test/link.mjs
 *
 * 这里不模拟传输：**真 `LanNode`、真 HTTP + SSE**。
 * 尾巴网络那一层用假 CLI 顶掉（只有"问名册"这一步是 Tailscale 特有的，
 * 而且它的输出形状已经用真机抓的夹具验过了）。
 *
 * 最后两个用例用**本机真实的 Tailscale**：拿到这台机器的尾巴地址，
 * 让节点听在 `0.0.0.0`，然后从尾巴地址连过去 —— 流量真的走了 tailscale0。
 * 没装 Tailscale 的机器上这两个会跳过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import { LanNode } from '@butler/link-lan';
import { TailscaleLink, readTailnet } from '@butler/link-tailscale';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-tailscale.mjs');
const SECRET = 'a-long-enough-secret-for-tests';

/** 这台机器上的真 tailscale 在哪。没有就返回 null（那两个用例会跳过） */
function realBinary() {
  for (const c of ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch { /* 换下一个 */ }
  }
  return null;
}

/** 写一份假名册，返回文件路径 */
function tailnetFile(peers, { state = 'Running', selfUserId = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-tail-link-'));
  const file = join(dir, 'status.json');
  writeFileSync(file, JSON.stringify({
    BackendState: state,
    Self: { UserID: selfUserId, DNSName: 'hub.tail.ts.net.', TailscaleIPs: ['100.0.0.1'] },
    Peer: Object.fromEntries(peers.map((p, i) => [`key${i}`, {
      ID: p.id ?? `tail${i}`,
      HostName: p.hostName ?? `host${i}`,
      UserID: p.userId ?? selfUserId,
      OS: p.os ?? 'linux',
      Online: p.online ?? true,
      LastSeen: '2026-05-11T19:25:18.1Z',
      TailscaleIPs: p.ips ?? ['127.0.0.1'],
    }])),
  }));
  return file;
}

/** 起一个真的节点（不是假对象：真听端口、真派发方法） */
async function startNode({ id = 'node-home', alias = '家里那台', host = '127.0.0.1', port = 0 } = {}) {
  const node = new LanNode({ id, alias, secret: SECRET, host, port, capabilities: ['agent'] });
  node.on('agent.run', async (params, call) => {
    call.emit('那边开工了');
    return { text: `${alias}说：${params.text}`, sessionId: 's-1' };
  });
  await node.start();
  return node;
}

/** 起一个链路插件。返回 ctx 和它 */
async function withLink(config, fn) {
  const ctx = new Context();
  await ctx.plugin(TailscaleLink, { secret: SECRET, binary: STUB, pingTimeoutMs: 400, cliTimeoutMs: 5000, ...config });
  try {
    return await fn(ctx.link, ctx);
  } finally {
    await ctx.fiber.dispose();
  }
}

function useEnv(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  return () => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
}

test('构造：一句话都不配也能起来 —— 那是"还没配对"，不是配置错误', async () => {
  const ctx = new Context();
  await ctx.plugin(TailscaleLink, { secret: '' });
  // 密钥空着就**不去探全网**（拿一把空密钥敲一整张网既白费力气，也像在扫人家网），
  // 所以名册是空的 —— 但进程活着，用户接下来可以在微信里「配对」把设备收进来。
  // 这条取代了原来"没密钥就不装"的断言：配对成了推荐路径之后，
  // "一句话都没配"是一个合法起点，而不再是一个配置错误。
  assert.deepEqual(await ctx.link.discover(), []);
  await ctx.fiber.dispose();
});

test('端到端：名册从尾巴网络来 → 连过去 → 真跑一次带进度的调用', async () => {
  const node = await startNode();
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([{ ips: ['127.0.0.1'] }]) });
  try {
    await withLink({ port: node.port }, async (link) => {
      const devices = await link.discover();
      assert.equal(devices.length, 1, '那台真的答上来了');
      // 关键：报出来的 id/别名/能力**是节点自己说的**，不是尾巴网络的机器名
      assert.equal(devices[0].id, 'node-home');
      assert.equal(devices[0].alias, '家里那台');
      assert.deepEqual(devices[0].capabilities, ['agent']);
      assert.equal(devices[0].online, true);
      assert.equal(devices[0].link, 'tailscale');

      const session = await link.connect('node-home');
      const lines = [];
      const result = await session.request('agent.run', { text: '几点了' }, {
        onEvent: (e) => { if (e.type === 'progress') lines.push(e.line); },
      });
      assert.equal(result.text, '家里那台说：几点了');
      assert.deepEqual(lines, ['那边开工了'], '进度要真的跨过来');
      await session.close();
    });
  } finally {
    restore();
    await node.stop();
  }
});

test('尾巴网络里不是管家的设备，**不算节点**', async () => {
  const node = await startNode();
  const restore = useEnv({
    STUB_TAILNET_FILE: tailnetFile([
      { ips: ['127.0.0.1'] },                 // 这是真节点
      { ips: ['127.0.0.9'], hostName: 'nas' },  // 这个地址上没人在听
    ]),
  });
  try {
    await withLink({ port: node.port }, async (link) => {
      const devices = await link.discover();
      assert.equal(devices.length, 1, '打印机/NAS/同事的电脑不该变成"离线的节点"');
      assert.equal(devices[0].id, 'node-home');
    });
  } finally {
    restore();
    await node.stop();
  }
});

test('那台下线之后：仍然列得出来，标成离线，并带上最后在线时间', async () => {
  const node = await startNode();
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([{ ips: ['127.0.0.1'] }]) });
  try {
    await withLink({ port: node.port, cacheMs: 0 }, async (link) => {
      assert.equal((await link.discover())[0].online, true);
      await node.stop();

      const after = await link.discover();
      assert.equal(after.length, 1, '关机的机器不该从列表里凭空消失');
      assert.equal(after[0].online, false);
      assert.ok(after[0].lastSeen, '要说得出"最后在线"是什么时候');

      await assert.rejects(() => link.connect('node-home'), /连不上家里那台（最后在线/);
    });
  } finally {
    restore();
    await node.stop();
  }
});

test('不认识的名字：列出真正看得见的那些', async () => {
  const node = await startNode();
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([{ ips: ['127.0.0.1'] }]) });
  try {
    await withLink({ port: node.port }, async (link) => {
      await assert.rejects(() => link.connect('node-office'), /不认识这台设备：node-office[\s\S]*家里那台/);
    });
  } finally {
    restore();
    await node.stop();
  }
});

test('Tailscale 没登录：discover 抛一句人话（而不是"一台设备都没有"）', async () => {
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([], { state: 'NeedsLogin' }) });
  try {
    await withLink({}, async (link) => {
      await assert.rejects(() => link.discover(), /还没登录/);
    });
  } finally { restore(); }
});

test('两台机器的节点 id 撞了：当场说，不许安静地指错机器', async () => {
  // 两个**不同的尾巴设备**（设备 id 不同）都报自己是 node-home。
  // 现实里这就是"两台电脑抄了同一份配置，id 没改"。
  const node = await startNode();
  const restore = useEnv({
    STUB_TAILNET_FILE: tailnetFile([
      { id: 'tail-device-1', hostName: 'home', ips: ['127.0.0.1'] },
      { id: 'tail-device-2', hostName: 'office', ips: ['127.0.0.1'] },
    ]),
  });
  try {
    await withLink({ port: node.port, pingTimeoutMs: 800 }, async (link) => {
      await assert.rejects(() => link.discover(), /两台电脑的节点 id 都是「node-home」/);
    });
  } finally {
    restore();
    await node.stop();
  }
});

test('自检：能问出名册就说在跑；CLI 不在就给一句能照做的办法', async () => {
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([{ ips: ['127.0.0.1'] }]) });
  try {
    await withLink({}, async (link) => {
      const items = await link.check();
      const net = items.find((i) => i.name === '尾巴网络');
      assert.equal(net.ok, true);
      assert.match(net.detail, /在跑/);
      assert.match(net.detail, /1 台/);

      const secret = items.find((i) => i.name === '共享密钥');
      assert.equal(secret.ok, true);
    });
  } finally { restore(); }

  await withLink({ binary: '/tmp/绝对没有这个-tailscale-zzz' }, async (link) => {
    const net = (await link.check()).find((i) => i.name === '尾巴网络');
    assert.equal(net.ok, false);
    assert.match(net.detail, /找不到/);
    assert.match(net.fix, /局域网链路/, '要给出另一条能走的路');
  });

  await withLink({ secret: 'short' }, async (link) => {
    const s = (await link.check()).find((i) => i.name === '共享密钥');
    assert.equal(s.ok, false);
    assert.match(s.detail, /太短/);
  });
});

// ───────────────────────── 用本机真实的 Tailscale ─────────────────────────

test('真机：读得动这台机器的尾巴网络名册', async (t) => {
  const binary = realBinary();
  if (!binary) return t.skip('这台机器上没装 Tailscale');

  const net = await readTailnet({ binary });
  assert.ok(net.backendState, '要说得出当前状态');
  assert.ok(Array.isArray(net.peers));
  // 状态是 Running 才谈得上能不能用；不是的话至少要说人话
  if (net.backendState !== 'Running') assert.ok(net.backendState.length > 0);
});

test('真机：从**本机的尾巴地址**连到一个真节点（流量真的走了 tailscale0）', async (t) => {
  const binary = realBinary();
  if (!binary) return t.skip('这台机器上没装 Tailscale');

  const net = await readTailnet({ binary });
  const self = await readTailnet({ binary, timeoutMs: 5000 });
  if (net.backendState !== 'Running') return t.skip(`Tailscale 现在不是 Running（${net.backendState}）`);
  assert.ok(self);

  // 拿这台机器自己的尾巴地址（从真 CLI 里读，不写死）
  const own = JSON.parse(execFileSync(binary, ['status', '--json'], { encoding: 'utf8' }))
    .Self?.TailscaleIPs?.find?.((ip) => ip.includes('.') && !ip.includes(':'));
  if (!own) return t.skip('这台机器没有 IPv4 的尾巴地址');

  const node = await startNode({ host: '0.0.0.0' });
  const restore = useEnv({ STUB_TAILNET_FILE: tailnetFile([{ ips: [own], hostName: 'self' }]) });
  try {
    await withLink({ port: node.port }, async (link) => {
      const devices = await link.discover();
      assert.equal(devices.length, 1, `该从 ${own} 上认出一个管家`);
      const session = await link.connect('node-home');
      const result = await session.request('agent.run', { text: '跨网试试' });
      assert.equal(result.text, '家里那台说：跨网试试');
      await session.close();
    });
  } finally {
    restore();
    await node.stop();
  }
});
