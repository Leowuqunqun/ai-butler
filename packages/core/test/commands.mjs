/**
 * 微信里那几句**命令**的测试 —— 假通道 + 假 agent + 假链路 + 真内核。
 *
 * 这里要钉死的是两件相反的事：
 *
 *   ① 该认的认出来：配对、设备列表、忘掉，动作明确、参数正确、回话是人话
 *   ② **不该认的一个都别认**：用户一句正常的话不能被管家当命令执行
 *
 * ② 才是这一层真正的风险。所以边界那几条写得比功能那几条还细。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ButlerCore } from '@butler/core';
import { describeForUser, findDevice, osName, parseCommand } from '@butler/core';
import { FakeAgent, FakeApproval, FakeChannel, FakeLink, FakeMemory, FakePairingLink, device } from './.build/harness.js';
import { useButlerShim } from './fixtures/path-shim.mjs';

// 内核自检里有一条量 PATH 的（"管家自己找得到 butler 吗"）。给它一个真 shim，
// 让这一整个文件里的「自检」报告跟一台**装好的机器**上一样（那一项是 ✓）。
// ⚠️ 这里造绿不算数 —— 真正把关的是 scripts/verify-clean-install.sh。
useButlerShim();

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function waitFor(fn, what = '条件', ms = 3000) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) assert.fail(`等不到：${what}`);
    await sleep(10);
  }
}

/** 起一个容器。`Link` 传哪个假链路就验哪条分支；`withMemory` 决定装不装记忆 */
async function setup(Link = FakePairingLink, coreCfg = {}, withMemory = false, withApproval = false) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-cmd-'));
  // 开场白默认关掉：老用例量的都是「这一轮回了什么」，多一句「我是你的管家」会把账搅浑。
  // 专门量开场白的用例自己换一条**没有这份文件**的状态路径（见 commands.mjs 里那条 ★）。
writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(FakeAgent);
  if (withMemory) await ctx.plugin(FakeMemory);
  if (withApproval) await ctx.plugin(FakeApproval);
  if (Link) await ctx.plugin(Link);
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,
    approvalIntervalMs: 25,
    ...coreCfg,
  });
  await ctx.core.start();

  /** 等到通道上不再冒新回话为止（一小段安静期），用来判断"这一轮说完了" */
  async function settle(quietMs = 60, maxMs = 3000) {
    const until = Date.now() + maxMs;
    let last = ctx.channel.texts().length;
    for (;;) {
      await sleep(quietMs);
      const now = ctx.channel.texts().length;
      if (now === last) return;
      last = now;
      if (Date.now() > until) return;
    }
  }

  return {
    ctx,
    channel: ctx.channel,
    agent: ctx.agent,
    link: Link ? ctx.link : undefined,
    memory: withMemory ? ctx.memory : undefined,
    approval: withApproval ? ctx.approval : undefined,
    dir,
    /**
     * 说一句，然后等**这一轮说完**再把回话交出去。
     *
     * 一轮里可能不止一条：刚认下主人时会先说一句"我是你的管家"再说正事。
     * 只等到"出现了第一条"就往下走，用例会在"配对还没跑完"的时候就开始断言 —— 假红。
     */
    async say(text) {
      const before = ctx.channel.texts().length;
      ctx.channel.push({ text });
      await waitFor(() => ctx.channel.texts().length > before, `回话：${text.slice(0, 24)}`);
      await settle();
      return ctx.channel.texts().slice(before).join('\n');
    },
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────── ① 认句子：边界在哪 ─────────────────────────

test('认句子：node 打出来的那一行，原样发过来就能认', () => {
  assert.deepEqual(
    parseCommand('配对 192.168.1.9:41338 4A7-K2M'),
    { kind: 'pair', host: '192.168.1.9', port: 41338, code: '4A7-K2M' },
  );
  // 抄的时候少个横线、多个空格、没写端口，都要认
  assert.deepEqual(parseCommand('配对 192.168.1.9 4A7K2M'), { kind: 'pair', host: '192.168.1.9', port: null, code: '4A7K2M' });
  assert.deepEqual(parseCommand('  配对   10.0.0.9:41338   4A7-K2M  '), { kind: 'pair', host: '10.0.0.9', port: 41338, code: '4A7-K2M' });
  // 顺序反过来也认：用户抄的时候可能先看到码
  assert.equal(parseCommand('pair 4A7-K2M 10.0.0.9')?.kind, 'pair');

  assert.deepEqual(parseCommand('设备'), { kind: 'devices' });
  assert.deepEqual(parseCommand('devices'), { kind: 'devices' });
  assert.deepEqual(parseCommand('忘掉 家里那台'), { kind: 'forget', name: '家里那台' });
  assert.deepEqual(parseCommand('命令'), { kind: 'help' });
});

test('认句子：**像命令但不是在说命令**的，一律放给 agent', () => {
  // 这几条是这一层真正的风险：错认的代价是用户一句正常的话被当命令执行
  for (const text of [
    '配对一下我的耳机',
    '配对这两个图标是啥意思',
    '设备都没了怎么回事',
    '设备管理器在哪',
    '帮我看看忘掉密码怎么办',
    '把桌面理一理',
    '这个配对码是什么意思',
    '',
    '   ',
  ]) {
    assert.equal(parseCommand(text), null, `「${text}」不该被当成命令`);
  }
});

test('认句子：配对只写了一半，仍然算命令 —— 要告诉用户缺什么', () => {
  // 这是用户**正在配对**、只是抄漏了的状态。放给 agent 他会更懵
  assert.deepEqual(parseCommand('配对 192.168.1.9:41338'), { kind: 'pair', host: '192.168.1.9', port: 41338, code: '' });
  assert.deepEqual(parseCommand('配对 4A7-K2M'), { kind: 'pair', host: '', port: null, code: '4A7-K2M' });
});

// ───────────────────────── ② 纯函数 ─────────────────────────

test('设备列表：离线的那几台必须说"最后在线什么时候"', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const text = describeForUser([
    device('node-home', '家里那台', true),
    device('node-office', '公司那台', false, now - 3 * 3600_000),
    device('node-old', '老笔记本', false, null),
  ], now);

  assert.match(text, /现在认识 3 台电脑/);
  assert.match(text, /· 家里那台\n/);
  assert.match(text, /公司那台（不在线，最后在线 3 小时前）/);
  assert.match(text, /老笔记本（不在线，还没连上过）/);
});

