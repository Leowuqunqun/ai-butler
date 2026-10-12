/**
 * agent-dsh 的测试。
 *
 *   node --test test/agent.mjs
 *
 * 全部离线：`bin` 指向 test/fake-dsh.mjs，一个**真进程**，
 * 按任务文案演出不同的 NDJSON 流。用真进程是刻意的 —— 这个实现的行为
 * 几乎全在子进程边界上（参数顺序、流式解析、超时、被掐断、退出码、stderr）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { DshAgent } from '@butler/agent-dsh';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, 'fixtures', 'fake-dsh.mjs');

/** 起一个 ctx + 一个装好的 DshAgent */
async function setup(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'));
  const work = mkdtempSync(join(tmpdir(), 'dsh-work-'));
  const ctx = new Context();
  // 假 dsh 是 **Node 写的**（实现里 spawn 时继承 process.env），所以它启动时可能先往 stderr
  // 打一句 Node 自己的警告 —— 设了 NODE_USE_ENV_PROXY 的机器上，Node 22 会打
  // "(node:1) [UNDICI-EHPA] Warning: ..." 外加一行 "Use `node --trace-warnings ...`"。
  // 那两行会把"stderr 为空 → 至少报退出码"和"只取最后一行"这两条用例的前提搅掉。
  // 关掉夹具自己的噪音；真 dsh 打不打警告不归这些用例管。
  process.env.NODE_NO_WARNINGS = '1';
  await ctx.plugin(DshAgent, { bin: FAKE, patchFile: '/tmp/patch.yml', home, timeoutMs: 10_000, ...extra });
  return {
    ctx,
    agent: ctx.agent,
    home,
    work,
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

const run = (t, text, more = {}) => t.agent.run({ text, cwd: t.work, ...more });

/**
 * 加载一个配置，把抛出来的错误信息拿回来。
 * ⚠️ 不能用 `assert.rejects(() => ctx.plugin(...))`：`ctx.plugin()` 返回的是
 * cordis 的 **Fiber**（只是个 thenable），不是真 Promise，
 * assert 会报 `Expected instance of Promise ... but got an instance of Fiber`。
 */
async function loadError(cfg) {
  const ctx = new Context();
  try {
    await ctx.plugin(DshAgent, cfg);
    return '';
  } catch (e) {
    return e.message;
  } finally {
    await ctx.fiber.dispose();
  }
}

// ───────────────────────── 加载与配置 ─────────────────────────


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

test('作为插件加载后 ctx.agent 就位，双身份成立', async () => {
  const t = await setup();
  try {
    assert.ok(t.ctx.agent instanceof DshAgent, '是实现类的实例');
    assert.ok(t.ctx.agent instanceof AgentService, '也是 seam 的实例');
    assert.equal(t.ctx.agent.id, 'dsh');
    assert.equal(t.ctx.agent.label, 'DSH headless agent');
    assert.equal(t.ctx.agent.cancellable, true, '支持被掐断——这一点必须自称准确');
  } finally { await t.cleanup(); }
});

test('缺必填配置在**加载时**就抛，不拖到用户第一次发消息', async () => {
  // schemastery 不会拒绝缺字段，所以这里是实现自己在构造函数里校验的
  for (const cfg of [
    { bin: FAKE, home: '/tmp/h' },                    // 缺 patchFile
    { bin: FAKE, patchFile: '/tmp/p.yml' },           // 缺 home
    { bin: FAKE },                                    // 两个都缺
  ]) {
    const msg = await loadError(cfg);
    assert.match(msg, /缺少必填配置/, `配置 ${JSON.stringify(cfg)} 应当加载失败，实际：${msg || '(没抛)'}`);
  }
});

test('错误信息要点明缺了哪个、以及它是干什么的', async () => {
  const msg = await loadError({ bin: FAKE });
  assert.match(msg, /patchFile/, '要点名');
  assert.match(msg, /DSH_HOME/, '要解释 home 是干什么的——光说"缺 home"用户看不懂');
});

test('timeoutMs 必须大于 0', async () => {
  const msg = await loadError({ bin: FAKE, patchFile: '/tmp/p.yml', home: '/tmp/h', timeoutMs: 0 });
  assert.match(msg, /timeoutMs/);
});

test('默认值：bin=dsh / profile=headless / timeout=300s', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(DshAgent, { patchFile: '/tmp/p.yml', home: '/tmp/h' });
    assert.equal(ctx.agent.config.bin, 'dsh');
    assert.equal(ctx.agent.config.profile, 'headless');
    assert.equal(ctx.agent.config.timeoutMs, 300_000);
  } finally { await ctx.fiber.dispose(); }
});

