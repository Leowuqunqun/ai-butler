/**
 * doctor 的测试。
 *
 *   node --test test/doctor.mjs
 *
 * 这里最要紧的一条是：**doctor 永远不抛错。**
 * 用户跑到 doctor 这一步，说明已经"没反应"了 —— 这时候最不能发生的
 * 就是"诊断工具自己也炸了"。所以下面有一整组"故意把一切都弄坏"的用例。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { doctor, formatDoctor, saveSecret, secretsFileOf } from '@butler/cli';
import { credentialsFileOf } from '../lib/credentials.js';
import { useButlerShim, withoutButler } from './fixtures/path-shim.mjs';

// 内核自检里有一条量 PATH 的（"管家自己找得到 butler 吗"）。测试机上没有 butler，
// 给它一个真 shim：**改环境，不改判据**。
// ⚠️ 这里造绿不算数 —— 真正把关的是 scripts/verify-clean-install.sh（真装出来的进程）。
useButlerShim();

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');

/** 造一份配置，返回路径。行里的 name 用相对路径，从 FIX 解析 */
function tmpConfig(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ plugins: rows }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CH = (config = {}) => ({ id: 'channel', name: './plugins/check-channel.mjs', config });

/** 脊梁齐的最小配置 */
function spine(channelCfg = {}) {
  return [
    CH(channelCfg),
    { id: 'agent', name: './plugins/agent-stub.mjs' },
    { id: 'core', name: './plugins/core-stub.mjs' },
  ];
}

const run = (file, more = {}) => doctor({ configPath: file, configDir: FIX, ...more });

// ───────────────────────── 正常路径 ─────────────────────────


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

test('一切正常时 ok=true，结论是一句能照做的事', async () => {
  const t = tmpConfig(spine());
  try {
    const r = await run(t.file);
    assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok), null, 2));
    assert.match(r.verdict, /butler run/, '结论要告诉用户下一步干什么，不是"自检通过"');
  } finally { t.cleanup(); }
});

/**
 * ★★ 第 44 轮：验收路上最容易走进的那个死胡同，必须由 doctor 自己说出来。
 *
 * 探针把飞书凭据存好了，但配置里没有那条通道 —— 这一路**没有任何一步会报错**：
 * doctor 一片 ✓、`butler run` 正常起来、消息发出去没人应。用户最容易怀疑的是
 * "是不是我权限没配好"，然后去开发者后台折腾半天（修之前实测：doctor 里「飞书」0 次）。
 */
test('★★ 盘上有完整凭据、配置里却没那条通道：doctor 要说出"跑 butler init --im feishu"', async () => {
  const t = tmpConfig(spine());  // 脊梁齐的最小配置 —— 故意没有飞书那一行
  try {
    const file = secretsFileOf(t.dir);
    saveSecret(file, 'feishu', 'appId', 'cli_fake_for_doctor_test');
    saveSecret(file, 'feishu', 'appSecret', 'fake_secret');

    const r = await run(t.file);
    assert.deepEqual(r.unplugged, [{ channel: 'feishu', label: '飞书', im: 'feishu' }]);
    const text = formatDoctor(r);
    assert.match(text, /盘上已经有飞书的凭据/, '报告里要有这一句');
    assert.match(text, /butler init --im feishu/, '而且要给出能照抄的命令');
  } finally { t.cleanup(); }
});

test('三条脊梁齐了就都报 present；可选能力位也列出来，但缺了不算"缺"', async () => {
  const t = tmpConfig(spine());
  try {
    const r = await run(t.file);
    assert.deepEqual(r.slots.map((s) => [s.name, s.present]), [
      ['channel', true], ['agent', true], ['core', true],
      ['link', false], ['memory', false], ['approval', false],
    ]);
    assert.equal(r.slots[0].what, '收发消息的通道', '要给人话，不是给开发者的话');

    // 可选的那两条：列出来，但**不进 missing**（没有记忆照样能用）
    assert.deepEqual(r.slots.filter((s) => s.optional).map((s) => s.name), ['link', 'memory', 'approval']);
    assert.deepEqual(
      r.slots.filter((s) => !s.present && !s.optional).map((s) => s.name), [],
      '可选能力位缺了不算坏',
    );
  } finally { t.cleanup(); }
});

