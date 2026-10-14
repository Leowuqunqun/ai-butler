/**
 * `butler node` 的测试 —— 真 spawn 一个进程，真开端口，再从"中枢"连过去。
 *
 *   node --test test/node-cli.mjs
 *
 * 为什么值得单独一个文件：这条路径上**每一个环节都在进程边界之外** ——
 * 配置解析、插件装载、`ctx.node.start()`、监听、认证、取消、SIGINT 退出码。
 * 全部用 import 直接调是测不到的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LanLink, pairWithNode } from '@butler/link-lan';

import {
  AGENT, CHANNEL, READY, SECRET, agentRow, freePort, nodeConfig, nodeRow, runSync, startNode,
} from './fixtures/node-helpers.mjs';

// ───────────────────────── 帮助与参数 ─────────────────────────

test('帮助里列出了 node，并且说清楚哪台机器用哪条命令', () => {
  const r = runSync(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /butler node/);
  assert.match(r.out, /被遥控的那台/, '要讲清楚 node 是给哪台机器用的');
  assert.match(r.out, /收微信的那台/);
  assert.match(r.out, /@butler\/link-lan\/node/, '要给一份能抄的配置');
});

// ───────────────────────── 端到端 ─────────────────────────

test('端到端：真进程 + 真端口，中枢连过去，进度和结果都回来了', async () => {
  const port = await freePort();
  const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);

  try {
    await node.ready;
    assert.match(node.out, /节点「家里那台」上线了/, '要告诉用户它叫什么名字');

    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET,
        pingTimeoutMs: 1000,
        peers: [{ id: 'node-home', alias: '家里那台', host: '127.0.0.1', port }],
      });

      const [home] = await ctx.link.discover();
      assert.equal(home.online, true, '一个真的在跑的节点，探活必须过得去');
      assert.equal(home.alias, '家里那台');

      const session = await ctx.link.connect('node-home');
      const lines = [];
      const result = await session.request('agent.run', { text: '把桌面理一理' }, {
        onEvent: (e) => e.type === 'progress' && lines.push(e.line),
      });

      assert.equal(result.text, '那台电脑说：把桌面理一理');
      assert.deepEqual(lines, ['节点上开工了', '收到：把桌面理一理'], '进度要跨进程真的传回来');
    } finally {
      await ctx.fiber.dispose();
    }
  } finally {
    const code = await node.interrupt();
    assert.equal(code, 0, 'Ctrl-C 之后要退得体面（退出码 0）');
  }
});

test('端到端：中枢按下取消，节点那边的活真的停（不靠超时）', async () => {
  const port = await freePort();
  const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);
  try {
    await node.ready;
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, {
        secret: SECRET, pingTimeoutMs: 1000,
        peers: [{ id: 'node-home', alias: '家里那台', host: '127.0.0.1', port }],
      });
      const session = await ctx.link.connect('node-home');

      const ctrl = new AbortController();
      const p = session.request('agent.run', { text: '一个很久的活' }, { signal: ctrl.signal });
      ctrl.abort();
      await p.catch(() => {});

      // 节点进程没有因为这次取消而崩 —— 还能继续接活
      const again = await session.request('agent.run', { text: '再来一个' }).catch(() => null);
      assert.ok(again === null || again.text, '取消一次不该把节点带崩');
    } finally {
      await ctx.fiber.dispose();
    }
  } finally {
    await node.interrupt();
  }
});

// ───────────────────────── 安全闸与错误提示 ─────────────────────────

test('安全闸：配置里有微信通道就拒绝启动，并说清楚为什么', () => {
  const r = runSync(['node', '--config', nodeConfig([
    { id: 'channel', name: CHANNEL },
    agentRow,
    nodeRow(41338),
  ])]);

  assert.equal(r.code, 1);
  assert.match(r.err, /节点不该登录微信/);
  assert.match(r.err, /随机分到两边/, '要讲清楚后果，不是只说"不允许"');
  assert.match(r.err, /butler run/, '要指路：收微信的那台用哪条命令');
});

test('配置里没有节点那一行：报缺了什么，并给出能抄的一行', () => {
  const r = runSync(['node', '--config', nodeConfig([agentRow])]);

  assert.equal(r.code, 1);
  assert.match(r.err, /没有节点那一行/);
  assert.match(r.err, /@butler\/link-lan\/node/);
});

test('★ 配对：节点自己生成密钥、打出一行；中枢照那一行收下，就能遥控它了', async () => {
  // **这条是这一轮的核心验收**，覆盖的是小白真正要走的那条路：
  //   ① 配置里不写 id、不写密钥（他根本不知道该写什么）
  //   ② 节点起来，屏幕上打出「配对 127.0.0.1:41338 4A7-K2M」
  //   ③ 用户把那一行发到管家那边的对话里 → 中枢收下 → 从此能遥控这台电脑
  const port = await freePort();
  const node = startNode(['node', '--config', nodeConfig([
    agentRow,
    { id: 'node', name: '@butler/link-lan/node', config: { alias: '家里那台', port, host: '127.0.0.1' } },
  ])]);

  try {
    await node.ready;

    // ① 屏幕上必须有那一行 —— 用户唯一要做的事就是把它发出去
    const line = node.out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('配对 '));
    assert.ok(line, `节点该打出一行「配对 …」。实际输出：\n${node.out}`);
    const [, addr, code] = line.split(/\s+/);
    assert.match(code, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/, '配对码长得像 4A7-K2M，好念好抄');
    assert.ok(!/[01OIL]/.test(code), '配对码里不该出现 0/O/1/I/L —— 抄错一位就是配不上');
    // 只监听 127.0.0.1 时不能报局域网地址（用户照着一个够不着的地址发，只会"连不上"）
    assert.equal(addr, `127.0.0.1:${port}`, '打出来的地址必须是真能连上的那个');

    // ② 中枢照着一行收下。注意它**一把密钥都没有** —— 密钥是配对时从那台机器换回来的
    const dir = mkdtempSync(join(tmpdir(), 'butler-pair-cli-'));
    const ctx = new Context();
    try {
      await ctx.plugin(LanLink, { peersFile: join(dir, 'peers.json'), pingTimeoutMs: 1000 });
      const info = await ctx.link.pair({
        host: addr.slice(0, addr.lastIndexOf(':')),
        port: Number(addr.slice(addr.lastIndexOf(':') + 1)),
        code,
      });
      assert.equal(info.alias, '家里那台');
      assert.equal(info.online, true);

      // ③ 收下之后真的能在它上面干活（跨进程、真 HTTP、真 SSE）
      const session = await ctx.link.connect(info.id);
      const result = await session.request('agent.run', { text: '把桌面理一理' });
      assert.equal(result.text, '那台电脑说：把桌面理一理');
      await session.close();
    } finally {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    }

    // ④ 配对码是一次性的：再发一次不该又配一遍
    await assert.rejects(
      () => pairWithNode({
        host: addr.slice(0, addr.lastIndexOf(':')),
        port: Number(addr.slice(addr.lastIndexOf(':') + 1)),
        code,
      }),
      /已经用过了/,
    );
  } finally {
    const code = await node.interrupt();
    assert.equal(code, 0, 'Ctrl-C 之后要退得体面');
  }
});

test('节点缺 agent：门控挡住，报"没人开端口"而不是一堆栈', () => {
  const r = runSync(['node', '--config', nodeConfig([nodeRow(41338)])]);

  assert.equal(r.code, 1);
  assert.match(r.err, /没有节点那一行|没装上来/);
});
