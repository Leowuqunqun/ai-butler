/**
 * seam-approval 的测试 —— 验证"这个能力位真的能被实现、被消费"。
 *
 * 被测对象是**编译产物**（lib/）。假审批用 TypeScript 写在 test/fixtures/，
 * 先编译再加载：类型契约和运行行为一起验证。
 *
 *   node --test test/seam.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Context } from '@deepseek-ai/cordis';
import { ApprovalService } from '@butler/seam-approval';
import { BrokenApproval, FakeApproval, OwnerService } from './.build/fake-approval.js';

test('实现类作为 cordis 插件加载后，ctx.approval 就位，且实现的是同一份契约', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeApproval);
    assert.ok(ctx.approval, 'ctx.approval 必须就位');
    assert.equal(ctx.approval.id, 'fake');
    assert.ok(ctx.approval instanceof ApprovalService, '加载进来的东西得是 ApprovalService');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('服务位门控：注入 owner 的实现照样能起（ctx.approval 之外的东西不挡路）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(OwnerService);
    await ctx.plugin(FakeApproval);
    assert.ok(ctx.approval);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：一开始没有任何事在等主人点头', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeApproval);
    assert.deepEqual(await ctx.approval.list(), []);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：list 旧的在前（先问的先念给主人听）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeApproval);
    const fake = ctx.approval;
    fake.ask({ id: 'a', reason: '第一件' });
    fake.ask({ id: 'b', reason: '第二件' });
    assert.deepEqual((await ctx.approval.list()).map((r) => r.id), ['a', 'b']);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：answer 记下决定之后，这件事就不在待批清单里了', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeApproval);
    ctx.approval.ask({ id: 'a' });
    assert.equal(await ctx.approval.answer('a', 'allow'), true);
    assert.deepEqual(await ctx.approval.list(), []);
    assert.equal(ctx.approval.settled.get('a'), 'allow');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：不认识 / 已经结算过的 id，答案是 false —— 不许默默当成功', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(FakeApproval);
    assert.equal(await ctx.approval.answer('查无此事', 'allow'), false);
    ctx.approval.ask({ id: 'a' });
    assert.equal(await ctx.approval.answer('a', 'deny'), true);
    assert.equal(await ctx.approval.answer('a', 'allow'), false, '同一件事不许批第二次');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('契约：读不动要抛（别装作"没有人等你点头"）', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(BrokenApproval);
    await assert.rejects(() => ctx.approval.list(), /读不动/);
    await assert.rejects(() => ctx.approval.answer('a', 'allow'), /读不动/);
  } finally {
    await ctx.fiber.dispose();
  }
});