test('每条检查都带 from，能看出是哪一层报的', async () => {
  const t = tmpConfig(spine({ checks: [{ name: '某项', ok: true, detail: '好' }] }));
  try {
    const r = await run(t.file);
    assert.equal(r.checks.some((c) => c.from === '环境'), true);
    assert.equal(r.checks.some((c) => c.from === '配置'), true);
    assert.equal(r.checks.some((c) => c.from === 'channel'), true, '插件报的要有它自己的 from');
  } finally { t.cleanup(); }
});

// ── 内核自检也走 doctor ──────────────────────────────────────────
//
// "管家自己找得到 butler 吗"是**一处判据、两处可见**：doctor 和微信「自检」
// 问的是同一个 `check()`。这一组的 core 行用**真内核**（不是 core-stub）——
// 用桩的话测的就不是那条真实路径了。

/** 一份"通道/大脑用桩、内核用真的"配置。真内核要 workspace 和 stateFile */
function realCoreSpine() {
  const dir = mkdtempSync(join(tmpdir(), 'doc-core-'));
  return {
    dir,
    rows: [
      CH(),
      { id: 'agent', name: './plugins/agent-stub.mjs' },
      { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
    ],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('★ 真内核 + doctor：管家自己的 PATH 那一项看得见，而且是 ✓', async () => {
  const shim = useButlerShim();
  const real = realCoreSpine();
  const t = tmpConfig(real.rows);
  try {
    const r = await run(t.file);
    const c = r.checks.find((x) => x.name.includes('管家自己找得到 butler'));
    assert.ok(c, `doctor 要把内核这一条打出来（它和微信自检问的是同一个 check()）：\n${formatDoctor(r)}`);
    assert.equal(c.from, 'core', '要能看出是内核报的');
    assert.equal(c.ok, true, `PATH 里有 shim，这一条该是 ✓：${JSON.stringify(c)}`);
    assert.ok(String(c.detail).includes(shim), `要说清找到的是哪一个：${c.detail}`);
    assert.match(formatDoctor(r), /管家自己找得到 butler/, '打印出来的报告里也要有这一行');
  } finally { t.cleanup(); real.cleanup(); }
});

test('★ 真内核 + doctor：PATH 里没有 butler 时，doctor 如实报 ✗ 并给出路', async () => {
  const real = realCoreSpine();
  const t = tmpConfig(real.rows);
  try {
    await withoutButler(async () => {
      const r = await run(t.file);
      const c = r.checks.find((x) => x.name.includes('管家自己找得到 butler'));
      assert.equal(c?.ok, false, '找不到就必须让用户在 doctor 里看见，不能只在微信里说');
      assert.match(String(c.fix), /安装器/, '出路要说清：重跑安装器');
      const text = formatDoctor(r);
      assert.match(text, /✗ {2}管家自己找得到 butler/);
      assert.match(text, /→ .*安装器/, '没过的那条要跟着一句"怎么办"');
    });
  } finally { t.cleanup(); real.cleanup(); }
});

test('实际读的文件都记下来了 —— 用户最常问"它到底看的哪个文件"', async () => {
  const t = tmpConfig(spine());
  const patch = join(t.dir, 'me.json');
  writeFileSync(patch, JSON.stringify({ plugins: [] }));
  try {
    const r = await run(t.file, { patches: [patch] });
    assert.deepEqual(r.files, [t.file, patch]);
    const c = r.checks.find((x) => x.name === '实际读的文件');
    assert.match(c.detail, /config\.json/);
    assert.match(c.detail, /me\.json/);
  } finally { t.cleanup(); }
});

// ───────────────────────── 插件自己的自检 ─────────────────────────

test('插件报的不合格项会原样出现，包括那句 fix', async () => {
  const t = tmpConfig(spine({
    checks: [{
      name: '微信登录态',
      ok: false,
      detail: '还没登录过这台机器',
      fix: '启动时会打印二维码，用微信扫一下就好',
    }],
  }));
  try {
    const r = await run(t.file);
    assert.equal(r.ok, false);
    const c = r.checks.find((x) => x.name === '微信登录态');
    assert.equal(c.from, 'channel');
    assert.equal(c.detail, '还没登录过这台机器');
    assert.match(c.fix, /扫一下/, 'fix 决定用户能不能自己解决，不能丢');
    assert.match(r.verdict, /1 项自检没过/);
  } finally { t.cleanup(); }
});

test('**没有 check 的插件不算错** —— 自检是可选的', async () => {
  const t = tmpConfig([
    { id: 'channel', name: './plugins/plain-channel.mjs' },
    { id: 'agent', name: './plugins/agent-stub.mjs' },
    { id: 'core', name: './plugins/core-stub.mjs' },
  ]);
  try {
    const r = await run(t.file);
    assert.equal(r.ok, true, '没实现 check 不该被判成失败');
    assert.equal(r.checks.some((c) => c.from === 'channel'), false);
  } finally { t.cleanup(); }
});

test('插件自检自己抛错：收成一条不合格项，**doctor 不跟着炸**', async () => {
  const t = tmpConfig(spine({ throws: true }));
  try {
    const r = await run(t.file);
    assert.equal(r.ok, false);
    const c = r.checks.find((x) => x.name === '自检本身出错了');
    assert.equal(c.from, 'channel');
    assert.match(c.detail, /这个插件自检的时候炸了/);
    assert.match(c.fix, /发出来/, '要告诉用户把原文发出来，不然没人能帮他');
  } finally { t.cleanup(); }
});

// ───────────────────────── 坏掉的时候也必须有话说 ─────────────────────────

test('配置文件根本读不了：不抛错，报一条带人话的检查', async () => {
  const r = await doctor({ configPath: missing('config.json') });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name === '读配置');
  assert.equal(c.ok, false);
  assert.match(c.detail, /文件不存在/);
  // ⚠️ 文件不存在 ≠ 文件坏了。这时候让人"去把它修好"，他会去找一份**不存在**的文件。
  //    （安装包刚装完、README 让跑 doctor，实测就是这么一句话。）
  assert.match(c.fix, /butler init/, '没配置过就给那一行能抄的命令');
  assert.doesNotMatch(c.fix, /修好/, '不许让人去修一份还不存在的文件');
  assert.equal(r.slots.every((s) => !s.present), true);
});

test('配置文件是坏 JSON：一样有话说', async () => {
  const t = tmpConfig([]);
  writeFileSync(t.file, '{ 这不是 json }');
  try {
    const r = await run(t.file);
    assert.equal(r.ok, false);
    assert.match(r.checks.find((x) => x.name === '读配置').detail, /不是合法的 JSON/);
    // 文件**在**、只是坏了：这才该说"修好它"
    assert.match(r.checks.find((x) => x.name === '读配置').fix, /修好/);
  } finally { t.cleanup(); }
});

test('插件装不上：进 failures，能力位报缺，结论点名缺了哪个', async () => {
  const t = tmpConfig([
    { id: 'channel', name: './plugins/broken.mjs' },
    { id: 'agent', name: './plugins/agent-stub.mjs' },
    { id: 'core', name: './plugins/core-stub.mjs' },
  ]);
  try {
    const r = await run(t.file);
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].id, 'channel');
    const missing = r.slots.filter((s) => !s.present && !s.optional);
    assert.deepEqual(missing.map((s) => s.name), ['channel']);
    // 可选的那两条照样列出真实情况（用户才知道自己没配记忆）
    assert.deepEqual(
      r.slots.filter((s) => s.optional).map((s) => [s.name, s.present]),
      [['link', false], ['memory', false], ['approval', false]],
    );
    assert.match(r.verdict, /1 个插件没装上来/);
    assert.match(r.verdict, /少了 channel/);
  } finally { t.cleanup(); }
});