test('设备列表：一台都没有时给的是"下一步做什么"', () => {
  const text = describeForUser([]);
  assert.match(text, /一台别的电脑都还不认识/);
  assert.match(text, /butler node/);
  assert.match(text, /配对 192\.168\.1\.9:41338 4A7-K2M/);
});

test('找设备：说不清就不猜', () => {
  const devices = [device('node-home', '家里那台'), device('node-office', '公司那台')];
  assert.equal(findDevice('家里那台', devices)?.id, 'node-home');
  assert.equal(findDevice('node-office', devices)?.id, 'node-office');
  assert.equal(findDevice('那台', devices), null, '两台都对得上时不能猜一台');
  assert.equal(findDevice('书房那台', devices), null);
});

test('系统名说人话：别跟用户说 darwin', () => {
  assert.equal(osName('darwin'), 'macOS');
  assert.equal(osName('win32'), 'Windows');
  assert.equal(osName('计划外'), '计划外');
});

// ───────────────────────── ③ 真内核里跑一遍 ─────────────────────────

test('配对：把参数原样递给链路，回话里点名收下了哪台', async () => {
  const s = await setup();
  try {
    const reply = await s.say('配对 192.168.1.9:41338 4A7-K2M');
    assert.deepEqual(s.link.pairs, [{ host: '192.168.1.9', port: 41338, code: '4A7-K2M' }]);
    assert.match(reply, /收下了：新收的那台/);
    assert.match(reply, /@新收的那台/, '要告诉用户接下来怎么用它');
  } finally {
    await s.cleanup();
  }
});

test('配对：没写端口时不瞎编一个，让链路自己定', async () => {
  const s = await setup();
  try {
    await s.say('配对 192.168.1.9 4A7-K2M');
    assert.deepEqual(s.link.pairs, [{ host: '192.168.1.9', code: '4A7-K2M' }]);
  } finally {
    await s.cleanup();
  }
});

test('配对：码不对时原样转述那台电脑说的话', async () => {
  const s = await setup();
  try {
    s.link.pairError = new Error('配对码不对。对着那台电脑屏幕上的那一串再抄一次');
    const reply = await s.say('配对 192.168.1.9:41338 ZZZ-ZZZ');
    assert.match(reply, /配对码不对/);
    assert.match(reply, /再抄一次/);
  } finally {
    await s.cleanup();
  }
});