// ───────────────────────── 命令行拼装 ─────────────────────────

test('参数顺序：--patch 必须排在 --json 前面（否则 dsh 直接报 unknown option）', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'echo-args');
    const argv = JSON.parse(r.text);
    const iPatch = argv.indexOf('--patch');
    const iJson = argv.indexOf('--json');
    assert.ok(iPatch >= 0 && iJson >= 0);
    assert.ok(iPatch < iJson, `--patch 必须在 --json 前，实际是 ${argv.join(' ')}`);
    assert.equal(argv[iPatch + 1], '/tmp/patch.yml');
    assert.deepEqual(argv.slice(0, 2), ['--profile', 'headless']);
  } finally { await t.cleanup(); }
});

test('新会话不带 --session-id；续接时带上', async () => {
  const t = await setup();
  try {
    const fresh = JSON.parse((await run(t, 'echo-args')).text);
    assert.equal(fresh.includes('--session-id'), false, '新会话不该带 --session-id');

    const cont = JSON.parse((await run(t, 'echo-args', { sessionId: 's-42' })).text);
    assert.equal(cont[cont.indexOf('--session-id') + 1], 's-42');
  } finally { await t.cleanup(); }
});

test('任务文案是最后一个参数', async () => {
  const t = await setup();
  try {
    const argv = JSON.parse((await run(t, 'echo-args')).text);
    assert.equal(argv[argv.length - 1], 'echo-args');
  } finally { await t.cleanup(); }
});

test('私有的 DSH_HOME 和 cwd 真的传到了子进程', async () => {
  const t = await setup();
  try {
    const info = JSON.parse((await run(t, 'env')).text);
    assert.equal(info.home, t.home, 'DSH_HOME 必须是管家私有的目录（跟 dsh web 共用会撞写锁）');
    // macOS 的 /var 是 /private/var 的软链，比一下 basename 就够了
    assert.equal(info.cwd.endsWith(t.work.split('/').pop()), true, `cwd 要生效，实际 ${info.cwd}`);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 出结果的路径 ─────────────────────────

test('正常完成：拿到 final，中间的 text 事件不算数', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'ok');
    assert.equal(r.text, '干完了');
    assert.equal(r.error, null);
    assert.match(r.sessionId, /^fake-/, 'sessionId 要带回来——下次靠它续接');
  } finally { await t.cleanup(); }
});

test('续接时返回原来的 sessionId（不是新造的）', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'ok', { sessionId: 's-keep' });
    assert.equal(r.sessionId, 's-keep');
  } finally { await t.cleanup(); }
});

test('没有 final 时 text 为空，交给核心层去说"没出结果"', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'no-final');
    assert.equal(r.text, '');
    assert.equal(r.error, null);
  } finally { await t.cleanup(); }
});

test('流里混进非 JSON 也不崩', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'garbage');
    assert.equal(r.text, '半路有杂音也活下来了');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 进度（这是给用户看的）─────────────────────────

