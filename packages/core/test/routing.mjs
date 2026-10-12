/**
 * 设备别名路由的端到端测试 —— 假通道 + 假 agent + 假链路 + 真内核。
 *
 *   node --test test/routing.mjs
 *
 * 这里要钉死的核心是一句话：**没 @ 就在本机办，@ 了才跨设备，而且不装样子**。
 * 每一条都尽量同时验"该发生的发生了"和"不该发生的一点都没发生" ——
 * 后者才是这类功能真正会出事的地方（把话偷偷发到不该去的机器上）。
 */

import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ButlerCore } from '@butler/core';
import { FakeAgent, FakeChannel, FakeLink, device } from './.build/harness.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, what = '条件', ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) assert.fail(`等不到：${what}`);
    await sleep(10);
  }
}

/** 起一个容器。`withLink: false` 用来验"没装链路的那台机器" */
async function setup(coreCfg = {}, { withLink = true, agentCfg = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-route-'));
  // 开场白默认关掉：老用例量的都是「这一轮回了什么」，多一句「我是你的管家」会把账搅浑。
  // 专门量开场白的用例自己换一条**没有这份文件**的状态路径（见 commands.mjs 里那条 ★）。
writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(FakeAgent, agentCfg);
  if (withLink) await ctx.plugin(FakeLink);
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,
    ...coreCfg,
  });
  await ctx.core.start();          // 加载 ≠ 上线，不调它一条消息都不会被处理
  return {
    ctx,
    channel: ctx.channel,
    agent: ctx.agent,
    link: withLink ? ctx.link : undefined,
    dir,
    /** 发一条消息，等内核回话，返回这次新发出去的每一条 */
    async say(text, files) {
      const before = ctx.channel.texts().length;
      ctx.channel.push({ text }, files);
      await waitFor(() => ctx.channel.texts().length > before, `回话：${text.slice(0, 24)}`);
      await ctx.channel.settle();
      return ctx.channel.texts().slice(before).join('\n');
    },
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 装好一台设备 */
function withDevices(link, ...devices) {
  link.devices.push(...devices);
}

// ───────────────────────── 默认本机 ─────────────────────────

test('没 @：在本机办，**链路一次都不碰**', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const reply = await s.say('把桌面理一理');

    assert.equal(s.agent.seen.length, 1, '本机 agent 该跑');
    assert.equal(s.agent.seen[0].text, '把桌面理一理');
    assert.equal(s.link.calls.length, 0, '**不该为了这一句去问设备列表**');
    assert.match(reply, /好的/);
  } finally { await s.cleanup(); }
});

test('话里提到设备名字，但不是命令它 —— 照样在本机办', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    await s.say('家里那台好像坏了，你帮我看看');
    assert.equal(s.agent.seen.length, 1);
    assert.equal(s.link.calls.length, 0, '隐式猜测会把这句**话**当成**命令**发过去 —— 绝不能');
  } finally { await s.cleanup(); }
});

// ───────────────────────── 显式跨设备 ─────────────────────────

test('@家里那台：送到那台机器，**本机 agent 一次都不跑**', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.reply = '远端干完了';
    const reply = await s.say('@家里那台 把桌面理一理');

    assert.equal(s.agent.seen.length, 0, '不能在本机也跑一遍');
    assert.equal(s.link.calls.length, 1);
    assert.equal(s.link.calls[0].deviceId, 'node-home');
    assert.equal(s.link.calls[0].method, 'agent.run');
    assert.deepEqual(s.link.calls[0].params, {
      text: '把桌面理一理',
      sessionId: null,
      cwd: '',                 // 中枢的目录在那台机器上没意义
    });
    assert.match(reply, /远端干完了/);
  } finally { await s.cleanup(); }
});

test('中文不加空格也送得过去', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    await s.say('@家里那台把桌面理一理');
    assert.equal(s.link.calls[0].params.text, '把桌面理一理', '别名要切干净，正文里不能剩半个名字');
  } finally { await s.cleanup(); }
});

test('写多行时 @ 不在第一行也认', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    await s.say('帮我看下这个\n@家里那台 再发一次');
    assert.equal(s.link.calls.length, 1);
    assert.equal(s.link.calls[0].params.text, '帮我看下这个\n 再发一次');
  } finally { await s.cleanup(); }
});