test('脊梁缺一条：能力位报缺，而且指路到「装载」那一段', async () => {
  const t = tmpConfig([
    CH(),
    { id: 'agent', name: './plugins/agent-stub.mjs' },
    // 没有 core
  ]);
  try {
    const r = await run(t.file);
    assert.equal(r.ok, false);
    assert.equal(r.slots.find((s) => s.name === 'core').present, false);
    const text = formatDoctor(r);
    assert.match(text, /缺这个就跑不起来/, '要说清"缺了会怎样"，不能只报 false');
  } finally { t.cleanup(); }
});

test('必填配置没给的插件：failures 里带着实现自己写的那句人话', async () => {
  const t = tmpConfig([
    CH(),
    { id: 'agent', name: './plugins/needs-config.mjs', config: {} },
    { id: 'core', name: './plugins/core-stub.mjs' },
  ]);
  try {
    const r = await run(t.file);
    assert.match(r.failures[0].message, /缺少必填配置：token/);
  } finally { t.cleanup(); }
});

test('关闭的行会报出来，但不算失败', async () => {
  const t = tmpConfig([...spine(), { id: 'off', name: './plugins/demo.mjs', disabled: true }]);
  try {
    const r = await run(t.file);
    assert.deepEqual(r.disabled.map((r2) => r2.id), ['off']);
    assert.equal(r.ok, true, '用户主动关掉的不该被判成问题');
  } finally { t.cleanup(); }
});