test('tool_call 会变成一行进度，thinking 不外传', async () => {
  const t = await setup();
  try {
    const lines = [];
    const r = await run(t, 'tools', { onProgress: (l) => lines.push(l) });

    assert.equal(r.text, '跑完了');
    assert.ok(lines.some((l) => /read/.test(l) && /src\/index\.ts/.test(l)), `要报"在读哪个文件"，实际：${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /bash/.test(l) && /npm test/.test(l)), '要报"在跑什么命令"');
    assert.ok(lines.some((l) => /⚠️/.test(l) && /bash/.test(l)), '工具失败也要说');
    assert.equal(lines.some((l) => /不该外传/.test(l)), false, 'thinking 会刷屏，不该外传');
  } finally { await t.cleanup(); }
});

test('工具入参是空的时不拖一截空括号', async () => {
  const t = await setup();
  try {
    const lines = [];
    await run(t, 'no-input', { onProgress: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /mystery/.test(l)), '工具名要报');
    assert.equal(lines.some((l) => /\{\}/.test(l)), false, `别把 {} 灌进聊天窗口：${lines.join(' | ')}`);
  } finally { await t.cleanup(); }
});

test('长入参会被截断，不会把整个 JSON 灌进聊天窗口', async () => {
  const t = await setup();
  try {
    const lines = [];
    await run(t, 'tools', { onProgress: (l) => lines.push(l) });
    for (const l of lines) assert.ok(l.length < 120, `进度行太长了：${l}`);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 失败的路径 ─────────────────────────

test('turn_end 的 error reason → 如实带回原文', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'err');
    assert.equal(r.error, '模型没配 key');
    assert.equal(r.text, '');
  } finally { await t.cleanup(); }
});

test('非零退出：只取 stderr 最后一行，不把插件告警倒给用户', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'fail');
    assert.match(r.error, /真原因在这一行/, '要说真正的原因');
    assert.equal(/插件告警/.test(r.error), false, '插件告警不是给用户看的');
  } finally { await t.cleanup(); }
});

test('会话被占用 → 类型化的 SESSION_LOCKED + 一句人话', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'lock');
    assert.equal(r.code, 'SESSION_LOCKED', '核心层靠这个码决定"换新会话重试"');
    assert.match(r.error, /会话被别的进程占着/);
    assert.equal(/already owned/.test(r.error), false, '别把英文原文倒给用户');
  } finally { await t.cleanup(); }
});

test('非零退出但没有 stderr → 至少报退出码', async () => {
  const t = await setup();
  try {
    const r = await run(t, 'silent-nonzero');
    assert.match(r.error, /退出码 7/);
  } finally { await t.cleanup(); }
});

test('启动不了（bin 不存在）→ 明说启动失败', async () => {
  const t = await setup({ bin: '/nonexistent/dsh-xyz' });
  try {
    const r = await run(t, 'ok');
    assert.match(r.error, /无法启动 dsh/);
  } finally { await t.cleanup(); }
});

// ───────────────────────── 超时与取消 ─────────────────────────

test('超时：到点掐断并说清楚', async () => {
  const t = await setup({ timeoutMs: 300 });
  try {
    const r = await run(t, 'hang');
    assert.match(r.error, /超时/, '超时必须明说，不能让用户无限等');
  } finally { await t.cleanup(); }
});

test('取消：signal 一响就立刻返回，不干等（agent 一跑可能几分钟）', async () => {
  const t = await setup();
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const t0 = Date.now();
    const r = await run(t, 'hang', { signal: ac.signal });
    const cost = Date.now() - t0;
    assert.ok(cost < 2000, `取消应当立刻生效，实际 ${cost}ms`);
    assert.match(r.error, /已取消/);
  } finally { await t.cleanup(); }
});

test('传进来就已经 aborted 的 signal：不启动、直接返回', async () => {
  const t = await setup();
  try {
    const ac = new AbortController();
    ac.abort();
    const r = await run(t, 'ok', { signal: ac.signal });
    assert.match(r.error, /已取消/);
  } finally { await t.cleanup(); }
});

test('正常跑完之后，signal 的监听器被摘掉了（不泄漏）', async () => {
  const t = await setup();
  try {
    const ac = new AbortController();
    await run(t, 'ok', { signal: ac.signal });
    // 再 abort 一次不该有任何副作用（监听器若还挂着就会去 kill 一个不存在的进程）
    ac.abort();
    const r2 = await run(t, 'ok');
    assert.equal(r2.text, '干完了', '取消过之后还能正常跑');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 自检 check() ─────────────────────────
//
// doctor 靠这些报"为什么没反应"。所以每一条都要验：**过了要说过得怎么样，
// 没过要说该怎么办** —— 只说 ok:false 的检查等于没做。

const byName = (checks, name) => checks.find((c) => c.name.includes(name));

test('check：三项都齐，dsh 找得到、patch 在、目录可用', async () => {
  const patch = join(mkdtempSync(join(tmpdir(), 'dsh-p-')), 'p.yml');
  writeFileSync(patch, '[]');
  const t = await setup({ patchFile: patch });
  try {
    const c = t.agent.check();
    assert.equal(c.length, 3);
    assert.equal(c.every((x) => x.ok), true, JSON.stringify(c, null, 2));
    assert.match(byName(c, 'dsh 可执行文件').detail, /fake-dsh\.mjs/, '过了也要说清找到的是哪个');
    assert.match(byName(c, 'patch 文件').detail, /p\.yml/);
  } finally { await t.cleanup(); }
});

test('check：dsh 找不到 → 不合格，并给出两条出路', async () => {
  const t = await setup({ bin: '/nonexistent/dsh-zzz' });
  try {
    const c = byName(t.agent.check(), 'dsh 可执行文件');
    assert.equal(c.ok, false);
    assert.match(c.detail, /找不到/);
    assert.match(c.fix, /装上 dsh|绝对路径/, 'fix 必须是一个动作');
  } finally { await t.cleanup(); }
});

test('check：patch 文件不在 → 不合格，并解释那文件是干什么的', async () => {
  const t = await setup({ patchFile: missing('p.yml') });
  try {
    const c = byName(t.agent.check(), 'patch 文件');
    assert.equal(c.ok, false);
    assert.match(c.fix, /模型通道|人格/, '用户不知道 patch 是什么，得解释');
  } finally { await t.cleanup(); }
});

test('check：私有目录跟 dsh 自己的撞了 → 专门拦下来（这是真会踩的坑）', async () => {
  const t = await setup({ home: join(homedir(), '.dsh') });
  try {
    const c = byName(t.agent.check(), '私有数据目录');
    assert.equal(c.ok, false, '跟 dsh web 共用会撞写锁，必须拦');
    assert.match(c.fix, /写锁|占用/);
  } finally { await t.cleanup(); }
});

test('check：目录的上一级都不存在 → 不合格', async () => {
  // 注意：要传**多级的**名字。missing() 自己会建一个临时目录，
  // 只传一级的话父目录是存在的，那就验不到"父目录不存在"这条。
  const t = await setup({ home: missing(join('a', 'b', 'home')) });
  try {
    assert.equal(byName(t.agent.check(), '私有数据目录').ok, false);
  } finally { await t.cleanup(); }
});

test('check 绝不抛错（doctor 靠它兜底，它自己不能炸）', async () => {
  const t = await setup({ bin: '/nope', patchFile: '/nope.yml', home: '/nope/sub' });
  try {
    assert.doesNotThrow(() => t.agent.check());
  } finally { await t.cleanup(); }
});

// ── 路径漂移：一个真踩过的坑 ──

test('相对路径的 patchFile / home 在**构造时**就钉成绝对值', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(DshAgent, { bin: FAKE, patchFile: 'rel/p.yml', home: 'rel/home' });
    const a = ctx.agent;
    assert.equal(isAbsolute(a.patchFile), true, '不钉死的话，它会跟着每个任务的 cwd 漂移');
    assert.equal(isAbsolute(a.home), true);
    assert.equal(a.patchFile, join(process.cwd(), 'rel/p.yml'));
  } finally { await ctx.fiber.dispose(); }
});

test('换一个 cwd 跑任务，patchFile 不会跟着变（之前会）', async () => {
  const t = await setup({ patchFile: 'rel/p.yml', home: 'rel/home' });
  try {
    const before = t.agent.patchFile;
    await run(t, 'echo-args', { cwd: tmpdir() });
    assert.equal(t.agent.patchFile, before, '配置一个字没改，路径就不该变');
  } finally { await t.cleanup(); }
});
