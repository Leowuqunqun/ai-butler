/**
 * 管家这一侧的审批：念给主人听、把答复落回去、超时 = 不许。
 *
 * 被测对象是编译产物（lib/），用的是**真的文件**（临时目录），不是内存假货 ——
 * 这一层最容易出事的地方恰恰是"盘上到底写了什么"。
 *
 *   node --test test/approval.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ApprovalService } from '@butler/seam-approval';
import { ImApproval } from '@butler/approval-im';
// 邮箱协议是内部实现：测试直接摸编译产物（包对外的入口只有 `.` 和 `./answerer`）
import { makeRequest, postRequest, sweep } from '../lib/mailbox.js';

/** 起一个容器，dir 指向临时目录 */
async function setup(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'butler-appr-'));
  const dir = over.dir ?? join(root, 'approvals');
  const ctx = new Context();
  await ctx.plugin(ImApproval, { dir, home: root, timeoutMs: 60_000, ...over.config });
  return {
    ctx, dir, root,
    approvals: ctx.approval,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    readAudit: () => {
      const f = join(dir, 'approvals.jsonl');
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

function hang(dir, over = {}) {
  const req = makeRequest({
    agent: 'dsh', tool: 'bash', reason: '执行一条命令', timeoutMs: 60_000, ...over,
  });
  postRequest(dir, req);
  return req;
}

test('插件加载后 ctx.approval 就位，就是那个真实现（不是夹具）', async () => {
  const t = await setup();
  try {
    assert.ok(t.approvals, 'ctx.approval 必须就位');
    assert.equal(t.approvals.id, 'im');
    assert.ok(t.approvals instanceof ApprovalService);
    assert.equal(t.approvals.dir, t.dir, '文件落在配置说的那个目录');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('一件都没有的时候，list 是空的 —— 而且**不建目录**（读不该有副作用）', async () => {
  const t = await setup();
  try {
    assert.deepEqual(await t.approvals.list(), []);
    assert.equal(existsSync(t.dir), false, '光看一眼不该把目录建出来');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('待批的事会被念出来，旧的在前', async () => {
  const t = await setup();
  try {
    // 用**相对**时间：写死年份的话，哪天过了那天，这些请求一挂出来就是过期的
    const base = Date.now();
    const a = hang(t.dir, { reason: '第一件', now: base });
    const b = hang(t.dir, { reason: '第二件', now: base + 1000 });
    const list = await t.approvals.list();
    assert.deepEqual(list.map((r) => r.id), [a.id, b.id], '先问的先念');
    assert.equal(list[0].reason, '第一件');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 主人说"允许"：从待批里消失、留一行账、凭据还在', async () => {
  const t = await setup();
  try {
    const req = hang(t.dir, { reason: '要删掉 ~/下载/旧项目' });
    assert.equal(await t.approvals.answer(req.id, 'allow'), true);
    assert.deepEqual(await t.approvals.list(), [], '批过的事不该还挂着');

    const lines = t.readAudit();
    assert.equal(lines.length, 1, '一次审批只留一行账');
    assert.equal(lines[0].outcome, 'allowed-once');
    assert.equal(lines[0].by, 'owner');
    assert.equal(lines[0].reason, '要删掉 ~/下载/旧项目', '账上得有"批的是什么"');
    assert.ok(existsSync(join(t.dir, 'pending', `${req.id}.answer`)), '凭据要留着');
    assert.equal(existsSync(join(t.dir, 'pending', `${req.id}.json`)), false, '待批文件该拿掉');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('不认识的编号：说不认识，而且**不留一行"主人批过"的账**', async () => {
  const t = await setup();
  try {
    assert.equal(await t.approvals.answer('查无此事', 'allow'), false);
    assert.deepEqual(t.readAudit(), []);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('同一件事只认第一次：第二次答是 false，账也还是一行', async () => {
  const t = await setup();
  try {
    const req = hang(t.dir);
    assert.equal(await t.approvals.answer(req.id, 'allow'), true);
    assert.equal(await t.approvals.answer(req.id, 'allow'), false, '同一件事不许批第二次');
    assert.equal(t.readAudit().length, 1);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 超时 = 不许：过期的事 list 不念，而且被结算成 rejected/timeout 落进账', async () => {
  const t = await setup();
  try {
    const req = hang(t.dir, { timeoutMs: -1 });     // 一挂出来就已经过期
    assert.deepEqual(await t.approvals.list(), [], '过期的不该再念给主人听');
    const lines = t.readAudit();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, req.id);
    assert.equal(lines[0].outcome, 'rejected', '超时就是不许，不是"再等等"');
    assert.equal(lines[0].by, 'timeout');
    assert.equal(existsSync(join(t.dir, 'pending', `${req.id}.json`)), false);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('过期的旧账：sweep 之后再 sweep 不会重复记账', async () => {
  const t = await setup();
  try {
    hang(t.dir, { timeoutMs: -1 });
    assert.equal(sweep(t.dir), 1);
    assert.equal(sweep(t.dir), 0, '结过一次就不再结');
    assert.equal(t.readAudit().length, 1);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('★ 含隐私：目录 0700、待批文件 0600', async () => {
  const t = await setup();
  try {
    const req = hang(t.dir);
    assert.equal(statSync(t.dir).mode & 0o777, 0o700, '审批目录只有本人可进');
    assert.equal(statSync(join(t.dir, 'pending')).mode & 0o777, 0o700);
    assert.equal(statSync(join(t.dir, 'pending', `${req.id}.json`)).mode & 0o777, 0o600);
    await t.approvals.answer(req.id, 'deny');
    assert.equal(statSync(join(t.dir, 'approvals.jsonl')).mode & 0o777, 0o600, '账本也是隐私');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('一行烂数据挡不住整批（坏的那件跳过，别的照常念）', async () => {
  const t = await setup();
  try {
    const good = hang(t.dir, { reason: '好的一件' });
    writeFileSync(join(t.dir, 'pending', 'broken.json'), '{ 这不是 JSON');
    const list = await t.approvals.list();
    assert.deepEqual(list.map((r) => r.id), [good.id]);
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});

test('盘上写的确实是一份能直接看懂的东西（排错时人要看它）', async () => {
  const t = await setup();
  try {
    const req = hang(t.dir, { reason: '读一下 ~/.ssh' });
    const raw = JSON.parse(readFileSync(join(t.dir, 'pending', `${req.id}.json`), 'utf8'));
    assert.equal(raw.tool, 'bash');
    assert.equal(raw.agent, 'dsh');
    assert.equal(raw.reason, '读一下 ~/.ssh');
    assert.ok(raw.expiresAt > raw.createdAt, '得有"到点就不许"的期限');
  } finally { await t.ctx.fiber.dispose(); t.cleanup(); }
});
