/**
 * agent-exec 的测试。
 *
 *   node --test test/agent.mjs
 *
 * 全部离线：`argv` 都指向真程序（`node -e`、`cat`、`sh`），
 * 因为这个小东西的价值全在**子进程边界**上 —— 退出码、stdout/stderr、
 * 超时、被掐断、stdin 的 EPIPE。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { ExecAgent } from '@butler/agent-exec';

const NODE = process.execPath;

async function setup(config, { ctx } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'exec-work-'));
  const context = ctx ?? new Context();
  await context.plugin(ExecAgent, config);
  return {
    ctx: context,
    agent: context.agent,
    work,
    async cleanup() {
      await context.fiber.dispose();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/** 造一个只关心 argv/stdin 的临时脚本，省得每次都转义 */
function script(body) {
  return [NODE, '-e', body];
}

const run = (t, text, more = {}) => t.agent.run({ text, cwd: t.work, ...more });

async function loadError(config) {
  const ctx = new Context();
  try {
    await ctx.plugin(ExecAgent, config);
    return '';
  } catch (e) {
    return e.message;
  } finally {
    await ctx.fiber.dispose();
  }
}

// ───────────────────────── 加载与校验 ─────────────────────────

test('作为插件加载后 ctx.agent 就位，双身份成立', async () => {
  const t = await setup({ argv: script('process.stdout.write("hi")') });
  try {
    assert.ok(t.ctx.agent instanceof ExecAgent);
    assert.ok(t.ctx.agent instanceof AgentService, '核心层只按 seam 消费');
    assert.equal(t.ctx.agent.id, 'exec');
    assert.equal(t.ctx.agent.cancellable, true);
  } finally { await t.cleanup(); }
});

test('argv 有问题在加载时就抛（不会拖到用户第一次发消息）', async () => {
  for (const cfg of [{}, { argv: [] }, { argv: 'my-agent' }]) {
    const msg = await loadError(cfg);
    // 前两种是空/缺（构造函数拦的），第三种类型不对（schema 拦的）——
    // 措辞不同没关系，要紧的是**都在加载时**被拦下、且都点名了 argv
    assert.ok(msg, `配置 ${JSON.stringify(cfg)} 应当加载失败`);
    assert.match(msg, /argv/, `错误要点名 argv，实际：${msg}`);
  }
});

test('input 只认 arg / stdin', async () => {
  const msg = await loadError({ argv: ['cat'], input: 'pipe' });
  assert.match(msg, /input 只能是 'arg' 或 'stdin'/);
});

test('timeoutMs 必须大于 0', async () => {
  assert.match(await loadError({ argv: ['cat'], timeoutMs: -1 }), /timeoutMs/);
});

test('默认值：input=arg / timeout=300s / cwd 留空', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(ExecAgent, { argv: ['cat'] });
    assert.equal(ctx.agent.config.input, 'arg');
    assert.equal(ctx.agent.config.timeoutMs, 300_000);
    assert.equal(ctx.agent.config.cwd, '');
  } finally { await ctx.fiber.dispose(); }
});

// ───────────────────────── 两种投喂方式 ─────────────────────────

test("input='arg'：问题接到命令行末尾", async () => {
  const t = await setup({ argv: script('process.stdout.write(process.argv[process.argv.length-1])') });
  try {
    const r = await run(t, '把这句话原样吐回来');
    assert.equal(r.text, '把这句话原样吐回来');
    assert.equal(r.sessionId, null, '没有会话概念的后端就返回 null —— 契约允许');
  } finally { await t.cleanup(); }
});

test("input='stdin'：问题写进标准输入", async () => {
  const t = await setup({ argv: script('process.stdin.on("data",d=>process.stdout.write(d))'), input: 'stdin' });
  try {
    const r = await run(t, '从标准输入进来的');
    assert.equal(r.text, '从标准输入进来的');
  } finally { await t.cleanup(); }
});

test("input='stdin' 但子进程根本不读 stdin：拿到 EPIPE 也不许炸", async () => {
  const t = await setup({ argv: script('process.exit(0)'), input: 'stdin', timeoutMs: 3000 });
  try {
    const r = await run(t, 'x'.repeat(200_000));   // 大到一定会撞上管道缓冲区
    assert.ok(!r.error, `不该因为 EPIPE 报错，实际：${r.error}`);
  } finally { await t.cleanup(); }
});

