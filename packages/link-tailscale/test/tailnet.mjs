/**
 * 尾巴网络名册的解析 —— **纯函数，用真机的输出当夹具**。
 *
 *   node --test test/tailnet.mjs
 *
 * 夹具里的那段 JSON 是从一台真机上 `tailscale status --json` 抓下来、
 * 把设备名换掉的版本 —— 字段名、嵌套形状、IPv4/IPv6 两条地址、
 * `LastSeen` 的 ISO 格式全都是真的。以后 Tailscale 改字段，这里会先红。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { explainState, isRunning, parseTailnet, readTailnet } from '@butler/link-tailscale';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = join(here, 'fixtures', 'stub-tailscale.mjs');

/** 真机上抓下来的形状（名字换过） */
function realShape(overrides = {}) {
  return {
    Version: '1.94.2-t0a29cf18b-g3f044c9f6',
    TUN: true,
    BackendState: 'Running',
    HaveNodeKey: true,
    Self: {
      ID: 'nv9sLycNNM11CNTRL',
      HostName: 'air',
      DNSName: 'air.tail435adc.ts.net.',
      OS: 'macOS',
      UserID: 7633285521941603,
      TailscaleIPs: ['100.69.182.95', 'fd7a:115c:a1e0::3201:b6ac'],
    },
    Peer: {
      'nodekey:b5e5d3aa': {
        ID: 'nkxZDKZ5aX11CNTRL',
        HostName: 'home',
        DNSName: 'home.tail435adc.ts.net.',
        OS: 'macOS',
        UserID: 7633285521941603,
        TailscaleIPs: ['100.98.145.32', 'fd7a:115c:a1e0::dd01:91a0'],
        Online: false,
        LastSeen: '2026-05-11T19:25:18.1Z',
        Active: false,
      },
    },
    ...overrides,
  };
}

test('真机形状：字段都对得上（名字、系统、在线、上次在线）', () => {
  const net = parseTailnet(realShape());

  assert.equal(net.backendState, 'Running');
  assert.equal(net.selfDnsName, 'air.tail435adc.ts.net', '末尾那个点要去掉');
  assert.equal(net.peers.length, 1);

  const [p] = net.peers;
  assert.equal(p.id, 'nkxZDKZ5aX11CNTRL');
  assert.equal(p.hostName, 'home');
  assert.equal(p.dnsName, 'home.tail435adc.ts.net');
  assert.equal(p.os, 'macOS');
  assert.equal(p.online, false);
  assert.equal(p.lastSeen, Date.parse('2026-05-11T19:25:18.1Z'));
});

test('只用 IPv4 的尾巴地址 —— IPv6 那条不用（见 tailnet.ts 的说明）', () => {
  const net = parseTailnet(realShape());
  assert.equal(net.peers[0].address, '100.98.145.32');
  assert.doesNotMatch(net.peers[0].address, /:/);
});

test('只有 IPv6 地址的设备：地址留空，而不是拼出一个连不上的串', () => {
  const json = realShape();
  json.Peer['nodekey:b5e5d3aa'].TailscaleIPs = ['fd7a:115c:a1e0::dd01:91a0'];
  assert.equal(parseTailnet(json).peers[0].address, '');
});

test('默认只认主人自己的设备：同事的电脑不进我的设备列表', () => {
  const json = realShape();
  json.Peer['nodekey:colleague'] = {
    ID: 'nCOLLEAGUE', HostName: 'colleague-mbp', DNSName: 'colleague.tail435adc.ts.net.',
    OS: 'macOS', UserID: 9999999999, TailscaleIPs: ['100.1.2.3'], Online: true, LastSeen: '2026-10-11T00:00:00Z',
  };

  assert.equal(parseTailnet(json).peers.length, 1, '默认：共享尾巴网络里别人的机器不该出现');
  assert.equal(parseTailnet(json, false).peers.length, 2, '明说要看全部的才列出来');
});

test('没 Online / 没 LastSeen / 缺字段都不炸（版本差、字段缺失都要能扛）', () => {
  const net = parseTailnet({ BackendState: 'Running', Self: {}, Peer: { 'k1': {} } });
  assert.equal(net.peers.length, 1);
  assert.equal(net.peers[0].online, false);
  assert.equal(net.peers[0].lastSeen, null);
  assert.equal(net.peers[0].address, '');
  assert.equal(net.peers[0].os, 'unknown');
});

test('连 JSON 都不是：也能给一个空名册，不抛', () => {
  const net = parseTailnet(null);
  assert.equal(net.backendState, 'Unknown');
  assert.equal(net.peers.length, 0);
});

test('状态码翻成给不懂技术的人看的话', () => {
  assert.equal(explainState('Running'), null);
  assert.match(explainState('NeedsLogin'), /还没登录/);
  assert.match(explainState('Stopped'), /没在跑/);
  assert.match(explainState('NeedsMachineAuth'), /批准/);
  assert.match(explainState('SomeFutureState'), /SomeFutureState/, '没见过的状态也要原样说，别吞掉');
  assert.equal(isRunning('Running'), true);
  assert.equal(isRunning('Stopped'), false);
});

// ───────────────────────── 真的去跑 CLI ─────────────────────────

function stubEnv(json, mode = 'ok') {
  const file = join(mkdtempSync(join(tmpdir(), 'butler-tail-')), 'status.json');
  writeFileSync(file, json);
  return { STUB_TAILNET_FILE: file, STUB_TAILNET_MODE: mode };
}

/** 临时改 env 跑一段 */
async function withEnv(env, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test('readTailnet：真跑一遍 CLI，拿到 JSON', async () => {
  await withEnv(stubEnv(JSON.stringify(realShape())), async () => {
    const net = await readTailnet({ binary: STUB, timeoutMs: 5000 });
    assert.equal(net.peers.length, 1);
    assert.equal(net.peers[0].address, '100.98.145.32');
  });
});

test('找不到 CLI：说的是"去装 Tailscale"，不是 ENOENT', async () => {
  await assert.rejects(
    () => readTailnet({ binary: '/tmp/绝对没有这个-tailscale-zzz' }),
    (e) => /找不到/.test(e.message) && /装好 Tailscale/.test(e.message) && !/ENOENT/.test(e.message),
  );
});

test('CLI 报错：把它的第一行 stderr 带出来，别让用户猜', async () => {
  await withEnv(stubEnv('{}', 'fail'), async () => {
    await assert.rejects(() => readTailnet({ binary: STUB }), /Tailscale is not running/);
  });
});

test('输出不是 JSON：说清楚是看不懂，而不是"链路坏了"', async () => {
  await withEnv(stubEnv('{}', 'garbage'), async () => {
    await assert.rejects(() => readTailnet({ binary: STUB }), /看不懂/);
  });
});

test('CLI 卡住：超时就报超时（不能让微信那边干等）', async () => {
  await withEnv(stubEnv('{}', 'hang'), async () => {
    const t0 = Date.now();
    await assert.rejects(() => readTailnet({ binary: STUB, timeoutMs: 400 }), /卡住了/);
    assert.ok(Date.now() - t0 < 5000, '超时之后要马上回来');
  });
});
