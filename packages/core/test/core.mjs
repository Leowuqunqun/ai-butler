/**
 * 内核的行为测试。
 *
 *   node --test test/core.mjs
 *
 * 全部离线可跑：假通道 / 假 agent 都是真的继承了那两个 seam 的类，
 * 所以这里验证的是"接线真的通、边界真的守住了"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ButlerCore } from '@butler/core';
import { FakeAgent, FakeChannel } from './.build/harness.js';
import { useButlerShim, withoutButler } from './fixtures/path-shim.mjs';

// 内核自检里有一条量**环境里的 PATH** 的（"管家自己找得到 butler 吗"）。
// 测试机上没有 butler，所以给它一个**真 shim**：改环境，不改判据。
// ⚠️ 这里造绿不算数 —— 真正把关的是 scripts/verify-clean-install.sh（真装出来的进程）。
useButlerShim();

/** 起一个装好假通道 + 假 agent + 内核的环境 */
async function setup(coreCfg = {}, agentCfg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-core-'));
  // 开场白默认关掉：老用例量的都是「这一轮回了什么」，多一句「我是你的管家」会把账搅浑。
  // 专门量开场白的用例自己换一条**没有这份文件**的状态路径（见 commands.mjs 里那条 ★）。
writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(FakeAgent, agentCfg);
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,          // 默认不播报，免得干扰别的断言
    ...coreCfg,
  });
  return {
    ctx,
    channel: ctx.channel,
    agent: ctx.agent,
    core: ctx.core,
    dir,
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, what = '条件', ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`等「${what}」超时了（${ms}ms）`);
    await sleep(5);
  }
}

// ───────────────────────── 接线 ─────────────────────────


/**
 * 一个**保证不存在**的路径：在一个新建的临时目录里取一个没建过的名字。
 *
 * ⚠️ 别硬编码 `/tmp/绝对不会存在` 这种哨兵路径 —— `/tmp` 是共享的，
 * 早先的测试跑过、或者别的工具建过，它就真存在了，然后这条断言开始
 * 无缘无故地红。这是实测踩过的（`/tmp/绝对没有这个目录-zzz` 真的在）。
 */
function missing(name) {
  return join(mkdtempSync(join(tmpdir(), 'gone-')), name);
}

test('依赖不齐时内核根本不加载；齐了才注册 ctx.core', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeChannel);          // 只有通道，没有 agent
    await ctx.plugin(ButlerCore);
    assert.equal(ctx.core, undefined, 'agent 不在，内核不该被构造');

    await ctx.plugin(FakeAgent);
    assert.ok(ctx.core, 'agent 到位后内核应当自动就位');
  } finally {
    await ctx.fiber.dispose();
  }

  const ctx2 = new Context();
  try {
    await ctx2.plugin(FakeAgent);           // 只有 agent，没有通道
    await ctx2.plugin(ButlerCore);
    assert.equal(ctx2.core, undefined, '通道不在，内核不该被构造');
  } finally {
    await ctx2.fiber.dispose();
  }
});

test('加载 ≠ 上线：不调 start() 就不会开始收信', async () => {
  const t = await setup();
  try {
    t.channel.push({ text: '你好' });
    await sleep(50);
    assert.equal(t.channel.startCount, 0, '没 start 过，通道不该被拉起来');
    assert.equal(t.agent.seen.length, 0, '没上线就不该干活');
  } finally { await t.cleanup(); }
});