// ───────────────────────── 环境 ─────────────────────────

test('Node 版本不够：报不合格，并告诉用户去升级', async () => {
  const t = tmpConfig(spine());
  try {
    const r = await run(t.file, { nodeVersion: 'v18.20.0' });
    assert.equal(r.ok, false);
    const c = r.checks.find((x) => x.name === 'Node 版本');
    assert.equal(c.ok, false);
    assert.match(c.detail, /v18\.20\.0/);
    assert.match(c.fix, /升级 Node/);
  } finally { t.cleanup(); }
});

// ───────────────────────── 打印 ─────────────────────────

test('打印：四段都在，✗ 带箭头指路', async () => {
  const t = tmpConfig(spine({
    checks: [{ name: '某项', ok: false, detail: '现在这样', fix: '这样改' }],
  }));
  try {
    const text = formatDoctor(await run(t.file));
    for (const s of ['环境', '配置', '装载', '能力位', '自检']) {
      assert.match(text, new RegExp(`\\n${s}\\n`), `少了「${s}」这一段`);
    }
    assert.match(text, /✗ {2}某项/);
    assert.match(text, /→ 这样改/);
  } finally { t.cleanup(); }
});

test('打印：**中文按终端宽度对齐**（汉字占两列，不是一列）', async () => {
  // ⚠️ 哨兵别用短字符串：临时目录名是随机的（`doc-D1ab…`），用 `D1` 当标记
  // 有概率撞上它，然后这条测试开始随机地红。实测踩过（全量跑才复现）。
  const A = '<<COL-A>>';
  const B = '<<COL-B>>';
  const t = tmpConfig(spine({
    checks: [
      { name: 'ab', ok: true, detail: A },        // 2 个窄字符
      { name: '中文四个', ok: true, detail: B },   // 4 个宽字符
    ],
  }));
  try {
    const text = formatDoctor(await run(t.file));
    const l1 = text.split('\n').find((l) => l.includes(A));
    const l2 = text.split('\n').find((l) => l.includes(B));
    assert.ok(l1 && l2, '没找到哨兵行');
    // 用「显示宽度」算，两行的 detail 应当从同一列开始
    assert.equal(width(l1.slice(0, l1.indexOf(A))), width(l2.slice(0, l2.indexOf(B))),
      `第二列没对齐：\n${l1}\n${l2}`);
  } finally { t.cleanup(); }
});