test('★ 跨设备：引用作为**上下文**一起送到远端，但引用里的 @设备 不算在叫人', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'), device('node-office', '公司电脑'));

    // ① 用户引用了一句自己以前说过的话（那里面有 @公司电脑），这次说的是"再发一次"。
    //    这句该留在本机 —— 引用不是"在叫设备"。
    s.channel.push({ text: '再发一次', quote: '@公司电脑 昨天那个 PPT' });
    await waitFor(() => s.channel.texts().length > 0, '本机回话');
    await s.channel.settle();
    assert.equal(s.link.calls.length, 0, '引用里那个 @ 一个字都不该送到别的机器上');
    assert.equal(s.agent.seen.length, 1, '该在本机跑');

    // ② 这次正文里真的 @ 了 —— 引用要跟着一起过去，agent 才知道他在回哪句
    s.channel.push({ text: '@家里那台 再发一次', quote: '昨天那个 PPT' });
    await waitFor(() => s.link.calls.length > 0, '发给远端');
    const sent = s.link.calls[0].params.text;
    assert.match(sent, /\[引用: 昨天那个 PPT\]/, '引用是给远端 agent 的上下文，得一起带过去');
    assert.match(sent, /再发一次/);
    assert.ok(!sent.includes('@家里那台'), '别名要切干净');
  } finally { await s.cleanup(); }
});

test('老版本节点只报数量：仍然如实说"传不回来"，不假装收到了', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.reply = '报表做好了';
    s.link.filesOnNode = 2;                 // 老节点：没有 files，只有数量
    const reply = await s.say('@家里那台 做个报表');
    assert.match(reply, /报表做好了/);
    assert.match(reply, /2 个文件/);
    assert.match(reply, /传不回来/, '不能让用户以为附件在路上');
    assert.equal(s.channel.sentFiles.length, 0);
  } finally { await s.cleanup(); }
});

// ───────────────────────── 远端产出的文件：真的搬回来 ─────────────────────────

test('远端交出来的附件真的搬到本机，而且微信里收到的是**本机路径**', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.reply = '报表做好了';
    s.link.remoteFiles.set('tk-1', {
      name: '报表.xlsx', caption: '这是你要的', data: Buffer.from('hello 报表'),
    });

    const reply = await s.say('@家里那台 做个报表');
    assert.match(reply, /报表做好了/);
    assert.doesNotMatch(reply, /传不回来/, '这回真的传回来了');

    assert.equal(s.channel.sentFiles.length, 1);
    const sent = s.channel.sentFiles[0];
    assert.equal(sent.opts.caption ?? sent.caption, undefined);   // caption 走 say，不进 sendFile
    assert.match(reply, /这是你要的/, '附件自带的那句话要带给用户');

    // 落盘的这条路**必须是本机真实存在、内容对得上的文件** ——
    // 这正是"路径在对面那台机器上不存在"这个坑要跨过去的地方
    assert.equal(existsSync(sent.path), true, `附件该在本机落盘：${sent.path}`);
    assert.equal(readFileSync(sent.path, 'utf8'), 'hello 报表');
    assert.notEqual(sent.path, '报表.xlsx', '不能把对面的原始路径留给微信');

    // 取完就把凭证还了，不在那台机器上留着
    assert.equal(s.link.remoteFiles.has('tk-1'), false);
  } finally { await s.cleanup(); }
});

test('大文件分块取回：不是一口气读进内存，字节数也对得上', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const big = Buffer.alloc(512 * 1024 + 777, 0x41);      // 刚过一个块
    s.link.remoteFiles.set('tk-big', { name: '大文件.bin', data: big });

    await s.say('@家里那台 发那个大文件');
    assert.equal(s.link.reads.length, 2, '512KiB 的块，1.0007 个文件要取两次');
    assert.deepEqual(s.link.reads.map((r) => r.offset), [0, 512 * 1024]);

    const path = s.channel.sentFiles[0].path;
    assert.equal(statSync(path).size, big.length, '取回来的字节数要跟那边一样');
  } finally { await s.cleanup(); }
});

test('取件失败：说清楚是哪个文件没取回来，而且**不会假装发出去了**', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.reply = '报表做好了';
    s.link.remoteFiles.set('tk-1', { name: '报表.xlsx', data: Buffer.from('x') });
    s.link.readError = new Error('连接被对面关掉了');

    const reply = await s.say('@家里那台 做个报表');
    assert.match(reply, /报表做好了/, '活是干完了的，要说');
    assert.match(reply, /1 个文件没取回来/);
    assert.match(reply, /报表.xlsx/, '得说清楚是哪一个');
    assert.equal(s.channel.sentFiles.length, 0, '没取回来就不能发 —— 发了个半截文件更坏');
  } finally { await s.cleanup(); }
});

