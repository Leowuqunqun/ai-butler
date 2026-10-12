/**
 * **M2 的验收测试** —— 两台机器，两种链路。
 *
 *   node --test test/m2-e2e.mjs
 *
 * M2 的验收标准是："两台机器，微信里说'家用电脑上那个文件'能拿到。"
 * 所以这里不模拟任何一端：
 *
 *   中枢 = 真 `ButlerCore` + 真链路插件（本进程）
 *   节点 = 真 `butler node` **子进程**（另一份配置、另一个 agent、另一个端口）
 *
 * 中间隔着一次真实的 HTTP + SSE 往返。这是"多终端真的通了"的最强证据 ——
 * 前面那些单元测试证的是"每一段都对"，这里证的是**接起来也对**。
 *
 * ── 为什么同一套用例跑两遍 ────────────────────────────────────────
 *
 * 因为 `ctx.link` 这个 seam 的全部意义就在"**换一种找机器的方式，
 * 上面的行为一模一样**"。局域网那条靠配置里的地址找机器，
 * 尾巴网络那条靠问 Tailscale 找机器 —— 上面这四个验收标准一个字都不该变。
 *
 * 如果哪天换了链路就要改内核、或者用户能感觉出差别，那这个 seam 就是假的。
 * 这两个字：**同一套**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';
import { AgentService } from '@butler/seam-agent';
import { LanLink } from '@butler/link-lan';
import { TailscaleLink } from '@butler/link-tailscale';
import { ButlerCore } from '@butler/core';

import {
  SECRET, agentRow, fakeTailscale, freePort, nodeConfig, nodeRow, startNode, waitFor,
} from './fixtures/node-helpers.mjs';

/** 中枢那台机器上的假微信通道 */
class FakeChannel extends ChannelService {
  id = 'fake';
  sent = [];
  sentFiles = [];

  async start() {}
  async stop() {}
  async sendText(to, text) { this.sent.push({ to, text }); return { chunks: 1 }; }
  async sendFile(to, path) { this.sentFiles.push({ to, path }); return { fileName: 'x', size: 1 }; }
  async setTyping() {}

  push(text) { this.emitMessage({ channel: this.id, fromId: 'u1', contextToken: 'tk', text }); }
  texts() { return this.sent.map((s) => s.text); }
}

/**
 * 中枢本机的大脑。
 *
 * 它**被调到就是路由错了** —— 每一条测试都在数它跑了几次。
 */
class LocalAgent extends AgentService {
  id = 'local';
  seen = [];

  async run(req) { this.seen.push(req); return { text: `本机说：${req.text}` }; }
}

/**
 * 两种链路的装法。
 *
 * 「怎么找到那台机器」在这里分叉，**再往下就一样了**：
 * 中枢侧一个 `ctx.link`，节点侧同一个 `butler node`。
 */
const LINKS = [
  {
    name: '局域网',
    kind: 'lan',
    install: (ctx, port) => ctx.plugin(LanLink, {
      secret: SECRET,
      pingTimeoutMs: 1000,
      peers: [{ id: 'node-home', alias: '家里那台', host: '127.0.0.1', port }],
    }),
  },
  {
    name: '尾巴网络',
    kind: 'tailscale',
    install: (ctx, port) => ctx.plugin(TailscaleLink, {
      secret: SECRET,
      // 名册问一个假 CLI 要（只有"问名册"这一步是 Tailscale 特有的）
      binary: fakeTailscale(['127.0.0.1']),
      port,
      pingTimeoutMs: 1000,
      cliTimeoutMs: 5000,
    }),
  },
];