/** 终端显示宽度：CJK 区段算 2 列 */
function width(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (
      c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}

// ─────────── 「模型 key」那一行：三种状态都得说真话（变异测试发现的洞）───────────

/**
 * 这组用例是**砸出来的**：把 doctor 里那句 `ok: state !== 'missing'` 改成恒真
 * （= "key 缺了也说好"），整个 cli 测试套件居然一片绿 —— 只有 clean-room e2e
 * 抓得到它。e2e 要打一个包再真装一遍，太慢，没人会为一次改动去跑。
 * 所以这里把它钉住：**缺了必须 ✗、存了必须 ✓、环境来的必须如实说**。
 */
const KEY_REF = 'DEEPSEEK_API_KEY';

async function keyRowOf(t, { stored = '', env = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-key-'));
  const home = join(dir, 'dsh-home');
  mkdirSync(home, { recursive: true });
  const patchFile = join(home, 'dsh.patch.yml');
  // ref 是从补丁文件里读的（不是硬编码）——所以这里也顺手钉住"读的是这份补丁"
  writeFileSync(patchFile, `- apiKeyEnv: ${KEY_REF}\n`);
  if (stored) {
    writeFileSync(credentialsFileOf(home), `version: 1\nrefs:\n  ${KEY_REF}: "${stored}"\n`, { mode: 0o600 });
  }
  const before = process.env[KEY_REF];
  if (env === null) delete process.env[KEY_REF];
  else process.env[KEY_REF] = env;
  t.after(() => {
    if (before === undefined) delete process.env[KEY_REF];
    else process.env[KEY_REF] = before;
    rmSync(dir, { recursive: true, force: true });
  });

  const t2 = tmpConfig([
    // ⚠️ 这里**不能**再放 spine() 里那个 agent 桩：真 agent-dsh 也要注册 ctx.agent，
    //    两个撞名 → 它这行装不上 → 「模型 key」那条检查压根不出现。
    //    （这两条踩坑记录就是这条用例存在的意义：它以前根本没被任何 cli 用例看见过。）
    ...spine().filter((r) => r.id !== 'agent'),
    // `bin` 是构造时校验的必填项（这里不真跑 dsh）
    { id: 'agent-dsh', name: '@butler/agent-dsh', config: { patchFile, home, bin: 'dsh' } },
  ]);
  t.after(t2.cleanup);
  const r = await run(t2.file);
  return r.checks.find((c) => c.name === '模型 key');
}

test('★ 模型 key 缺了：必须报 ✗（不能"缺了也说好"）', async (t) => {
  const row = await keyRowOf(t, {});
  assert.ok(row, '这条检查得在（说明配置里那行 agent-dsh 被认出来了）');
  assert.equal(row.ok, false, '没有 key 就是不 ok');
  assert.match(row.detail, /还没有/, '要说"还没有"，不是空白');
  assert.match(row.fix, /butler run/, 'fix 要给出路：跑一次 butler run 会开页面让他贴');
});

test('★ 模型 key 存过：报 ✓，并且顺便告诉他想换一把该敲什么', async (t) => {
  const row = await keyRowOf(t, { stored: 'sk-stored' });
  assert.equal(row.ok, true);
  assert.match(row.detail, /已配置/);
  assert.match(row.fix, /--again/, 'key 过期/想换一把的出路是 butler run --again');
});

test('★ 模型 key 来自启动环境：报 ✓ 但如实说是环境里来的（写文件不生效）', async (t) => {
  const row = await keyRowOf(t, { stored: 'sk-file', env: 'sk-from-env' });
  assert.equal(row.ok, true);
  assert.match(row.detail, /来自启动环境里的 DEEPSEEK_API_KEY/,
    '环境变量赢 —— 这时候用户改文件是白改，必须说清楚');
});

// ─────────── 「审批那根线」：隔着两个进程，离线测不到，靠 doctor 在用户机器上查 ───────────
//
// 这根线一头在 dsh 子进程里（它负责问），一头在管家这个进程里（它负责把问题
// 问进微信）。离线怎么测都测不到"真的接上了没有" —— 只有用户机器上跑一次
// doctor 才能确认。所以下面这些用例盯的正是：**接不上的时候必须报 ✗**。

/**
 * 造一份"带审批的"配置，可以把各种坏法摆出来。
 *
 *   policy       —— 补丁里审批那行的策略（'ask' / 'never' / null 表示整行不写）
 *   answerer     —— 'ok' 指向真文件 / 'gone' 指向一个不存在的文件 / 'relative' 相对路径 / null 整行不写
 *   withRow      —— 管家这侧有没有审批那一行
 *   blocked      —— 用一个文件挡住审批目录的路（模拟写不进去）
 */
async function approvalRunOf(t, { policy = 'ask', answerer = 'ok', withRow = true, blocked = false, policyRow = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'doc-appr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dshHome = join(root, 'dsh-home');
  mkdirSync(dshHome, { recursive: true });
  const patchFile = join(dshHome, 'dsh.patch.yml');

  const real = join(root, 'answerer.js');
  writeFileSync(real, '// 假装这就是装好的那个应答者\n');
  const name = answerer === 'ok' ? real
    : answerer === 'gone' ? join(root, '搬走了', 'answerer.js')
    : answerer === 'relative' ? './answerer.js'
    : null;

  const lines = [];
  if (policyRow) {
    lines.push('- id: approval', '  name: "@butler/approval-im"');
    if (policy) lines.push('  config:', `    policy: ${policy}`);
  }
  if (name) lines.push('- id: approval-answerer', `  name: "${name}"`);
  lines.push('');
  writeFileSync(patchFile, lines.join('\n'));

  // 用文件挡住审批目录的路：mkdir 会 ENOTDIR
  const dir = join(root, blocked ? '挡路的文件' : 'state', 'approvals');
  if (blocked) writeFileSync(join(root, '挡路的文件'), '我是个文件，不是目录\n');

  const rows = [
    ...spine().filter((r) => r.id !== 'agent'),
    { id: 'agent-dsh', name: '@butler/agent-dsh', config: { patchFile, home: dshHome, bin: 'dsh' } },
  ];
  if (withRow) rows.push({ id: 'approval', name: '@butler/approval-im', config: { home: root, dir } });

  const t2 = tmpConfig(rows);
  t.after(t2.cleanup);
  return run(t2.file);
}

const named = (r, name) => r.checks.find((c) => c.name === name);

test('★ 审批接得上：报 ✓', async (t) => {
  const r = await approvalRunOf(t);
  const wire = named(r, '审批那根线');
  assert.ok(wire, '这条检查得在（说明配置里那行 agent-dsh 被认出来了）');
  assert.equal(wire.ok, true, `接得上就该是 ✓，实际：${wire.detail}`);
  assert.match(wire.detail, /会问/);
  assert.equal(named(r, '审批落盘')?.ok, true, '目录还没建、但父目录可写 = 第一次用到时自己建');
});

test('★ 补丁里写的是"一律拒绝"：必须报 ✗，并给出路', async (t) => {
  const r = await approvalRunOf(t, { policy: 'never' });
  const wire = named(r, '审批那根线');
  assert.equal(wire?.ok, false, 'policy 不是 ask 就是"管家什么也干不了"，不能算好');
  assert.match(wire.detail, /一律拒绝/);
  assert.match(wire.fix, /butler init/, 'fix 要是能照做的一步');
});

test('★ 补丁里没有审批那一行：报 ✗', async (t) => {
  const r = await approvalRunOf(t, { policyRow: false });
  assert.equal(named(r, '审批那根线')?.ok, false);
  assert.match(named(r, '审批那根线').detail, /没有审批那一行/);
});

test('★ 有审批那行、但没写 policy：也报 ✗（"没说"不等于"会问"）', async (t) => {
  const r = await approvalRunOf(t, { policy: null });
  const wire = named(r, '审批那根线');
  assert.equal(wire?.ok, false);
  assert.match(wire.detail, /没说要不要问/);
});

test('★ 会问、但没人接（补丁里缺应答者那行）：报 ✗', async (t) => {
  const r = await approvalRunOf(t, { answerer: null });
  const wire = named(r, '审批那根线');
  assert.equal(wire?.ok, false, '"问了没人接"到点还是不许，不能算好');
  assert.match(wire.detail, /没人接/);
});

test('★ 应答者的文件不在了（装新版本/搬过目录）：报 ✗，并把那个路径念出来', async (t) => {
  const r = await approvalRunOf(t, { answerer: 'gone' });
  const wire = named(r, '审批那根线');
  assert.equal(wire?.ok, false);
  assert.match(wire.detail, /接的人不在/);
  assert.match(wire.detail, /搬走了/, '要让他看见是哪个路径不见了');
});

test('★ 应答者写的是相对路径：报 ✗ —— 子进程在哪个目录启动是不确定的', async (t) => {
  const r = await approvalRunOf(t, { answerer: 'relative' });
  assert.equal(named(r, '审批那根线')?.ok, false);
});

test('★ 补丁会问、管家这侧却没那行：报 ✗（问了没人看见）', async (t) => {
  const r = await approvalRunOf(t, { withRow: false });
  const side = named(r, '审批这一侧');
  assert.equal(side?.ok, false);
  assert.match(side.detail, /没人看见/);
  assert.match(side.fix, /butler init/);
});

test('★ 审批目录写不进去：报 ✗，并说清后果是"一律不许"', async (t) => {
  const r = await approvalRunOf(t, { blocked: true });
  const dir = named(r, '审批落盘');
  assert.equal(dir?.ok, false, '路上挡着一个文件的时候 mkdir 会失败，不能算能写');
  assert.match(dir.fix, /一律按"不许"处理/, '要把后果说明白：安全，但敏感操作全干不了');
});

test('★ 真通道 + doctor：自检里那条「谁能私聊它」要真的打进报告（第 60 轮）', async () => {
  // 这是**用户可见**那一端的断言。适配层里"check() 有没有这一条"是一回事，
  // 它有没有真的被打进 `butler doctor` 的报告里是另一回事 —— 只有这条能证明后者。
  // 用**真通道**、真内核（不是桩）：桩不会走 `check()` 那条真实路径。
  const dir = mkdtempSync(join(tmpdir(), 'doc-dm-'));
  const t = tmpConfig([
    {
      id: 'channel',
      name: '@butler/channel-feishu',
      // 空凭据 = 常态（离线）。这里要看的是私聊准入那条，它跟凭据无关
      config: { home: dir, appId: '', appSecret: '', dmMode: 'allowlist', dmAllowlist: ['cli_wrong'] },
    },
    { id: 'agent', name: './plugins/agent-stub.mjs' },
    { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
  ]);
  try {
    const r = await run(t.file);
    const c = r.checks.find((x) => x.name === '飞书私聊准入');
    assert.ok(c, `doctor 的报告里该有这一条：\n${formatDoctor(r)}`);
    assert.equal(c.ok, false, '名单里填了 cli_ 等于谁也没放行 —— 要如实报 ✗');
    assert.match(c.fix, /senderId/, '出路要能照着做');
    assert.match(formatDoctor(r), /飞书私聊准入/, '打印出来的报告里也要有这一行');
  } finally {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
