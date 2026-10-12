/**
 * seam-memory 的测试 —— 验证"这个能力位真的能被实现、被消费"。
 *
 * 被测对象是**编译产物**（lib/），也就是说测试跑的是消费者拿到的那份东西。
 * 假记忆用 TypeScript 写在 test/fixtures/，先编译再加载：
 * 这样类型契约（抽象成员有没有漏）和运行行为一起被验证。
 *
 *   node --test test/seam.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { MemoryService } from '@butler/seam-memory';
import { FakeMemory, OwnerService } from './.build/fake-memory.js';

test('实现类作为 cordis 插件加载后，ctx.memory 就位，且实现的是同一份契约', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeMemory);
    assert.ok(ctx.memory, 'ctx.memory 必须就位');
    assert.equal(ctx.memory.id, 'fake');
    assert.ok(ctx.memory instanceof MemoryService, '加载进来的东西得是 MemoryService');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('服务位门控：注入 owner 的实现照样能起（ctx.memory 之外的东西不挡路）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(OwnerService);
    await ctx.plugin(FakeMemory);
    assert.ok(ctx.memory);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：没记住返回 undefined，**不抛**', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeMemory);
    assert.equal(await ctx.memory.get('从来没写过的 key'), undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：set → get 拿到原值；同一个 key 再 set 是覆盖，createdAt 不变', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeMemory);
    await ctx.memory.set('简历放哪', 'Documents/简历/', { source: 'owner' });
    assert.equal(await ctx.memory.get('简历放哪'), 'Documents/简历/');

    const first = (await ctx.memory.list())[0];
    await ctx.memory.set('简历放哪', 'Documents/求职/');
    const second = (await ctx.memory.list())[0];

    assert.equal(second.value, 'Documents/求职/', '值换了');
    assert.equal(second.createdAt, first.createdAt, 'createdAt 得是第一次那个');
    assert.equal((await ctx.memory.list()).length, 1, '覆盖不是新增一条');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：list 新的在前，能按 kind 筛、能限条数', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeMemory);
    await ctx.memory.set('a', 1, { kind: 'fact' });
    await ctx.memory.set('b', 2, { kind: 'grant' });
    await ctx.memory.set('c', 3);                       // 缺省 = preference

    const all = await ctx.memory.list();
    assert.deepEqual(all.map((e) => e.key), ['c', 'b', 'a'], '新的在前');
    assert.equal(all.find((e) => e.key === 'c').kind, 'preference', 'kind 缺省是 preference');
    assert.equal(all.find((e) => e.key === 'a').kind, 'fact');

    assert.deepEqual((await ctx.memory.list({ kind: 'grant' })).map((e) => e.key), ['b']);
    assert.deepEqual((await ctx.memory.list({ limit: 2 })).map((e) => e.key), ['c', 'b']);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：forget 幂等（本来就没有也不报错）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeMemory);
    await ctx.memory.set('待忘', 1);
    await ctx.memory.forget('待忘');
    assert.equal(await ctx.memory.get('待忘'), undefined);
    await ctx.memory.forget('待忘');                     // 再来一次：不许抛
    assert.deepEqual(await ctx.memory.list(), []);
  } finally {
    await ctx.fiber.dispose();
  }
});