test('问题里带换行、引号、$ 也不会被 shell 拆开（没有 shell）', async () => {
  const t = await setup({ argv: script('process.stdout.write(process.argv[process.argv.length-1])') });
  try {
    const nasty = '第一行\n第二行 "引号" $(whoami) `id` | & ; > 文件';
    const r = await run(t, nasty);
    assert.equal(r.text, nasty, '参数是直接传给 execve 的，不该经过 shell');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 出结果 ─────────────────────────

test('有 stdout 就用 stdout 当回答，首尾空白会去掉', async () => {
  const t = await setup({ argv: script('process.stdout.write("\\n\\n  正文  \\n\\n")') });
  try {
    assert.equal((await run(t, 'x')).text, '正文');
  } finally { await t.cleanup(); }
});

test('stdout 有内容但退出码非零：仍然用 stdout（很多 CLI 边输出边非零退出）', async () => {
  const t = await setup({ argv: script('process.stdout.write("部分结果"); process.exit(2)') });
  try {
    const r = await run(t, 'x');
    assert.equal(r.text, '部分结果');
    assert.ok(!r.error);
  } finally { await t.cleanup(); }
});

test('退出码 0 但什么都没输出：text 为空，交给核心层说"没出结果"', async () => {
  const t = await setup({ argv: script('process.exit(0)') });
  try {
    const r = await run(t, 'x');
    assert.equal(r.text, '');
    assert.ok(!r.error);
  } finally { await t.cleanup(); }
});

test('非零退出 + stderr：只取最后一行', async () => {
  const t = await setup({
    argv: script('process.stderr.write("警告：无关紧要\\n真正的原因\\n"); process.exit(3)'),
  });
  try {
    const r = await run(t, 'x');
    assert.equal(r.error, '真正的原因');
  } finally { await t.cleanup(); }
});

test('非零退出但 stderr 也空：至少报退出码', async () => {
  const t = await setup({ argv: script('process.exit(9)') });
  try {
    assert.match((await run(t, 'x')).error, /退出码 9/);
  } finally { await t.cleanup(); }
});

test('命令不存在：明说启动失败', async () => {
  const t = await setup({ argv: ['/nonexistent/binary-xyz'] });
  try {
    assert.match((await run(t, 'x')).error, /无法启动/);
  } finally { await t.cleanup(); }
});

// ───────────────────────── cwd 与超时取消 ─────────────────────────

test('cwd 默认用请求里的，配了就覆盖', async () => {
  const t = await setup({ argv: script('process.stdout.write(process.cwd())') });
  try {
    const viaReq = await run(t, 'x');
    assert.equal(viaReq.text.endsWith(t.work.split('/').pop()), true, `应当用请求的 cwd，实际 ${viaReq.text}`);

    t.agent.config.cwd = '/' ;
    if (process.platform !== 'win32') {
      assert.equal((await run(t, 'x')).text, '/', '配了 cwd 就以配置为准');
    }
  } finally { await t.cleanup(); }
});

test('超时：到点掐断并说清楚', async () => {
  const t = await setup({ argv: script('setTimeout(()=>{},60000)'), timeoutMs: 300 });
  try {
    assert.match((await run(t, 'x')).error, /命令超时/);
  } finally { await t.cleanup(); }
});

test('取消：signal 一响就立刻返回', async () => {
  const t = await setup({ argv: script('setTimeout(()=>{},60000)') });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const t0 = Date.now();
    const r = await run(t, 'x', { signal: ac.signal });
    assert.ok(Date.now() - t0 < 2000, '取消要立刻生效');
    assert.match(r.error, /已取消/);
  } finally { await t.cleanup(); }
});

test('传进来就已经 aborted 的 signal', async () => {
  const t = await setup({ argv: script('setTimeout(()=>{},60000)') });
  try {
    const ac = new AbortController();
    ac.abort();
    assert.match((await run(t, 'x', { signal: ac.signal })).error, /已取消/);
  } finally { await t.cleanup(); }
});

test('跑完之后监听器被摘掉，不泄漏', async () => {
  const t = await setup({ argv: script('process.stdout.write("ok")') });
  try {
    const ac = new AbortController();
    await run(t, 'x', { signal: ac.signal });
    ac.abort();                                   // 此时不该去 kill 任何东西
    assert.equal((await run(t, 'x')).text, 'ok', '取消过之后还能正常跑');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 两个实现能不能共存 ─────────────────────────

test('同一个 context 里装两个 agent 实现会抛错：一个服务位一个实现', async () => {
  const t = await setup({ argv: script('process.stdout.write("x")') });
  try {
    let msg = '';
    try {
      await t.ctx.plugin(ExecAgent, { argv: ['cat'] });
    } catch (e) { msg = e.message; }
    assert.match(msg, /agent/, '要点明是哪个服务位');
  } finally { await t.cleanup(); }
});

// ───────────────────────── 自检 check() ─────────────────────────

test('check：程序找得到 → 合格，并说清"问题怎么传进去"', async () => {
  const t = await setup({ argv: [process.execPath, '-e', 'process.stdout.write("x")'] });
  try {
    const c = t.agent.check();
    assert.equal(c.length, 1);
    assert.equal(c[0].ok, true);
    assert.match(c[0].detail, /最后一个参数/, '用户要能看懂问题是怎么传进去的');
  } finally { await t.cleanup(); }
});

test('check：input=stdin 时说的是"走标准输入"', async () => {
  const t = await setup({ argv: [process.execPath], input: 'stdin' });
  try {
    assert.match(t.agent.check()[0].detail, /标准输入/);
  } finally { await t.cleanup(); }
});

test('check：程序找不到 → 不合格并给出路（抄了一行命令但没装，是最常见的）', async () => {
  const t = await setup({ argv: ['绝对没有这个程序-zzz'] });
  try {
    const c = t.agent.check()[0];
    assert.equal(c.ok, false);
    assert.match(c.detail, /找不到/);
    assert.match(c.fix, /装好|绝对路径/);
  } finally { await t.cleanup(); }
});

test('check：绝对路径存在但不可执行 → 也不算找得到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exec-nox-'));
  const file = join(dir, 'not-exec.sh');
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o644);
  try {
    const t = await setup({ argv: [file] });
    try {
      assert.equal(t.agent.check()[0].ok, false, '不可执行就是跑不起来，不能算"找到了"');
    } finally { await t.cleanup(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('check 绝不抛错', async () => {
  const t = await setup({ argv: ['/nope/zzz'] });
  try {
    assert.doesNotThrow(() => t.agent.check());
  } finally { await t.cleanup(); }
});
