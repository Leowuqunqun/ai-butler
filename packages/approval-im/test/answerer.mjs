/**
 * dsh 那一侧的应答者：把 `approval/request` 接住、问主人、交出四种结局之一。
 *
 * ── 为什么这样测 ────────────────────────────────────────────────
 *
 * 应答者要跑在 dsh 的容器里，而 dsh 用的是 cordis 的**瀑布式事件**。
 * 所以这里就照它的用法来：`ctx.waterfall('approval/request', req)`。
 * 管家那一侧放在**另一个 Context** 里（同一个目录）—— 两个进程的实情，
 * 也是这一层最要紧的性质：协议不靠共享内存。
 *
 * 离线、不需要模型 key、不需要真 dsh。
 *
 *   node --test test/answerer.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ImApproval } from '@butler/approval-im';
import ImApprovalAnswerer from '@butler/approval-im/answerer';
import { readPending } from '../lib/mailbox.js';

/** dsh 挂上来的问题（形状照抄 @deepseek-ai/dsh-user-approval 的 ApprovalRequestEvent） */
const REQ = {
  agent: { session: { id: 'sess-1' } },
  toolName: 'bash',
  callId: 'call-7',
  reason: 'hook denied: destructive command',
  displayReason: { en: 'Delete ~/Downloads/old-project', zh: '删除 ~/下载/旧项目' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起两个容器：左边是 dsh 里的应答者，右边是管家 */
async function setup(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'butler-ans-'));
  const dir = join(root, 'approvals');
  const dshCtx = new Context();          // 「dsh 子进程」
  const butlerCtx = new Context();       // 「管家进程」
  await dshCtx.plugin(ImApprovalAnswerer, {
    dir, home: root, timeoutMs: 5_000, pollMs: 20, ...config,
  });
  await butlerCtx.plugin(ImApproval, { dir, home: root, timeoutMs: 5_000 });
  return {
    dir, root, dshCtx, butlerCtx,
    // 照 dsh 的**真实调用**来（dsh-user-approval 的 decide()）：
    //   ctx.waterfall(scope, 'approval/request', req, () => 'unavailable')
    // cordis 把**最后一个参数**当成最内层 next —— 也就是"没有人认领时的兜底行为"，
    // dsh 给的兜底是 unavailable（fail-closed）。少传这个参数，请求会被当成兜底函数。
    ask: (req = REQ) => dshCtx.waterfall('approval/request', req, () => 'unavailable'),
    audit: () => {
      const f = join(dir, 'approvals.jsonl');
      if (!existsSync(f)) return [];
      return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    /** 等主人那一侧真的看到这件事 */
    waitPending: async (ms = 1500) => {
      for (let i = 0; i < ms / 10; i += 1) {
        const list = readPending(dir);
        if (list.length) return list;
        await sleep(10);
      }
      return readPending(dir);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('★ 问题真的挂到了管家看得见的地方（用的是主人能看懂的中文文案）', async () => {
  const t = await setup();
  try {
    const pending = t.ask();                       // 应答者开始等
    const list = await t.waitPending();
    assert.equal(list.length, 1, '应当有一件在等主人');
    assert.equal(list[0].tool, 'bash');
    assert.equal(list[0].agent, 'sess-1', '记账用的是 agent 的身份');
    assert.equal(list[0].displayReason, '删除 ~/下载/旧项目', '优先本地化文案');
    pending.catch(() => {});                       // 这个用例不关心它的结局
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});

test('★ 主人说"允许" → allowed-once（只此一次）', async () => {
  const t = await setup();
  try {
    const pending = t.ask();
    const [req] = await t.waitPending();
    assert.equal(await t.butlerCtx.approval.answer(req.id, 'allow'), true);
    assert.equal(await pending, 'allowed-once');

    const lines = t.audit();
    assert.equal(lines.length, 1, '一次审批一行账（两边不能各记一笔）');
    assert.equal(lines[0].outcome, 'allowed-once');
    assert.equal(lines[0].by, 'owner');
    assert.equal(readPending(t.dir).length, 0, '批过的事不该还挂着');
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});

test('主人说"不许" → rejected', async () => {
  const t = await setup();
  try {
    const pending = t.ask();
    const [req] = await t.waitPending();
    await t.butlerCtx.approval.answer(req.id, 'deny');
    assert.equal(await pending, 'rejected');
    assert.equal(t.audit()[0].outcome, 'rejected');
    assert.equal(t.audit()[0].by, 'owner');
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});

test('★ 没人答 → 到点 rejected（超时 = 不许），而且是记了账的不许', async () => {
  const t = await setup({ timeoutMs: 120, pollMs: 10 });
  try {
    const [req] = await (async () => {
      const p = t.ask();
      const list = await t.waitPending();
      assert.equal(await p, 'rejected', '没人答就是不许');
      return list;
    })();
    const lines = t.audit();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].id, req.id);
    assert.equal(lines[0].outcome, 'rejected');
    assert.equal(lines[0].by, 'timeout', '账上要能分清"主人说不许"和"没人吭声"');
    assert.equal(readPending(t.dir).length, 0, '结算完不该还挂着');
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});

test('agent 中途不要这个决定了 → cancelled（撤回，不是拒绝）', async () => {
  const t = await setup();
  try {
    const ac = new AbortController();
    const pending = t.ask({ ...REQ, signal: ac.signal });
    await t.waitPending();
    ac.abort();
    assert.equal(await pending, 'cancelled');
    assert.equal(t.audit()[0].outcome, 'cancelled');
    assert.equal(t.audit()[0].by, 'withdrawn');
    assert.equal(readPending(t.dir).length, 0);
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});

test('★ 问题都记不下来（盘不可写）→ unavailable，让 dsh 按拒绝处理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-ans-'));
  const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, 'x');                     // 拿一个**文件**当父目录，mkdir 必失败
  const ctx = new Context();
  try {
    await ctx.plugin(ImApprovalAnswerer, {
      dir: join(blocker, 'approvals'), home: root, timeoutMs: 200, pollMs: 10,
    });
    const outcome = await ctx.waterfall('approval/request', REQ, () => 'unavailable');
    assert.equal(outcome, 'unavailable', '问都没问成 —— 绝不能当允许');
  } finally {
    await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

test('不管是哪种情况，交回去的永远是那四个词之一（从不把问题往下推）', async () => {
  const t = await setup({ timeoutMs: 80, pollMs: 10 });
  try {
    const req = { ...REQ, toolName: 'write' };
    const outcome = await t.ask(req);
    assert.ok(
      ['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(outcome),
      `结局必须是 dsh 的封闭词表里的一个，实际是 ${JSON.stringify(outcome)}`,
    );
  } finally {
    await t.dshCtx.fiber.dispose(); await t.butlerCtx.fiber.dispose(); t.cleanup();
  }
});