test('start() 幂等，并且真的把通道拉起来', async () => {
  const t = await setup();
  try {
    await t.core.start();
    await t.core.start();          // 再来一次
    assert.equal(t.channel.started, true);
    assert.equal(t.channel.startCount, 1, '重复 start 不该拉两次');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 端到端 ─────────────────────────

test('一条消息走完全程：通道 → 内核 → agent → 回话', async () => {
  const t = await setup({}, { reply: '干活干完了' });
  try {
    await t.core.start();
    t.channel.push({ text: '把报表整理一下' });

    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.equal(t.agent.seen.length, 1, 'agent 应当被叫了一次');
    assert.equal(t.agent.seen[0].text, '把报表整理一下');
    assert.equal(t.agent.seen[0].cwd, t.dir, '工作目录要传给 agent');
    assert.equal(t.channel.sent[0].to, 'u1');
    assert.equal(t.channel.sent[0].text, '干活干完了', '正文里不该有内核加的任何东西');
    // "在回哪句"只作为**一个字段**交下去：怎么显示（顶一行文本 / 原生引用）是通道的事
    assert.equal(t.channel.sent[0].opts.quote, '把报表整理一下', '要把"在回哪句"交给通道');
    assert.equal(t.channel.sent[0].opts.contextToken, 'tk', 'contextToken 要透传（引用/上传都要它）');
  } finally { await t.cleanup(); }
});

test('quoteReply=false 时不加引用行', async () => {
  const t = await setup({ quoteReply: false });
  try {
    await t.core.start();
    t.channel.push({ text: '在吗' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.equal(t.channel.sent[0].text, '好的');
  } finally { await t.cleanup(); }
});

test('会话续接：第二条带上第一条返回的 sessionId', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push({ text: '第一句' });
    await waitFor(() => t.channel.sent.length === 1, '第一次回话');
    await t.channel.settle();
    t.channel.push({ text: '第二句' });
    await waitFor(() => t.channel.sent.length === 2, '第二次回话');
    await t.channel.settle();

    assert.equal(t.agent.seen[0].sessionId, null, '第一次是新会话');
    assert.equal(t.agent.seen[1].sessionId, 's-1', '第二次要续上第一次的会话');
  } finally { await t.cleanup(); }
});

test('会话落盘：换一个内核实例还记得 sessionId', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push({ text: '第一句' });
    await waitFor(() => t.channel.sent.length === 1, '回话');
    await t.channel.settle();
    await t.core.stop();

    const saved = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'));
    assert.equal(saved.sessions.u1, 's-1', '会话要落到账本上');

    // 同一个账本、新的内核：第二条要续上
    const ctx2 = new Context();
    await ctx2.plugin(FakeChannel);
    await ctx2.plugin(FakeAgent);
    await ctx2.plugin(ButlerCore, { workspace: t.dir, stateFile: join(t.dir, 'state.json'), progressIntervalMs: 0 });
    try {
      await ctx2.core.start();
      ctx2.channel.push({ text: '重启之后' });
      await waitFor(() => ctx2.channel.sent.length > 0, '回话');
      await ctx2.channel.settle();
      assert.equal(ctx2.agent.seen[0].sessionId, 's-1', '重启也要记得会话');
    } finally { await ctx2.fiber.dispose(); }
  } finally { await t.cleanup(); }
});

// ───────────────────────── 安全边界 ─────────────────────────

test('认主：第一条来信的人成为主人，第二个人被静默挡在外面', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push({ fromId: 'u1', text: '我是主人' });
    await waitFor(() => t.channel.sent.length === 1, '第一次回话');
    await t.channel.settle();
    assert.equal(t.core.owner, 'u1', 'u1 应当认主');

    t.channel.push({ fromId: 'u2', text: '我是别人' });
    await sleep(60);
    assert.equal(t.agent.seen.length, 1, 'u2 的话绝不能送到 agent');
    assert.equal(t.channel.sent.length, 1, '对陌生人连话都不该回（别让它变成探测工具）');
  } finally { await t.cleanup(); }
});

test('认主只认一次：先来的是主人，后面换个人也顶不掉', async () => {
  const t = await setup({ stateFile: join(mkdtempSync(join(tmpdir(), 'b-')), 's.json') });
  try {
    assert.equal(t.core.owner, null);
    await t.core.start();
    t.channel.push({ fromId: 'u1', text: '甲' });
    await waitFor(() => t.channel.sent.length === 1, '回话');
    await t.channel.settle();
    t.channel.push({ fromId: 'u2', text: '乙' });
    await sleep(60);
    assert.equal(t.core.owner, 'u1', '主人不能被顶掉');
  } finally { await t.cleanup(); }
});