test('对面给的文件名带路径也不会写到中转目录外面去', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.remoteFiles.set('tk-ok', { name: '正常的.txt', data: Buffer.from('a') });
    s.link.remoteFiles.set('tk-evil', { name: '../../.ssh/authorized_keys', data: Buffer.from('b') });

    await s.say('@家里那台 发那个文件');
    assert.equal(s.channel.sentFiles.length, 2);

    const dir = dirname(s.channel.sentFiles[0].path);
    for (const f of s.channel.sentFiles) {
      // 要守的那条不变量：**不管对面报什么名字，落盘位置都出不了中转目录**
      assert.equal(resolve(f.path).startsWith(resolve(dir) + sep), true, `跑到外面去了：${f.path}`);
      assert.doesNotMatch(f.path, /\.\.[\\/]/, `路径里不该出现 ../ ：${f.path}`);
    }
  } finally { await s.cleanup(); }
});

test('中转目录在停机时清干净（不留一堆取回来的文件在临时目录里）', async () => {
  const s = await setup();
  let dir = '';
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.remoteFiles.set('tk-1', { name: 'a.txt', data: Buffer.from('x') });
    await s.say('@家里那台 发个文件');
    dir = dirname(s.channel.sentFiles[0].path);
    assert.equal(existsSync(dir), true);
  } finally {
    await s.cleanup();
  }
  assert.equal(existsSync(dir), false, '停机后中转目录该没了');
});

// ───────────────────────── 会话不串 ─────────────────────────

test('会话按设备分开记：本机和那台机器各续各的', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));

    // 本机先来一条，拿到本机自己的会话
    await s.say('本机第一句');
    assert.equal(s.agent.seen[0].sessionId, null);
    assert.equal(s.agent.seen[0].text, '本机第一句');

    // 远端来一条 —— **不能把本机那个会话 id 带过去**
    await s.say('@家里那台 远端第一句');
    assert.equal(s.link.calls[0].params.sessionId, null, '远端第一条也必须是新会话');

    // 远端再来一条 —— 这次要带上次那个（r-1）
    await s.say('@家里那台 远端第二句');
    assert.equal(s.link.calls[1].params.sessionId, 'r-1', '远端要续上远端的会话');

    // 本机再来一条 —— **不能被远端的会话污染**
    await s.say('本机第二句');
    assert.equal(s.agent.seen[1].sessionId, 's-1', '本机要续上本机的会话');
  } finally { await s.cleanup(); }
});

test('会话分开记这件事，落盘后也分得开（同一个账号两台机器）', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    await s.say('本机第一句');
    await s.say('@家里那台 远端第一句');

    const saved = JSON.parse((await import('node:fs')).readFileSync(join(s.dir, 'state.json'), 'utf8'));
    const keys = Object.keys(saved.sessions);
    assert.equal(keys.length, 2, `两台机器该记两条，实际：${JSON.stringify(keys)}`);
    assert.ok(keys.includes('u1'), '本机那条沿用老键位（升级上来不能丢会话）');
    assert.ok(keys.includes('node-home#u1'), '远端那条带设备前缀');
  } finally { await s.cleanup(); }
});

// ───────────────────────── 进度 ─────────────────────────

test('远端的进度会播报到微信（不能只有本机才有）', async () => {
  const s = await setup({ progressIntervalMs: 25 });
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    // 远端先报一条进度，然后慢慢干 —— 这才是有机会被播报的真实形状
    s.link.progress = ['在那台机器上翻文件夹'];
    const origConnect = s.link.connect.bind(s.link);
    s.link.connect = async (id) => {
      const session = await origConnect(id);
      const origReq = session.request.bind(session);
      session.request = async (m, p, o) => {
        for (const line of s.link.progress) o?.onEvent?.({ type: 'progress', callId: 'c1', line });
        await sleep(150);
        return origReq(m, p, o);
      };
      return session;
    };

    const before = s.channel.texts().length;
    s.channel.push({ text: '@家里那台 干个慢活' });
    await waitFor(() => s.channel.texts().length > before, '播报');
    await s.channel.settle();
    await sleep(60);

    const all = s.channel.texts().join('\n');
    assert.match(all, /在那台机器上翻文件夹/, '远端的进度必须能传回微信');
  } finally { await s.cleanup(); }
});

// ───────────────────────── 说不清楚的时候 ─────────────────────────

test('不认识的设备名：报名字，并列出知道的设备（含在线状态）', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'), device('node-work', '公司电脑', false));
    const reply = await s.say('@同事的电脑 帮我看看');
    assert.match(reply, /没有叫「同事的电脑」的设备/);
    assert.match(reply, /家里那台/);
    assert.match(reply, /公司电脑（不在线）/);
    assert.equal(s.link.calls.length, 0, '认不出来的名字不能硬发');
    assert.equal(s.agent.seen.length, 0, '也不能在本机偷偷办');
    assert.doesNotMatch(reply, /agent 出错/, '这不是 agent 的错，别把用户引到错的地方去查');
  } finally { await s.cleanup(); }
});

