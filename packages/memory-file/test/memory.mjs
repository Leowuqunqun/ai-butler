/**
 * memory-file 的测试 —— 跑的是**编译产物**（lib/）。
 *
 * 这里盯的三件事，都是"用户会疼"的地方：
 *   · 顺序：`list` 新的在前，覆盖过的那条要挪到最前面（"忘掉第 2 条"靠它）
 *   · 隐私：目录 0700、文件 0600
 *   · 坏文件：**不许当空的**（当空 = "我记住的东西全没了"且没有任何线索）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import FileMemory from '../lib/index.js';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'butler-memory-'));
}

/** 起一个真插件（cordis 会套用 static Config 的默认值） */
async function boot(home) {
  const ctx = new Context();
  await ctx.plugin(FileMemory, { home });
  return ctx;
}

const fileOf = (home) => join(home, 'state', 'memory.json');

test('作为 cordis 插件加载后 ctx.memory 就位，文件落在 <home>/state/memory.json', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    assert.ok(ctx.memory);
    assert.equal(ctx.memory.id, 'file');
    assert.equal(ctx.memory.file, fileOf(home));
  } finally {
    await ctx.fiber.dispose();
  }
});

test('没记住返回 undefined，而且**不报错**（没记过不是错误）', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    assert.equal(await ctx.memory.get('从来没写过'), undefined);
    assert.deepEqual(await ctx.memory.list(), []);
    assert.ok(!existsSync(fileOf(home)), '只是读，不该建文件');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('★ set → get 拿到原值（对象也行），kind 缺省是 preference', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    await ctx.memory.set('简历放哪', 'Documents/简历/', { source: 'owner', note: '记住：简历都放 Documents/简历/' });
    assert.equal(await ctx.memory.get('简历放哪'), 'Documents/简历/');

    await ctx.memory.set('工作目录', { path: '~/work', readme: true });
    assert.deepEqual(await ctx.memory.get('工作目录'), { path: '~/work', readme: true });

    const [newest] = await ctx.memory.list();
    assert.equal(newest.key, '工作目录', '后写的在前');
    const older = (await ctx.memory.list()).find((e) => e.key === '简历放哪');
    assert.equal(older.kind, 'preference');
    assert.equal(older.source, 'owner');
    assert.equal(older.note, '记住：简历都放 Documents/简历/', '主人原话要留着（忘的时候他记不住 key）');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('★ 覆盖：值换了、kind 沿用、createdAt 不变，而且**挪到最前面**', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    await ctx.memory.set('a', 1, { kind: 'grant' });
    await ctx.memory.set('b', 2);
    const aBefore = (await ctx.memory.list()).find((e) => e.key === 'a');

    await ctx.memory.set('a', '改过了');
    const all = await ctx.memory.list();

    assert.deepEqual(all.map((e) => e.key), ['a', 'b'], '更新过的那条要挪到最前面');
    const aAfter = all[0];
    assert.equal(aAfter.value, '改过了');
    assert.equal(aAfter.createdAt, aBefore.createdAt, 'createdAt 是"哪年开始记的"，不许变');
    assert.equal(aAfter.kind, 'grant', '不写明 kind 时沿用原来那类（授权不许被悄悄降级）');
    assert.equal(all.length, 2, '覆盖不是新增一条');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('list：按 kind 筛、按条数截断（截断发生在排序之后）', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    await ctx.memory.set('p1', 1, { kind: 'preference' });
    await ctx.memory.set('f1', 2, { kind: 'fact' });
    await ctx.memory.set('g1', 3, { kind: 'grant' });
    await ctx.memory.set('p2', 4, { kind: 'preference' });

    assert.deepEqual((await ctx.memory.list()).map((e) => e.key), ['p2', 'g1', 'f1', 'p1']);
    assert.deepEqual((await ctx.memory.list({ kind: 'grant' })).map((e) => e.key), ['g1']);
    assert.deepEqual((await ctx.memory.list({ limit: 2 })).map((e) => e.key), ['p2', 'g1']);
    assert.deepEqual((await ctx.memory.list({ kind: 'preference', limit: 1 })).map((e) => e.key), ['p2']);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('★ forget 幂等：本来就没有，也不报错、也不建文件', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    await ctx.memory.forget('压根没有这条');
    assert.ok(!existsSync(fileOf(home)), '没这条就别动文件');

    await ctx.memory.set('待忘', 1);
    await ctx.memory.forget('待忘');
    assert.equal(await ctx.memory.get('待忘'), undefined);
    await ctx.memory.forget('待忘');                       // 再来一次
    assert.deepEqual(await ctx.memory.list(), []);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('★ 隐私：目录 0700、文件 0600', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    await ctx.memory.set('我的工作目录', '~/work');
    const file = fileOf(home);
    assert.equal(statSync(file).mode & 0o777, 0o600, '记忆文件必须只有本人可读');
    assert.equal(statSync(join(home, 'state')).mode & 0o777, 0o700, '目录也一样');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('★ 文件坏了要**拦下来**，不当成空（当空就是"我记住的全没了"还没线索）', async () => {
  const home = tempHome();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(fileOf(home), '{ 这不是 JSON');

  const ctx = await boot(home);
  try {
    await assert.rejects(() => ctx.memory.list(), (err) => {
      assert.match(err.message, /不是合法 JSON/);
      assert.ok(err.message.includes(fileOf(home)), '得说出是哪个文件');
      assert.match(err.message, /删掉|改名/, '得给出怎么修');
      return true;
    });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('文件不存在 = 还没记过（空，不抛）', async () => {
  const home = tempHome();
  const ctx = await boot(home);
  try {
    assert.deepEqual(await ctx.memory.list(), []);
  } finally {
    await ctx.fiber.dispose();
  }
});
