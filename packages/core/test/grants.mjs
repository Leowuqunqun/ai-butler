/**
 * 长期授权那份记录 —— 「以后这类不用问了」的**底账**。
 *
 * 这里钉的核心是一条安全方向：**读不动就一条都不算数**（退回"每次都问"）。
 * 宁可多问一句，不能少问一句 —— 拿一份读不明白的授权去替主人放行，
 * 是这类功能最危险的坏法。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addGrant, grantsFileOf, humanLeft, kindOf, liveGrants, parseGrantWindow, readGrants, readGrantsOr, removeGrant,
} from '../lib/grants.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'butler-grants-'));

test('授权文件跟状态文件放同一个目录', () => {
  assert.equal(grantsFileOf('/home/leo/.butler/state/butler.json', '/home/leo'), '/home/leo/.butler/state/grants.json');
  assert.equal(grantsFileOf('', '/home/leo'), '/home/leo/state/grants.json');
});

test('一类就是 agent:tool —— 账上要能一眼看出"哪一类"', () => {
  assert.equal(kindOf({ agent: 'dsh', tool: 'bash' }), 'dsh:bash');
  assert.equal(kindOf({ agent: '', tool: '' }), '?:?');
});

test('加一条、读回来，而且文件是 0600（它决定哪些事不问主人）', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'grants.json');
    addGrant(file, 'dsh:bash', new Date('2026-10-12T08:00:00Z'));
    const grants = readGrants(file);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].kind, 'dsh:bash');
    assert.equal(grants[0].at, '2026-10-12T08:00:00.000Z');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同一类再加一次不会变成两条（而是更新时间）', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'grants.json');
    addGrant(file, 'dsh:bash', new Date('2026-10-12T08:00:00Z'));
    const after = addGrant(file, 'dsh:bash', new Date('2026-10-12T09:00:00Z'));
    assert.equal(after.length, 1, '重复授权不该出现两条 —— 否则「取消授权 1」只收掉一半');
    assert.equal(after[0].at, '2026-10-12T09:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('收回第 N 条；编号越界就一条都不动', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'grants.json');
    addGrant(file, 'dsh:bash');
    addGrant(file, 'dsh:read');
    const before = readFileSync(file, 'utf8');

    const miss = removeGrant(file, 9);
    assert.equal(miss.removed, null);
    assert.equal(readFileSync(file, 'utf8'), before, '越界的编号不许动文件');

    const hit = removeGrant(file, 1);
    assert.equal(hit.removed.kind, 'dsh:bash');
    assert.deepEqual(hit.grants.map((g) => g.kind), ['dsh:read']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 读不动就一条都不算数（退回"每次都问"），而且要说得出为什么', () => {
  const dir = tempDir();
  try {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ 这不是 JSON');
    assert.deepEqual(readGrants(broken), []);
    assert.match(readGrantsOr(broken).broken, /读不出来/);

    const wrongShape = join(dir, 'shape.json');
    writeFileSync(wrongShape, JSON.stringify({ 我自己加的: true }));
    assert.deepEqual(readGrants(wrongShape), []);
    assert.match(readGrantsOr(wrongShape).broken, /形状不对/);

    // 没有这份文件不是错：那就是"没给过授权"
    assert.deepEqual(readGrants(join(dir, 'nope.json')), []);
    assert.equal(readGrantsOr(join(dir, 'nope.json')).broken, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────── ★ 限时授权：到点自动回到"每次都问" ───────────
//
// 为什么收窄的维度是**时间**、而不是"只允许某条命令"：按命令前缀授权是个陷阱 ——
// 「以后 `ls` 不用问」挡不住 `ls; rm -rf ~`，它给的是假的安全感。时间收窄没有这个问题：
// 主人在自己划定的那一段里认下风险，过点就自动作废，不用他记着来收。

test('期限读得懂的：半小时 / 30 分钟 / 一小时 / 两小时 / 一天 / 3 天', () => {
  const now = Date.parse('2025-10-12T10:00:00.000Z');
  const cases = [
    ['半小时', 30 * 60_000], ['30 分钟', 30 * 60_000], ['一小时', 60 * 60_000],
    ['两小时', 2 * 60 * 60_000], ['一天', 24 * 60 * 60_000], ['3 天', 3 * 24 * 60 * 60_000],
  ];
  for (const [text, ms] of cases) {
    const r = parseGrantWindow(text, now);
    assert.equal(r.ok, true, text);
    assert.equal(Date.parse(r.until), now + ms, text);
  }
});

test('★ 期限读不懂就说读不懂 —— 绝不"没看懂那就当永远"', () => {
  const now = Date.now();
  for (const bad of ['一小时候', '谢谢', '一会儿', '', '8 天', '0 分钟']) {
    const r = parseGrantWindow(bad, now);
    assert.equal(r.ok, false, `「${bad}」不该被认成期限`);
    assert.ok(r.why.length > 0);
  }
  assert.match(parseGrantWindow('8 天', now).why, /太长/);
});

test('★ 过点的授权不算数 —— 退回"每次都问"', () => {
  const now = Date.parse('2025-10-12T10:00:00.000Z');
  const grants = [
    { kind: 'dsh:bash', at: '2025-10-01T00:00:00.000Z' },
    { kind: 'dsh:write', at: '2025-10-01T00:00:00.000Z', until: '2025-10-12T11:00:00.000Z' },
    { kind: 'exec:run', at: '2025-10-01T00:00:00.000Z', until: '2025-10-12T09:00:00.000Z' },
  ];
  assert.deepEqual(liveGrants(grants, now).map((g) => g.kind), ['dsh:bash', 'dsh:write']);
});

test('★ 老记录（没写期限）照旧算数 = 永远 —— 不能因为这次改动把老授权弄丢', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'grants.json');
    writeFileSync(file, JSON.stringify({ grants: [{ kind: 'dsh:bash', at: '2025-01-01T00:00:00.000Z' }] }));
    const g = readGrants(file);
    assert.equal(g.length, 1);
    assert.equal(g[0].until, undefined);
    assert.equal(liveGrants(g, Date.now()).length, 1, '没期限的永远算数');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('写进去的期限读得回来；再给一次（不带期限）会把期限抹掉，而且只有一条', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'grants.json');
    const until = '2025-10-12T11:00:00.000Z';
    addGrant(file, 'dsh:bash', new Date('2025-10-12T10:00:00.000Z'), until);
    assert.equal(readGrants(file)[0].until, until);
    addGrant(file, 'dsh:bash', new Date('2025-10-12T10:30:00.000Z'));
    assert.equal(readGrants(file)[0].until, undefined);
    assert.equal(readGrants(file).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('"还剩多久"是人话，而且是纯函数（不碰时区，测试才钉得住）', () => {
  const now = Date.parse('2025-10-12T10:00:00.000Z');
  assert.equal(humanLeft('2025-10-12T09:59:00.000Z', now), '已过期');
  assert.equal(humanLeft('2025-10-12T10:00:30.000Z', now), '不到 1 分钟');
  assert.equal(humanLeft('2025-10-12T10:25:00.000Z', now), '约 25 分钟');
  assert.equal(humanLeft('2025-10-12T13:00:00.000Z', now), '约 3 小时');
  assert.equal(humanLeft('2025-10-14T10:00:00.000Z', now), '约 2 天');
});
