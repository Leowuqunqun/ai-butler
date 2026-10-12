/**
 * 记忆的**自动抽取**：管家在回答里写 `[[记住: …]]`，内核截下来存好。
 *
 * 这里最要紧的性质是**宁可漏认，不可错认** —— 认错一条记忆会跟着每一轮请求走，
 * 悄悄影响之后所有回答，而主人根本不知道自己在跟一条错记忆说话。
 * 所以下面量得最细的是"**不**认"的那些边界。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ButlerCore } from '@butler/core';
import { FileMemory } from '@butler/memory-file';
import { FakeAgent, FakeChannel } from './.build/harness.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 等到某个条件成立 —— 内核是异步跑的，断言之前必须等，不能猜 */
async function waitFor(fn, what = '条件', ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`等「${what}」超时了（${ms}ms）`);
    await sleep(5);
  }
}

async function setup(agentCfg = {}, coreCfg = {}, memoryFile = 'memory.json') {
  const dir = mkdtempSync(join(tmpdir(), 'butler-automem-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  const ctx = new Context();
  await ctx.plugin(FakeChannel);
  await ctx.plugin(FakeAgent, agentCfg);
  await ctx.plugin(FileMemory, { file: join(dir, memoryFile) });
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,
    ...coreCfg,
  });
  // ⚠️ 加载 ≠ 上线：不 start() 就一条信都不收（core.mjs 里有一条专门盯着这件事的用例）
  await ctx.core.start();
  return {
    ctx,
    channel: ctx.channel,
    dir,
    async answer(text, agentReply) {
      ctx.agent.hook = () => ({ text: agentReply });
      const before = ctx.channel.sent.length;
      ctx.channel.push({ text });
      await waitFor(() => ctx.channel.sent.length > before, '回话');
      await ctx.channel.settle();
      return ctx.channel.texts().join('\n');
    },
    async facts() {
      const list = await ctx.memory.list();
      return list.map((e) => JSON.stringify(e)).join('\n');
    },
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ───────────────────────── 认 ─────────────────────────

test('★ 管家在末尾单独写一行「记住」：真的记下了，而且主人永远看不到那行标记', async () => {
  const s = await setup({});
  try {
    const FACT = '主人的简历都放 Documents/简历/';
    const out = await s.answer('我简历放哪好', `放 Documents/简历/ 就行\n[[记住: ${FACT}]]`);

    // 记下了
    assert.match(await s.facts(), /主人的简历都放 Documents/);
    // 但标记本身**绝不许**漏进微信：那是内部约定，主人只会看见一串黑话
    assert.doesNotMatch(out, /\[\[记住/);
    assert.doesNotMatch(out, /\]\]/);
    // 而且要说出来 —— 偷偷记下的记忆比公开的麻烦得多
    assert.match(out, /我顺手记下了/);
    assert.match(out, /忘掉第 N 条/);
  } finally { await s.cleanup(); }
});

test('两条都在：只认最后一条（越靠后越像最终结论）', async () => {
  const s = await setup({});
  try {
    const out = await s.answer('帮我看看', '先这样\n[[记住: 第一条]]\n[[记住: 第二条]]');
    const facts = await s.facts();
    assert.match(facts, /第二条/);
    assert.doesNotMatch(facts, /第一条/);
    assert.doesNotMatch(out, /\[\[记住/);
  } finally { await s.cleanup(); }
});

test('同一件事说两遍：只留一条（同一句是覆盖，不是越记越乱）', async () => {
  const s = await setup({});
  try {
    const FACT = '我习惯用 pnpm';
    await s.answer('一', `好的\n[[记住: ${FACT}]]`);
    await s.answer('二', `好的\n[[记住: ${FACT}]]`);
    const list = await s.ctx.memory.list();
    assert.equal(list.length, 1, `同一句话该只留一条，实际 ${list.length} 条`);
  } finally { await s.cleanup(); }
});

// ───────────────────────── 不认（但不漏）─────────────────────────

test('混在句子中间：一个字都不记，但标记照样摘掉（别让主人看见黑话）', async () => {
  const s = await setup({});
  try {
    const out = await s.answer('嗯', '我打算 [[记住: 这句不算]] 这样处理这件事');
    assert.equal(await s.ctx.memory.list().then((l) => l.length), 0, '句中的标记不该被认成记忆');
    assert.doesNotMatch(out, /\[\[记住/);
    assert.match(out, /这样处理这件事/);
  } finally { await s.cleanup(); }
});

test('前后有别的话：也不算（只认"整行就是标记"这一种写法）', async () => {
  const s = await setup({});
  try {
    const out = await s.answer('嗯', '我来记一下 [[记住: 这条不算]]');
    assert.equal(await s.ctx.memory.list().then((l) => l.length), 0, '整行之外的写法不该被认成记忆');
    assert.match(out, /我来记一下/, '话本身要照常送到');
    assert.doesNotMatch(out, /\[\[记住/, '但标记本身不许漏出去');
  } finally { await s.cleanup(); }
});

test('空的和超长的：都不认（宁可漏认，不可错认）', async () => {
  const s = await setup({});
  try {
    const a = await s.answer('一', '好\n[[记住:   ]]');
    const b = await s.answer('二', `好\n[[记住: ${'很长'.repeat(80)}]]`);
    assert.equal(await s.ctx.memory.list().then((l) => l.length), 0, '空的和超长的都不该记');
    // 不记，但两处标记都得摘干净
    assert.doesNotMatch(a, /\[\[记住/);
    assert.doesNotMatch(b, /\[\[记住/);
  } finally { await s.cleanup(); }
});

test('没写标记：回答一个字节都不动', async () => {
  const s = await setup({});
  try {
    const out = await s.answer('在吗', '在。');
    assert.match(out, /在。/);
    assert.doesNotMatch(out, /我顺手记下了/);
  } finally { await s.cleanup(); }
});

// ───────────────────────── 开关与失败 ─────────────────────────

test('关掉自动记忆：不记，但标记还是要摘（主人更不能看见黑话）', async () => {
  const s = await setup({}, { autoMemory: false });
  try {
    const out = await s.answer('嗯', '好的\n[[记住: 别记这条]]');
    assert.equal(await s.ctx.memory.list().then((l) => l.length), 0);
    assert.doesNotMatch(out, /\[\[记住/);
    assert.match(out, /好的/);
  } finally { await s.cleanup(); }
});

test('记忆写不进去：回答照样送到手上（绝不能因为记账失败就没答复）', async () => {
  // 把记忆"文件"指到**目录**上 —— 写它一定失败（EISDIR）。
  // ⚠️ 别指到 state.json：那是内核自己的账本，撞上它红的是测试自己。
  const s = await setup({}, {}, '.');
  try {
    const out = await s.answer('嗯', '答案在这里\n[[记住: 这条写不进去]]');
    assert.match(out, /答案在这里/);
    assert.doesNotMatch(out, /\[\[记住/);
  } finally { await s.cleanup(); }
});