test('配对：少了地址或少了码，要说清楚缺哪个', async () => {
  const s = await setup();
  try {
    const noCode = await s.say('配对 192.168.1.9:41338');
    assert.match(noCode, /配对要两样东西/);
    assert.match(noCode, /配对 192\.168\.1\.9:41338 4A7-K2M/, '要把正确写法摆出来');
    assert.equal(s.link.pairs.length, 0, '参数不全时不该去连那台电脑');

    const noAddr = await s.say('配对 4A7-K2M');
    assert.match(noAddr, /配对要两样东西/);
    assert.equal(s.link.pairs.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('配对：名册由外部权威决定的链路（没有 pair）要说"这条不用配对"', async () => {
  const s = await setup(FakeLink);
  try {
    const reply = await s.say('配对 192.168.1.9:41338 4A7-K2M');
    assert.match(reply, /不用配对/);
    assert.match(reply, /发「设备」/, '要给一条走得通的路，不能只说"不行"');
  } finally {
    await s.cleanup();
  }
});

test('配对：没装链路的机器上，明说缺什么', async () => {
  const s = await setup(null);
  try {
    assert.match(await s.say('配对 192.168.1.9:41338 4A7-K2M'), /没有链路/);
    assert.match(await s.say('设备'), /没有链路/);
  } finally {
    await s.cleanup();
  }
});

test('设备：列出认识的机器，在不在线都说清楚', async () => {
  const s = await setup();
  try {
    s.link.devices.push(device('node-home', '家里那台'), device('node-office', '公司那台', false, Date.now() - 60_000));
    const reply = await s.say('设备');
    assert.match(reply, /现在认识 2 台电脑/);
    assert.match(reply, /家里那台/);
    assert.match(reply, /公司那台（不在线，最后在线 1 分钟前）/);
  } finally {
    await s.cleanup();
  }
});

test('忘掉：叫得出名字就忘掉，并说清楚删了什么', async () => {
  const s = await setup();
  try {
    s.link.devices.push(device('node-home', '家里那台'));
    const reply = await s.say('忘掉 家里那台');
    assert.deepEqual(s.link.forgotten, ['node-home']);
    assert.match(reply, /忘掉「家里那台」了/);
    assert.equal(s.link.devices.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('忘掉：写在配置里的那台忘不掉 —— 得说清楚去哪儿删', async () => {
  const s = await setup();
  try {
    s.link.devices.push(device('node-home', '家里那台'));
    s.link.forgetVerdict = 'static';
    const reply = await s.say('忘掉 家里那台');
    assert.match(reply, /写在配置文件里/);
    assert.match(reply, /去那份配置里删掉那一行/);
  } finally {
    await s.cleanup();
  }
});

test('忘掉：名字对不上（或者好几台都对得上）时不乱删', async () => {
  const s = await setup();
  try {
    s.link.devices.push(device('node-home', '家里那台'), device('node-office', '公司那台'));
    const reply = await s.say('忘掉 那台');
    assert.deepEqual(s.link.forgotten, [], '不确定的时候一台都不能忘');
    assert.match(reply, /没有叫「那台」的设备/);
    assert.match(reply, /家里那台/);
  } finally {
    await s.cleanup();
  }
});

test('命令：列出来的每一句都是真能用的', async () => {
  const s = await setup();
  try {
    const reply = await s.say('命令');
    assert.match(reply, /配对 192\.168\.1\.9:41338 4A7-K2M/);
    assert.match(reply, /设备/);
    assert.match(reply, /忘掉 家里那台/);
  } finally {
    await s.cleanup();
  }
});

test('★ 不该认的一个都别认：像命令的话原样落到 agent 手里', async () => {
  const s = await setup();
  try {
    const reply = await s.say('配对一下我的耳机');
    assert.equal(s.link.pairs.length, 0, '不该去配对');
    assert.equal(s.agent.seen.length, 1, '这句话得原样交给 agent');
    assert.match(reply, /好的/);                // FakeAgent 的固定回话，证明确实进了 agent

    // 反过来验一次：真命令**不该**进 agent
    s.agent.seen.length = 0;
    await s.say('设备');
    assert.equal(s.agent.seen.length, 0, '命令不该惊动 agent');
  } finally {
    await s.cleanup();
  }
});

// ───────────────────────── 记忆 ─────────────────────────
//
// 记忆的命令跟设备那几条是一套规矩（见 commands.ts 文件头）：**写**由内核自己干，
// 因为它等于"以后这类事不用问了"，不能让一句自然语言直接改权限。
//
// 这个文件为什么也管"贴给 agent"那件事：它用的是同一套容器和同一个假 agent，
// 而"主人问『你记得我什么』"这条路根本不经过命令 —— 它是靠每轮请求前贴上去的。

test('认句子：记住 / 记忆 / 忘掉第 N 条', () => {
  assert.deepEqual(parseCommand('记住 简历都放 Documents/简历/'), { kind: 'remember', text: '简历都放 Documents/简历/' });
  // 冒号、逗号、顿号、多个空格都算分隔符（大家敲法不一样）
  assert.deepEqual(parseCommand('记住：简历都放 Documents/简历/'), { kind: 'remember', text: '简历都放 Documents/简历/' });
  assert.deepEqual(parseCommand('记住，我的工作目录是 ~/work'), { kind: 'remember', text: '我的工作目录是 ~/work' });
  assert.deepEqual(parseCommand('  记住   多空格  '), { kind: 'remember', text: '多空格' });

  assert.deepEqual(parseCommand('记忆'), { kind: 'memory' });
  assert.deepEqual(parseCommand('忘掉第 2 条'), { kind: 'forgetMemory', index: 2 });
  assert.deepEqual(parseCommand('忘掉 第2条'), { kind: 'forgetMemory', index: 2 });
  assert.deepEqual(parseCommand('删掉第 10 条'), { kind: 'forgetMemory', index: 10 });

  // ★ 两条"忘掉"不能互相抢：带"第…条"的才是记忆，别的是设备
  assert.deepEqual(parseCommand('忘掉 家里那台'), { kind: 'forget', name: '家里那台' });
  // 设备那条命令的第一个词必须**正好**是"忘掉"：写完还接着"第"的，两条都不算
  assert.deepEqual(parseCommand('忘掉 第 2 条设备'), { kind: 'forget', name: '第 2 条设备' });
  assert.equal(parseCommand('忘掉第 2 条设备'), null, '认不出来就交给 agent');
});

test('认句子：记忆这几条最容易错认，边界写死在这儿', () => {
  // `记住` 后面没有分隔符 —— 那是在跟 agent 说话，不是在交代偏好
  assert.equal(parseCommand('记住这件事很重要'), null);
  assert.equal(parseCommand('我记住了'), null);
  // 整句就是"记忆"两个字的才算
  assert.equal(parseCommand('记忆里好像有这事'), null);
  assert.equal(parseCommand('你的记忆真差'), null);
  // "忘掉第 N 条"里的 N 必须是数字
  assert.equal(parseCommand('忘掉第 条'), null);
});

test('记忆：记住 → 记忆 → 忘掉第 1 条，一路都是人话', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    const ack = await t.say('记住 简历都放 Documents/简历/');
    assert.match(ack, /记下了/);
    assert.match(ack, /简历都放 Documents\/简历\//);
    assert.equal(await t.memory.get('简历都放 Documents/简历/'), '简历都放 Documents/简历/', '得真的落进记忆');

    const list = await t.say('记忆');
    assert.match(list, /我记得这几件事/);
    assert.match(list, /1\. 简历都放 Documents\/简历\//);

    const gone = await t.say('忘掉第 1 条');
    assert.match(gone, /忘掉了/);
    assert.deepEqual(await t.memory.list(), []);
    assert.match(await t.say('记忆'), /还什么都没记住/);
  } finally { await t.cleanup(); }
});

test('记忆：清单编号和「忘掉第 N 条」用的是同一个编号', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    await t.say('记住 第一条');
    await t.say('记住 第二条');
    const list = await t.say('记忆');
    assert.match(list, /1\. 第二条/, '新的在前');
    assert.match(list, /2\. 第一条/);

    await t.say('忘掉第 2 条');
    const after = await t.say('记忆');
    assert.match(after, /1\. 第二条/);
    assert.doesNotMatch(after, /第一条/);
  } finally { await t.cleanup(); }
});

test('记忆：编号对不上时说清现在一共几条，而不是"失败"', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    await t.say('记住 只有一条');
    assert.match(await t.say('忘掉第 9 条'), /没有第 9 条.*一共 1 条/s);
    // 一条都没有的时候
    await t.say('忘掉第 1 条');
    assert.match(await t.say('忘掉第 1 条'), /什么都没记住/);
  } finally { await t.cleanup(); }
});

test('记忆：没装记忆插件时也给一句人话（不崩、不静默）', async () => {
  const t = await setup(FakePairingLink, {}, false);
  try {
    assert.match(await t.say('记住 随便什么'), /还没接记忆/);
    assert.match(await t.say('记忆'), /还没接记忆/);
    // 而且别的话照常走 agent —— 少一行配置不该让管家变成哑巴
    const reply = await t.say('今天天气怎么样');
    assert.equal(reply, '好的');
  } finally { await t.cleanup(); }
});

test('★ 记忆：每一轮请求前都贴上了 —— "你记得我什么"不用命令也答得对', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    await t.say('记住 简历都放 Documents/简历/');
    const n = t.agent.seen.length;
    await t.say('你记得我什么');

    const req = t.agent.seen[n];
    assert.match(req.text, /管家记得的事/);
    assert.match(req.text, /简历都放 Documents\/简历\//, '记下的内容要在里面');
    assert.match(req.text, /不是这一轮的新要求/, '得说清它不是刚下的命令');
    assert.match(req.text, /你记得我什么$/, '主人原话还在，而且贴在记忆后面');
  } finally { await t.cleanup(); }
});

test('记忆：一条都没记时，一个字都不贴（行为跟以前一模一样）', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    await t.say('随便说点什么');
    assert.doesNotMatch(t.agent.seen[0].text, /管家记得的事/);
  } finally { await t.cleanup(); }
});

test('★ 记忆：读不动不能让消息卡住 —— 照常交给 agent，但命令如实报错', async () => {
  const t = await setup(FakePairingLink, {}, true);
  try {
    t.memory.broken = new Error('记忆文件不是合法 JSON：/tmp/butler/state/memory.json');
    const reply = await t.say('今天天气怎么样');
    // 刚认主时管家会先说一句自我介绍，所以这里看的是**最后**那句（agent 的原话）
    assert.match(reply, /好的$/, '记忆坏了不是主人这条消息的错，照样得办');
    assert.match(t.agent.seen[0].text, /今天天气怎么样/);

    // 而「记忆」这条命令要如实说读不动，不能装作"我什么都没记住"
    assert.match(await t.say('记忆'), /读不动/);
  } finally { await t.cleanup(); }
});

// ═══════════════════════════ 审批 ═══════════════════════════
//
// 「要动你的电脑」这件事得有人点头。dsh 那侧的应答者把问题挂出来（真实现是
// approval-im），这里测的是**管家这一侧**的规矩：念清单、按编号批、
// 清单变了绝不硬猜、读不动如实说。

/** 等主人收到一条"要动你电脑"的推送 */
async function waitPush(channel, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = channel.sent.find((m) => m.text.includes('要动你的电脑'));
    if (hit) return hit;
    await sleep(10);
  }
  return undefined;
}