test('配了 allowFrom 就按名单走，不走认主', async () => {
  const t = await setup({ allowFrom: ['u2'] });
  try {
    await t.core.start();

    t.channel.push({ fromId: 'u1', text: '我不在名单' });
    await sleep(60);
    assert.equal(t.agent.seen.length, 0, '名单外的人不许进来');
    assert.equal(t.core.owner, null, '配了名单就不该认主');

    t.channel.push({ fromId: 'u2', text: '我在名单' });
    await waitFor(() => t.channel.sent.length === 1, '回话');
    await t.channel.settle();
    assert.equal(t.agent.seen.length, 1);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 附件 ─────────────────────────

test('纯附件：给一句起步提示，并把本机路径附在末尾兜底', async () => {
  const t = await setup();
  try {
    await t.core.start();
    const files = [{ path: '/tmp/inbox/报表.png', name: '报表.png', mime: 'image/png', size: 12, kind: 'image' }];
    t.channel.push({ text: '' }, files);

    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    const req = t.agent.seen[0];
    assert.match(req.text, /我发来一个图片/, '没文字时要有起步提示');
    assert.match(req.text, /\/tmp\/inbox\/报表\.png/, '路径要附在末尾——不认识 files 的后端也能读');
    assert.deepEqual(req.files, files, 'files 字段也要原样传下去（多模态后端靠它）');
  } finally { await t.cleanup(); }
});

test('agent 要发的附件会被真的发出去', async () => {
  const t = await setup({}, { reply: '给你报表', files: ['/tmp/out/report.xlsx'] });
  try {
    await t.core.start();
    t.channel.push({ text: '给我报表' });
    await waitFor(() => t.channel.sentFiles.length > 0, '附件发出');
    assert.equal(t.channel.sentFiles[0].path, '/tmp/out/report.xlsx');
    assert.equal(t.channel.sent[0].text, '给你报表');
    assert.equal(t.channel.sent[0].opts.quote, '给我报表');
  } finally { await t.cleanup(); }
});

test('★ 引用规则：终结性回复一律引用，过程性消息一律不引用', async () => {
  const t = await setup({}, { reply: '答案' });
  try {
    await t.core.start();

    // ① 命令结果（终结性）：这条消息的事就此办完 → 要引用
    t.channel.push({ text: '设备' });
    await waitFor(() => t.channel.sent.length > 0, '命令回话');
    await t.channel.settle();
    assert.equal(t.channel.sent[0].opts.quote, '设备', '命令结果也是"在回答这条消息"');

    // ② agent 出错（终结性）：和正常答复一样引用 —— 用户才分得清是哪条挂了
    t.agent.hook = () => ({ error: '模型连不上' });
    t.channel.push({ text: '这条会挂' });
    await waitFor(() => t.channel.sent.some((x) => /agent 出错/.test(x.text)), '出错回话');
    const boom = t.channel.sent.find((x) => /agent 出错/.test(x.text));
    assert.equal(boom.opts.quote, '这条会挂', '出错也是这条消息的终结性回复');
  } finally { await t.cleanup(); }
});

test('★ 只发附件没说话：出站引用退回一句附件描述（不然连发几张图分不清哪张对应哪句）', async () => {
  const files = [{ path: '/tmp/报表.xlsx', name: '报表.xlsx', mime: 'application/vnd.ms-excel', size: 2048, kind: 'file' }];
  const t = await setup({}, { reply: '看完了' });
  try {
    await t.core.start();
    t.channel.push({ text: '' }, files);
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.equal(t.channel.sent[0].opts.quote, '[文件（报表.xlsx）]');

    // 图片的名字是我们自己起的，给用户看没意义 —— 只报类别
    t.channel.push({ text: '' }, [{ path: '/tmp/a.jpg', name: 'inbound-1726.jpg', mime: 'image/jpeg', size: 9, kind: 'image' }]);
    await waitFor(() => t.channel.sent.length > 1, '第二条回话');
    await t.channel.settle();
    assert.equal(t.channel.sent[1].opts.quote, '[图片]');
  } finally { await t.cleanup(); }
});

test('★ 用户引用了一句话：agent 看得到（提示词里），但路由不看它', async () => {
  const t = await setup({}, { reply: '这就发' });
  try {
    await t.core.start();
    // 引用里出现 `@家里那台` —— 如果它并进正文，这条消息会被路由到那台设备去执行
    t.channel.push({ text: '再发一次', quote: '@家里那台 昨天那个 PPT' });

    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();

    assert.equal(t.agent.seen.length, 1, 'agent 该在本机跑（被路由走的话它根本不会被叫）');
    assert.equal(
      t.agent.seen[0].text,
      '[引用: @家里那台 昨天那个 PPT]\n再发一次',
      '引用作为上下文顶在提示词前面',
    );
    assert.equal(t.channel.sent[0].opts.quote, '再发一次', '出站引用的是他这次说的话，不是引用里那句');
    assert.equal(t.channel.sent[0].text, '这就发', '正文里不该有引用装饰（那是通道的事）');
  } finally { await t.cleanup(); }
});

test('附件发失败必须明说，不能假装发出去了', async () => {
  const t = await setup({}, { reply: '给你报表', files: ['/tmp/out/report.xlsx'] });
  try {
    await t.core.start();
    // 正文能发，附件那条失败
    let n = 0;
    const real = t.channel.sendFile.bind(t.channel);
    t.channel.sendFile = async (to, path, opts) => {
      if (path === '/tmp/out/report.xlsx') throw new Error('文件太大了');
      return real(to, path, opts);
    };
    t.channel.push({ text: '给我报表' });
    await waitFor(() => t.channel.texts().some((x) => /附件发送失败/.test(x)), '失败提示');
    assert.ok(t.channel.texts().some((x) => /文件太大了/.test(x)), '要说清楚为什么失败');
    n = t.channel.sentFiles.length;
    assert.equal(n, 0, '没发成功就不该记成发过了');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 排队 ─────────────────────────

test('前面有活时会说"排上了"，然后按顺序一条一条来', async () => {
  const t = await setup({}, { delayMs: 60 });
  try {
    await t.core.start();
    t.channel.push({ text: '第一句' });
    await waitFor(() => t.agent.seen.length === 1, '开始干第一句');
    t.channel.push({ text: '第二句' });

    await waitFor(() => t.channel.sent.length === 3, '两条都回完');
    await t.channel.settle();

    assert.equal(t.agent.seen[0].text, '第一句');
    assert.equal(t.agent.seen[1].text, '第二句');

    // 顺序本身就是结论：先给排队回执，再按序回话。
    // 每条带的 quote 顺带证明了"哪句回的是哪句"没串。
    assert.match(t.channel.texts()[0], /前面还有 1 条/, '先给一条排队回执');
    assert.equal(t.channel.sent[0].opts.quote, undefined, '排队回执不是"在回答某句话"，不该带引用');
    assert.deepEqual(
      t.channel.sent.slice(1).map((s2) => [s2.text, s2.opts.quote]),
      [['好的', '第一句'], ['好的', '第二句']],
      '正文干净、quote 各归各位',
    );
  } finally { await t.cleanup(); }
});

test('积压超过上限就明确拒收，不静默丢', async () => {
  const t = await setup({ maxQueue: 1 }, { delayMs: 80 });
  try {
    await t.core.start();
    t.channel.push({ text: '第一条' });                 // 立刻开始跑
    await waitFor(() => t.agent.seen.length === 1, '开始跑');
    t.channel.push({ text: '第二条' });                 // 进队列（满 1）
    t.channel.push({ text: '第三条' });                 // 超了

    await waitFor(() => t.channel.texts().some((x) => /先不接了/.test(x)), '拒收提示');
    await waitFor(() => t.agent.seen.length === 2, '前两条都干完');
    assert.equal(t.agent.seen.length, 2, '第三条必须没被处理——明确拒收而不是偷偷丢');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 等待可见性 ─────────────────────────

test('长任务：不发进度的话用户看到的就是"没反应"——所以要定期播报', async () => {
  const t = await setup({ progressIntervalMs: 20 }, { delayMs: 120, progress: '正在读 config.ts' });
  try {
    await t.core.start();
    t.channel.push({ text: '慢慢来' });

    await waitFor(() => t.channel.texts().some((x) => /还在处理/.test(x)), '进度播报');
    const ping = t.channel.texts().find((x) => /还在处理/.test(x));
    assert.match(ping, /已 \d+s/, '要报已经等了多久');
    // 过程性消息**不引用**：每收到一条"还在处理…"都被引用一次，看着很吵
    const pingSent = t.channel.sent.find((s) => /还在处理/.test(s.text));
    assert.equal(pingSent.opts.quote, undefined, '进度播报不是"在回答某句话"');
    assert.match(ping, /正在读 config\.ts/, '要把 agent 最近一条进度带上——这才是"它在干什么"');
  } finally { await t.cleanup(); }
});

test('progressIntervalMs=0 时一条进度都不发', async () => {
  const t = await setup({ progressIntervalMs: 0 }, { delayMs: 40 });
  try {
    await t.core.start();
    t.channel.push({ text: '干活' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.equal(t.channel.texts().filter((x) => /还在处理/.test(x)).length, 0);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 失败 ─────────────────────────

test('agent 返回 error 时如实转述，并且带上跑了多久', async () => {
  const t = await setup({}, { error: '模型没配 key' });
  try {
    await t.core.start();
    t.channel.push({ text: '干活' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.match(t.channel.sent[0].text, /（agent 出错，\d+s）/);
    assert.match(t.channel.sent[0].text, /模型没配 key/, '原因要原样带给用户');
  } finally { await t.cleanup(); }
});

test('agent 抛异常：兜住、如实回话，worker 不能被打死', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.agent.hook = (_req, n) => { if (n === 1) throw new Error('内核不该被我带崩'); };

    t.channel.push({ text: '第一次' });
    await waitFor(() => t.channel.texts().some((x) => /我这边出错了/.test(x)), '出错回话');
    assert.ok(t.channel.texts().some((x) => /内核不该被我带崩/.test(x)), '要把原因说出来');

    // 第二次必须还能干活 —— 一条消息处理崩了不该让管家从此装死
    t.channel.push({ text: '第二次' });
    await waitFor(() => t.agent.seen.length === 2, '第二次也进了 agent');
    await waitFor(() => t.channel.texts().some((x) => /好的/.test(x)), '第二次正常回话');
  } finally { await t.cleanup(); }
});

test('agent 没出结果也没报错：明说"没出结果"，不能沉默', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.agent.hook = () => ({ sessionId: null, text: '   ' });   // 空白等于没结果

    t.channel.push({ text: '干活' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.match(t.channel.sent[0].text, /没出结果/, '沉默是最坏的体验，必须说点什么');
  } finally { await t.cleanup(); }
});

test('SESSION_LOCKED：丢掉旧会话、开新的重试一次', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.push({ text: '第一句' });
    await waitFor(() => t.channel.sent.length === 1, '第一次回话');   // 拿到 s-1

    t.agent.hook = (req, n) => {
      if (n === 2) return { sessionId: 's-1', error: '会话被占用', code: 'SESSION_LOCKED' };
      return { sessionId: 's-9', text: '重试成功了' };
    };
    t.channel.push({ text: '第二句' });
    await waitFor(() => t.channel.texts().some((x) => /重试成功了/.test(x)), '重试结果');

    assert.equal(t.agent.seen[1].sessionId, 's-1', '第一次带旧会话');
    assert.equal(t.agent.seen[2].sessionId, null, '重试必须换新会话（否则还是被占着）');
    assert.equal(JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8')).sessions.u1, 's-9', '新会话要记下来');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 正在输入 ─────────────────────────

test('正在输入成对开关，且出错路径也要关掉', async () => {
  const t = await setup({}, { error: '炸' });
  try {
    await t.core.start();
    t.channel.push({ text: '干活' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.deepEqual(t.channel.typing, [{ to: 'u1', on: true }, { to: 'u1', on: false }]);
  } finally { await t.cleanup(); }
});

test('typing=false 时一次都不发', async () => {
  const t = await setup({ typing: false });
  try {
    await t.core.start();
    t.channel.push({ text: '干活' });
    await waitFor(() => t.channel.sent.length > 0, '回话');
    await t.channel.settle();
    assert.deepEqual(t.channel.typing, []);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 停机 ─────────────────────────

test('回话发不出去时不崩：只记日志，worker 继续能用', async () => {
  const t = await setup();
  try {
    await t.core.start();
    t.channel.sendError = new Error('网络断了');
    t.channel.push({ text: '第一句' });
    await waitFor(() => t.agent.seen.length === 1, '尝试过');

    t.channel.sendError = null;
    t.channel.push({ text: '第二句' });
    await waitFor(() => t.channel.sent.length === 1, '恢复后正常回话');
    await t.channel.settle();
  } finally { await t.cleanup(); }
});

test('停机：不等在跑的那一轮，直接掐断（agent 一跑可能几分钟）', async () => {
  const t = await setup({}, { hang: true });
  try {
    await t.core.start();
    t.channel.push({ text: '跑个很久的活' });
    await waitFor(() => t.agent.seen.length === 1, '开始跑');

    const t0 = Date.now();
    await t.core.stop();
    const cost = Date.now() - t0;

    assert.ok(cost < 1000, `停机不该干等（实际 ${cost}ms）`);
    assert.equal(t.agent.aborted, 1, '在跑的那轮必须被 signal 掐断');
    assert.equal(t.channel.started, false, '通道也要停');
  } finally { await t.cleanup(); }
});

test('卸载 ctx 时会自带收尾：通道停掉、消费者摘掉', async () => {
  const t = await setup();
  await t.core.start();
  t.channel.push({ text: '干活' });
  await waitFor(() => t.channel.sent.length > 0, '回话');
  await t.channel.settle();

  await t.ctx.fiber.dispose();
  assert.equal(t.channel.started, false, '卸载要停通道');
  assert.equal(t.ctx.core, undefined, '服务位要消失');
  rmSync(t.dir, { recursive: true, force: true });
});

// ───────────────────────── 自检 check() ─────────────────────────

const byName = (checks, name) => checks.find((c) => c.name.includes(name));

test('check：工作目录在就报"agent 在这儿干活"', async () => {
  const t = await setup();
  try {
    const c = byName(t.core.check(), '工作目录');
    assert.equal(c.ok, true);
    assert.match(c.detail, /干活/, '过一个检查也要说清它是干什么的');
  } finally { await t.cleanup(); }
});

test('check：工作目录不存在 → 不合格并给出路', async () => {
  const t = await setup({ workspace: missing('workdir') });
  try {
    const c = byName(t.core.check(), '工作目录');
    assert.equal(c.ok, false);
    assert.match(c.fix, /建出来|改成别的目录/);
  } finally { await t.cleanup(); }
});

test('check：还没认主时说清"第一个说话的人就是主人"', async () => {
  const t = await setup();
  try {
    const c = byName(t.core.check(), '谁能指挥它');
    assert.equal(c.ok, true);
    assert.match(c.detail, /第一个/);
  } finally { await t.cleanup(); }
});

test('check：认了主之后要说清"别人发消息它会一声不吭"（这是安全行为，但用户看不出来）', async () => {
  const t = await setup();
  try {
    t.channel.push('在吗');
    await waitFor(() => t.core.owner, '认主');
    const c = byName(t.core.check(), '谁能指挥它');
    assert.match(c.detail, /已认主/);
    assert.match(c.detail, /一声不吭/, '这条不说，用户会以为坏了');
    assert.match(c.fix, /allowFrom|重新认主/, '换人用要给出路');
  } finally { await t.cleanup(); }
});

/**
 * ⚠️ `stateFile` 为空 = 账本**只在内存里**（`SessionStore` 拿不到路径）。
 * 这时说"已认主"是**不完整**的：重启之后第一个说话的人又会成为主人 ——
 * 企业租户里 `dmMode` 默认 open，这不是小事。而手册教人去改的
 * `<管家目录>/state/state.json` 在**根本不存在**的那一边。
 */
test('★ check：认主**没落盘**时要当场说破（不然重启之后谁先说话谁当家）', async () => {
  const t = await setup({ stateFile: '' });
  try {
    t.channel.push('在吗');
    await waitFor(() => t.core.owner, '认主');
    const c = byName(t.core.check(), '谁能指挥它');
    assert.match(c.detail, /没落盘/, '不落盘这件事必须说出来');
    assert.match(c.detail, /重启/, '而且要说清后果');
    assert.match(c.fix, /stateFile/, '还要给一条能照着做的出路 —— 光说"有问题"等于没说');
  } finally { await t.cleanup(); }
});

test('check：配置里写死了 allowFrom 时，报的是名单不是认主', async () => {
  const t = await setup({ allowFrom: ['a@x', 'b@x'] });
  try {
    const c = byName(t.core.check(), '谁能指挥它');
    assert.equal(c.ok, true);
    assert.match(c.detail, /2 个/);
    assert.match(c.detail, /allowFrom/);
  } finally { await t.cleanup(); }
});

test('check 绝不抛错', async () => {
  const t = await setup({ workspace: '/nope', stateFile: '/nope/s.json' });
  try {
    assert.doesNotThrow(() => t.core.check());
  } finally { await t.cleanup(); }
});

// ── 管家自己找得到 butler 吗 ──────────────────────────────────────
//
// 这一条量的是**本进程环境里的 PATH**（只有管家自己知道），所以在开发机上
// 必然报 ✗。上面那个 `useButlerShim()` 给它铺了一个真的可执行文件 —— 这里
// 验的是判据本身：找得到就说找得到、找不到就说找不到并给路。

test('★ check：PATH 里有 butler → ✓，并说清找到的是哪一个', async () => {
  const shim = useButlerShim();
  const t = await setup();
  try {
    const c = byName(t.core.check(), '管家自己找得到 butler');
    assert.equal(c.ok, true, 'PATH 里有可执行的 butler，就该说找得到');
    assert.ok(c.detail.includes(shim), `光一个勾没用，要说清找到的是哪儿：${c.detail}`);
    assert.match(c.detail, /在微信里让它自己/, '过了也要说清这一条在保什么');
  } finally { await t.cleanup(); }
});

test('★ check：PATH 里没有 butler → ✗，并给出"重跑安装器"这条出路', async () => {
  const t = await setup();
  try {
    await withoutButler(async () => {
      const c = byName(t.core.check(), '管家自己找得到 butler');
      assert.equal(c.ok, false, '找不到就必须报 ✗ —— 报绿的话主人永远不知道那条路是断的');
      assert.match(c.detail, /子 shell/, '要说清后果：它自己起的那个 shell 里没有这个命令');
      assert.match(c.fix, /安装器/, '出路是重跑安装器（它会把那个目录放进管家自己的 PATH）');
    });
  } finally { await t.cleanup(); }
});

test('★ 入队那一步抛错不会变成 unhandled rejection（通道不该因此掉线）', async () => {
  const t = await setup();
  try {
    // 让"入队"这一步自己炸 —— 最像的真实形状是认主 / 写状态文件失败
    t.core.onMessage = async () => { throw new Error('入队时就炸了'); };

    // 真走接缝那条路：通道 emit → 接缝的 try/catch → 内核注册的那个 wrapper。
    // 接缝**只接得住同步抛错**，所以这条 async 链以前没有落点：rejection 变成 unhandled，
    // 而 `node --test` 会把它升级成失败 —— 也就是说这个用例本身就是判据。
    const msg = { channel: 'fake', fromId: 'ou_someone', text: '在吗', contextToken: '{}' };
    assert.doesNotThrow(() => t.channel.emitMessage(msg));
    await sleep(30);
  } finally {
    await t.cleanup();
  }
});