test('只 @ 了不说干什么：直接问它，不发空话过去', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const reply = await s.say('@家里那台');
    assert.match(reply, /你想让「家里那台」做什么？/);
    assert.equal(s.link.calls.length, 0);
  } finally { await s.cleanup(); }
});

test('那台电脑连不上：如实说，并带上原因', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    s.link.connectError = new Error('那台电脑没开机（连接被拒绝）');
    const reply = await s.say('@家里那台 把桌面理一理');

    assert.match(reply, /「家里那台」连不上/);
    assert.match(reply, /没开机/, '原因要带出来 —— 只说"失败了"等于没说');
    assert.equal(s.agent.seen.length, 0, '连不上也不能悄悄改成在本机办');
  } finally { await s.cleanup(); }
});

test('远端跑一半断了：如实说，不复述成"任务中止"', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const orig = s.link.connect.bind(s.link);
    s.link.connect = async (id) => {
      const session = await orig(id);
      session.request = async () => { throw new Error('连接被对面关掉了'); };
      return session;
    };
    const reply = await s.say('@家里那台 干个活');
    assert.match(reply, /「家里那台」那边断了/);
    assert.match(reply, /连接被对面关掉了/);
  } finally { await s.cleanup(); }
});

test('列不出设备：如实说是"列不出"，不是"没有这台设备"', async () => {
  const s = await setup();
  try {
    s.link.discoverError = new Error('peers 配置有问题');
    const reply = await s.say('@家里那台 干个活');
    assert.match(reply, /我列不出设备/);
    assert.match(reply, /peers 配置有问题/);
  } finally { await s.cleanup(); }
});

test('这台机器没装链路：说人话，不崩', async () => {
  const s = await setup({}, { withLink: false });
  try {
    const reply = await s.say('@家里那台 干个活');
    assert.match(reply, /还没接设备/);
    assert.match(reply, /ctx\.link/);
    assert.equal(s.agent.seen.length, 0);
  } finally { await s.cleanup(); }
});

test('带附件 @ 远端：明确拒绝，而且**一个字节都没发过去**', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const reply = await s.say('@家里那台 处理一下这个', [
      { path: '/tmp/本地文件.pdf', name: '本地文件.pdf' },
    ]);

    assert.match(reply, /附件现在还送不到「家里那台」上/);
    assert.match(reply, /不加 @/, '要给出路，不能只说不行');
    assert.equal(s.link.calls.length, 0, '只发话过去会让对面的 agent 拿到一个不存在的路径');
    assert.equal(s.agent.seen.length, 0);
  } finally { await s.cleanup(); }
});

test('带附件不 @：本机正常处理（附件这条路没被误伤）', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const reply = await s.say('处理一下这个', [{ path: '/tmp/本地文件.pdf', name: '本地文件.pdf' }]);
    assert.equal(s.agent.seen.length, 1);
    assert.match(s.agent.seen[0].text, /本地文件\.pdf/, '本机路径要兜底附在话里');
    assert.match(reply, /好的/);
  } finally { await s.cleanup(); }
});

// ───────────────────────── 收尾 ─────────────────────────

test('远端会话用完就关（不为了省一次握手把连接一直挂着）', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    await s.say('@家里那台 干个活');
    await s.say('@家里那台 再干个活');
    assert.equal(s.link.closed, 2, '两次请求该关两次');
    assert.equal(s.link.calls.length, 2);
  } finally { await s.cleanup(); }
});

test('排队：远端那条在跑的时候，本机那条也要排队（还是同一条队列）', async () => {
  const s = await setup();
  try {
    withDevices(s.link, device('node-home', '家里那台'));
    const orig = s.link.connect.bind(s.link);
    s.link.connect = async (id) => {
      const session = await orig(id);
      const origReq = session.request.bind(session);
      session.request = async (m, p, o) => { await sleep(80); return origReq(m, p, o); };
      return session;
    };

    s.channel.push({ text: '@家里那台 慢活' });
    s.channel.push({ text: '本机快活' });
    // 要等的是**可观察的结果**：远端那条真的干完了（它要跨链路、还故意慢 80 毫秒）。
    // 等计数或等"通道安静了一会儿"都不行 —— 安静期会落在两条中间，计数会早于请求打点。
    await waitFor(() => s.channel.texts().join('\n').includes('远端干完了'), '远端干完了', 5000);
    await waitFor(() => s.agent.seen.length === 1, '本机那条轮到了', 5000);

    assert.equal(s.agent.seen.length, 1);
    assert.equal(s.link.calls.length, 1);
    const all = s.channel.texts().join('\n');
    assert.match(all, /远端干完了/);
    assert.match(all, /前面还有 1 条，排上了/, '远端那条在跑时，本机那条确实排了队');
    assert.match(all, /好的/);
  } finally { await s.cleanup(); }
});