/** 起一台"中枢"：假通道 + 本机大脑 + 真链路 + 真内核 */
async function hub(port, link) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-m2-'));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(LocalAgent);
  await link.install(ctx, port);
  // 开场白默认关掉：这些用例量的都是本轮回了什么，多一句自我介绍会搅浑
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,
    typing: false,
  });
  await ctx.core.start();
  return {
    ctx,
    channel: ctx.channel,
    agent: ctx.agent,
    /** 发一条"微信消息"，等回话，返回所有已发出的文本 */
    async say(text) {
      const before = ctx.channel.texts().length;
      ctx.channel.push(text);
      await waitFor(() => ctx.channel.texts().length > before, `回话：${text.slice(0, 24)}`);
      return ctx.channel.texts().join('\n');
    },
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const link of LINKS) {
  test(`M2 验收（${link.name}）：微信里 @家里那台 → 那台电脑上的 agent 真的干活，本机一次都不跑`, async () => {
    const port = await freePort();
    const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);
    let h;
    try {
      await node.ready;
      h = await hub(port, link);

      // ① 不 @ → 本机办
      const local = await h.say('本机那句');
      assert.match(local, /本机说：本机那句/);
      assert.equal(h.agent.seen.length, 1);

      // ② @家里那台 → 跨进程送到真节点上办
      const remote = await h.say('@家里那台 你那边几点了');
      assert.match(remote, /那台电脑说：你那边几点了/, '这话必须是**那台机器上的** agent 说的');
      assert.equal(h.agent.seen.length, 1, '为 @ 那句，本机 agent 一次都不该跑');

      // ③ 再 @ 一次：会话要能续上（不报错、还是那台机器回话）
      const again = await h.say('@家里那台 那明天呢');
      assert.match(again, /那台电脑说：那明天呢/);
      assert.equal(h.agent.seen.length, 1);
    } finally {
      if (h) await h.cleanup();
      await node.interrupt();
    }
  });

  test(`M2 验收（${link.name}）：那台电脑上产出的文件，微信里真的收得到（"那个文件能拿到"）`, async () => {
    const port = await freePort();
    const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);
    let h;
    try {
      await node.ready;
      h = await hub(port, link);

      const reply = await h.say('@家里那台 把那个文件发我');
      assert.match(reply, /那台电脑说：把那个文件发我/);
      assert.doesNotMatch(reply, /传不回来/, '这回真传回来了，不能再那么说');

      assert.equal(h.channel.sentFiles.length, 1, '微信里该收到一个附件');
      const local = h.channel.sentFiles[0].path;
      // 关键：这个路径是**中枢这台机器上真实存在、内容对得上**的文件。
      // 节点那台上写出来的路径在中枢这边根本不存在 —— 这一整段就是为它存在的。
      assert.equal(existsSync(local), true, `附件该落在中枢这台机器上：${local}`);
      assert.equal(readFileSync(local, 'utf8'), '这是那台电脑上写出来的内容');
      assert.doesNotMatch(local, /butler-node-fixture/, '不该把对面那个路径原样拿给微信');
    } finally {
      if (h) await h.cleanup();
      await node.interrupt();
    }
  });

  test(`M2 验收（${link.name}）：那台电脑下线之后，微信里 @ 它得到一句人话，而不是装死`, async () => {
    const port = await freePort();
    const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);
    let h;
    try {
      await node.ready;
      h = await hub(port, link);

      // 先确认它在线时是通的
      assert.match(await h.say('@家里那台 先问一句'), /那台电脑说/);

      // 把那台电脑关掉（就是用户关机的样子）
      const code = await node.interrupt();
      assert.equal(code, 0);

      const reply = await h.say('@家里那台 还在吗');
      assert.match(reply, /连不上家里那台/, '要说出是**哪台**出事了');
      assert.match(reply, /关机|网络/, '还要给出可能的办法，不能只说失败');
      assert.doesNotMatch(reply, /agent 出错/, '这不是本机 agent 的错');
      assert.equal(h.agent.seen.length, 0, '那台不在，也**不能悄悄改成本机办** —— 那会动错机器上的文件');
    } finally {
      if (h) await h.cleanup();
    }
  });

  test(`M2 验收（${link.name}）：名字叫错时，微信里能得到"我知道的是……"，而且一个字节都没发出去`, async () => {
    const port = await freePort();
    const node = startNode(['node', '--config', nodeConfig([agentRow, nodeRow(port)])]);
    let h;
    try {
      await node.ready;
      h = await hub(port, link);

      const reply = await h.say('@同事的电脑 帮我看看');
      assert.match(reply, /没有叫「同事的电脑」的设备/);
      assert.match(reply, /家里那台/, '要把**真正存在**的设备列出来，用户才知道该叫什么');
      assert.equal(h.agent.seen.length, 0);
    } finally {
      if (h) await h.cleanup();
      await node.interrupt();
    }
  });
}