test('审批：这几句才认，像"好""可以吧"这种一律不认', () => {
  assert.deepEqual(parseCommand('允许'), { kind: 'allow', index: null });
  assert.deepEqual(parseCommand('允许 2'), { kind: 'allow', index: 2 });
  assert.deepEqual(parseCommand('允许第 3 条'), { kind: 'allow', index: 3 });
  assert.deepEqual(parseCommand('不许 1'), { kind: 'deny', index: 1 });
  assert.deepEqual(parseCommand('拒绝'), { kind: 'deny', index: null });
  assert.deepEqual(parseCommand('待批'), { kind: 'pending' });

  // 负面：审批上"错认"的代价是允许了一次没打算允许的操作
  assert.equal(parseCommand('允许我解释一下'), null);
  assert.equal(parseCommand('好'), null, '一句随口的"好"不能变成授权');
  assert.equal(parseCommand('可以吧'), null);
  assert.equal(parseCommand('不行就算了'), null);
  assert.equal(parseCommand('待批的事'), null);
});

test('★ 有件事在等 → 主动推给主人（说要干什么、怎么答、不答会怎样）', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');                       // 先认主
    t.approval.ask({ tool: 'bash', reason: 'rm -rf ~/Downloads/old', displayReason: '删除 ~/下载/旧项目' });
    const push = await waitPush(t.channel);
    assert.ok(push, '应当推一条过来');
    assert.match(push.text, /删除 ~\/下载\/旧项目/, '要说清要干什么');
    assert.match(push.text, /允许/, '要说清怎么答');
    assert.match(push.text, /当不许|到点/, '要说清不答会怎样');
    assert.equal(push.to, 'u1', '推给主人本人');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 编号对不上（清单在主人看到之后变了）→ 绝不硬猜，重新念一遍', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    const a = t.approval.ask({ reason: '第一件' });
    const b = t.approval.ask({ reason: '第二件' });
    assert.match(await t.say('待批'), /第一件[\s\S]*第二件/, '先念清单，主人拿到的编号以这份为准');

    // 主人还在想的时候，第一件没了（超时结算 / 别处处理了）
    t.approval.pending.shift();
    const reply = await t.say('允许 1');
    assert.match(reply, /已经不在了|第 1 条/, '要说清那件没了');
    assert.match(reply, /第二件/, '而且要把现在的清单重念一遍');
    assert.deepEqual(t.approval.answered, [], '一件都不许批 —— 编号已经对不上了');
    assert.deepEqual(t.approval.pending.map((r) => r.id), [b.id], '剩下的那件还在等');
    assert.ok(a.id !== b.id);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('编号越界（「允许 9」）→ 说没有这条，一件都不批', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ reason: '只有这一件' });
    await t.say('待批');            // 先把编号的来源定下来，免得跟推送抢
    const reply = await t.say('允许 9');
    assert.match(reply, /没有第 9 条/);
    assert.deepEqual(t.approval.answered, [], '越界的编号不能批到任何一件');
    assert.match(reply, /只有这一件/, '顺带把现在的清单念一遍，让他知道有哪几件');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 还没念过清单就说"允许 1" → 先念，不拿编号猜', async () => {
  // 关掉主动推送 = 主人还没看过清单（进程刚起、或配置里就不推）
  const t = await setup(FakePairingLink, { approvalIntervalMs: 0 }, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ reason: '读一下 ~/.ssh' });
    await sleep(80);
    const reply = await t.say('允许 1');
    assert.match(reply, /读一下 ~\/\.ssh/, '先把清单念出来');
    assert.deepEqual(t.approval.answered, [], '没念过就不能批');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('推送发不出去 → 不当成"问过了"，下一轮接着试', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.channel.sendError = new Error('网络抽了一下');
    t.approval.ask({ reason: '删掉一个目录' });
    await sleep(80);
    assert.equal(t.channel.sent.filter((m) => m.text.includes('要动你的电脑')).length, 0);
    t.channel.sendError = null;                 // 网络好了
    const push = await waitPush(t.channel);
    assert.ok(push, '没送到的，下一轮要补送');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 只有一件时，「允许」不带编号也行（编号靠念过的那份清单）', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    const req = t.approval.ask({ reason: '重启一下服务' });
    await waitPush(t.channel);                  // 推送里带着编号 1
    const reply = await t.say('允许');
    assert.deepEqual(t.approval.answered, [{ id: req.id, decision: 'allow', by: 'owner' }]);
    assert.match(reply, /第 1 条/);
    assert.match(reply, /重启一下服务/);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 两件在等的时候，光说「允许」不算数 —— 得指明哪一件', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ reason: '第一件' });
    t.approval.ask({ reason: '第二件' });
    const reply = await t.say('允许');
    assert.deepEqual(t.approval.answered, [], '猜错一件的代价太大，宁可不猜');
    assert.match(reply, /哪一件|允许 2/);
    assert.match(reply, /第一件[\s\S]*第二件/, '顺带把清单念一遍');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('「不许 1」= 明确拒绝，回执要说清是哪一件', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    const a = t.approval.ask({ reason: '要装一个来路不明的包' });
    t.approval.ask({ reason: '另一件' });
    await t.say('待批');
    const reply = await t.say('不许 1');
    assert.deepEqual(t.approval.answered, [{ id: a.id, decision: 'deny', by: 'owner' }]);
    assert.match(reply, /要装一个来路不明的包/);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('一件都没有的时候说「允许」→ 说没有，而且什么都不做', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    const reply = await t.say('允许');
    assert.match(reply, /没有等你点头的事/);
    assert.deepEqual(t.approval.answered, []);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('审批记录读不动 → 如实说，并说清"我没有替你做主"', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    t.approval.broken = new Error('审批目录权限不对');
    const reply = await t.say('待批');
    assert.match(reply, /审批记录读不动/);
    assert.match(reply, /审批目录权限不对/);
    assert.match(reply, /一律按不许|没有\*\*替你做主\*\*|没有替你做主/);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('配置里没装审批 → 说人话，不装作有这回事', async () => {
  const t = await setup(FakePairingLink, {}, false, false);
  try {
    assert.match(await t.say('待批'), /还没接审批|ctx\.approval/);
    assert.match(await t.say('允许'), /还没接审批|ctx\.approval/);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

// ─────────── ★ 「以后这类不用问了」───────────
//
// 这一条是**安全相关**的：记下来之后，这一类就再也不问主人了。
// 所以两头都要钉死：该认的认（而且把后果说清楚），收回之后必须**真的照常问**。

test('整句才认：「以后这类都行 2」是命令，「都行」「以后」不是', () => {
  assert.deepEqual(parseCommand('以后这类都行 2'), { kind: 'always', index: 2 });
  assert.deepEqual(parseCommand('以后都行 1'), { kind: 'always', index: 1 });
  assert.deepEqual(parseCommand('以后这类不用问了 3'), { kind: 'always', index: 3 });
  assert.deepEqual(parseCommand('以后这类都行'), { kind: 'always', index: null });
  // 带期限：尾巴**只有像一段时间**才会被收进来
  assert.deepEqual(parseCommand('以后这类都行 2，一小时'), { kind: 'always', index: 2, window: '一小时' });
  assert.deepEqual(parseCommand('以后这类都行 1 30 分钟'), { kind: 'always', index: 1, window: '30 分钟' });
  // 「谢谢」不像时间 ⇒ 整句不算命令，照旧当聊天（宁可漏认，不可错认）
  assert.equal(parseCommand('以后这类都行 2，谢谢'), null);
  assert.equal(parseCommand('以后这类都行吗'), null);
  assert.equal(parseCommand('都行'), null, '聊天里的「都行」不能变成长期授权');
  assert.equal(parseCommand('以后'), null);
  assert.equal(parseCommand('这类都行吧'), null, '多一个字就不认 —— 认错这一句的代价太大');
});

test('「授权」「取消授权 1」；没编号的「取消授权」不认', () => {
  assert.deepEqual(parseCommand('授权'), { kind: 'grants' });
  assert.deepEqual(parseCommand('哪些不用问了'), { kind: 'grants' });
  assert.deepEqual(parseCommand('取消授权 1'), { kind: 'revokeGrant', index: 1 });
  assert.equal(parseCommand('取消授权'), null, '不知道收哪条就别收');
});

test('★「以后这类都行」：这一件照办、这一类记下，而且**说清后果**', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ tool: 'bash', reason: '跑个构建' });
    const asked = await t.say('待批');
    assert.match(asked, /以后这类都行 1/, '要在"决定的那一刻"就教他怎么免掉这一类');
    assert.match(asked, /一小时/, '也要教"只免这一阵子"的说法 —— 不然这个能力等于藏起来了');
    const reply = await t.say('以后这类都行 1');

    assert.match(reply, /都不再问/, '必须明说要变成长期授权');
    assert.match(reply, /删东西/, '而且要说清这一类**全部**都算 —— 包括删东西');
    assert.match(reply, /取消授权/, '还要给出怎么收回');
    assert.equal(t.approval.answered.length, 1);
    assert.equal(t.approval.answered[0].by, 'owner', '这一件是主人当场点的头');

    // 同一类再来一件：**不再问主人**，而且账上写的是 grant（不冒名）
    t.approval.ask({ tool: 'bash', reason: '另一条 bash' });
    await waitFor(() => t.approval.answered.length === 2, '授权自动放行');
    assert.equal(t.approval.answered[1].by, 'grant', '账本不能写成"主人批的"');
    assert.match(await t.say('待批'), /没有等你点头/, '放过的那件不该还挂在那儿');

    // 别的类**照常问**
    t.approval.ask({ tool: 'read', reason: '读一个文件' });
    await t.say('待批');
    assert.match(await t.say('待批'), /读一个文件/, '别的类不该被这条授权波及');
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

test('★ 限时授权：说了期限就按期限记，并当场说清"到点自动照旧问"', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ tool: 'bash', reason: '跑个构建' });
    await t.say('待批');
    const reply = await t.say('以后这类都行 1，一小时');
    assert.match(reply, /接下来约 1 小时/, '要说清是这一段时间');
    assert.match(reply, /过点我照旧问你/, '到点自动恢复 —— 不用他记着来收');
    assert.match(reply, /取消授权/, '也给他提前收回的路');
    assert.equal(t.approval.answered[0].by, 'owner', '这一件仍是主人当场点的头');

    const list = await t.say('授权');
    assert.match(list, /dsh:bash/, '清单里看得出给过哪一类');
    assert.match(list, /约 1 小时/, '也看得出还剩多久');

    // 期限内同一类再来一件：**不问了**，账上写 grant（不冒名）
    t.approval.ask({ tool: 'bash', reason: '另一条 bash' });
    await waitFor(() => t.approval.answered.length === 2, '限时授权内自动放行');
    assert.equal(t.approval.answered[1].by, 'grant');
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

test('★ 期限那句没读懂：这一件照办，但**一条授权都不记**（照旧每次都问）', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ tool: 'bash', reason: '跑个构建' });
    await t.say('待批');
    // 「一小时候」像时间、但不是 —— 只有这种才会走到"读不懂"这条路
    // （「一会儿」「谢谢」连命令都不算，会当成聊天，见上面的 parseCommand 用例）
    const reply = await t.say('以后这类都行 1，一小时候');
    assert.match(reply, /长期授权没记/, '要明说没记下');
    assert.match(reply, /照旧问你/);
    assert.match(await t.say('授权'), /你还没给过长期授权/, '一条都不许记');

    // 同一类再来一件：必须**照常问** —— 绝不能被当成"没看懂就当永远"
    t.approval.ask({ tool: 'bash', reason: '另一条 bash' });
    await t.say('待批');
    assert.match(await t.say('待批'), /另一条 bash/, '没读懂的期限不许变成永久授权');
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

test('★ 收回之后必须**真的照常问**', async () => {
  const t = await setup(FakePairingLink, {}, false, true);
  try {
    await t.say('你好');
    t.approval.ask({ tool: 'bash', reason: '第一件' });
    await t.say('待批');
    await t.say('以后这类都行 1');

    const list = await t.say('授权');
    assert.match(list, /dsh:bash/, '要看得出给过哪一类');
    const revoked = await t.say('取消授权 1');
    assert.match(revoked, /以后照常问你/);

    // 收回了还自动放过 = 这个功能最坏的坏法（他以为收回了）
    t.approval.ask({ tool: 'bash', reason: '收回之后的 bash' });
    await sleep(120);
    assert.equal(t.approval.answered.length, 1, '收回之后不许再自动放行');
    assert.match(await t.say('待批'), /收回之后的 bash/, '它该重新出现在待批里');
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

// ─────────── ★ 管家第一次开口 ───────────
//
// 刚扫码成功的人面对的是**一片安静**，而安静最容易被理解成"没装好"。
// 所以这一句非有不可，而且只能有一次。

test('「你能干什么」「你是谁」都认；多一个字就不认', () => {
  assert.deepEqual(parseCommand('你能干什么'), { kind: 'welcome' });
  assert.deepEqual(parseCommand('你是谁'), { kind: 'welcome' });
  assert.deepEqual(parseCommand('你会什么'), { kind: 'welcome' });
  assert.equal(parseCommand('你会什么呢'), null, '命令层的规矩：整句才算');
});

test('★ 刚认下主人：第一句就是自我介绍，不是把活干完再说', async () => {
  // 换一条**没人用过**的状态路径：默认那份被标成「开场白说过了」
  const fresh = mkdtempSync(join(tmpdir(), 'butler-first-'));
  const t = await setup(FakePairingLink, { stateFile: join(fresh, 'state.json') });
  try {
    await t.say('你好');
    const texts = t.channel.texts();
    assert.match(texts[0], /我是你的管家/, '第一句必须是"成了" —— 他刚扫完码，安静会被当成没装好');
    assert.match(texts[0], /先问过你/, '顺手把信任的地基说清');
    assert.match(texts[0], /以后这类都行/, '再顺手告诉他被问烦了怎么办');
    assert.equal(texts.filter((x) => /我是你的管家/.test(x)).length, 1, '只说一次');
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('「你能干什么」随时能再看一遍（不用记）', async () => {
  const t = await setup(FakePairingLink);
  try {
    await t.say('你好');
    const again = await t.say('你能干什么');
    assert.match(again, /我是你的管家/);
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

test('★ 回头客：启动时说一句，但一辈子只说一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-hello-'));
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ owner: 'leo', sessions: {} }));
  const cfg = { allowFrom: ['leo'], stateFile };
  try {
    const t = await setup(FakePairingLink, cfg);
    try {
      await waitFor(() => t.channel.texts().length > 0, '启动时的开场白');
      assert.match(t.channel.texts()[0], /我是你的管家/);
    } finally {
      await t.ctx.fiber.dispose();
      t.cleanup();
    }

    // 重启一次：**不许再唠叨一遍**
    const t2 = await setup(FakePairingLink, cfg);
    try {
      await sleep(80);
      assert.equal(t2.channel.texts().length, 0, '每次重启都说一遍，他会烦 —— 而烦了就不看了');
    } finally {
      await t2.ctx.fiber.dispose();
      t2.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────── ★ 「自检」：不懂技术的人在微信里唯一的排障手段 ───────────
//
// butler doctor 早就能查这些（问的是同一批 check()），但那要开终端、要会抄命令。
// 而恰恰是出事的时候，不懂技术的主人只有微信。

test('「自检」整句才算；「自检一下那个文件」是给 agent 的活', () => {
  assert.deepEqual(parseCommand('自检'), { kind: 'selfcheck' });
  assert.deepEqual(parseCommand('体检'), { kind: 'selfcheck' });
  assert.deepEqual(parseCommand('你还好吗'), { kind: 'selfcheck' });
  assert.equal(parseCommand('自检一下那个文件'), null, '带了别的话就不是这句命令');
  assert.equal(parseCommand('检查'), null, '光秃秃的「检查」太像在派活，故意不收');
});

test('★ 在微信里问「自检」：拿到一份人话报告，而不是一句"去开终端跑 doctor"', async () => {
  const t = await setup();
  try {
    await t.say('你好');
    const reply = await t.say('自检');
    assert.match(reply, /AI 管家自检/);
    assert.match(reply, /内核 · 工作目录/, '内核那两条自检要点名念出来');
    assert.match(reply, /内核 · 谁能指挥它/);
    // 这条是"一处判据、两处可见"的**微信那一半**：doctor 看的是同一个 check()。
    // 它过了，"在微信里跟它说一句、让它自己做"才真的走得通。
    assert.match(reply, /✓ 内核 · 管家自己找得到 butler 吗/, '管家自己的 PATH 那一条也要在微信里看得见');
    assert.match(reply, /【在岗】/, '还要说清现在哪几位在岗');
    assert.match(reply, /记忆 ✗/, '没接记忆就如实说 —— 这套装置里本来就没装');
    assert.match(reply, /没有它，我记不住你说过的事/, '而且要说清没它会怎样');
    assert.match(reply, /都正常/);
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});

test('★ 有插件炸了：报告照出，而且**绝不能说"都正常"**', async () => {
  const t = await setup();
  try {
    await t.say('你好');
    t.agent.check = () => { throw new Error('大脑炸了'); };
    const reply = await t.say('自检');
    assert.match(reply, /自检本身出错了/, '插件抛了也得占一条 —— 静默跳过等于替它掩饰');
    assert.match(reply, /大脑炸了/, '原文要照抄给主人，那是插件的 bug');
    assert.doesNotMatch(reply, /都正常/, '出事的时候还说"都正常"，是这份报告最坏的一种错法');
    assert.match(reply, /有 1 项没过/);
  } finally {
    await t.ctx.fiber.dispose();
    t.cleanup();
  }
});
