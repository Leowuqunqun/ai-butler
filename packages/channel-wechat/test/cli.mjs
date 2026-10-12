/**
 * CLI 端到端测试（真的起子进程，不是调函数）。
 *
 * 为什么值得跑子进程：`--home` / `WAB_HOME` 的解析结果对不对是一回事，
 * **子命令派发有没有被全局 flag 带偏**是另一回事。
 * 曾经就真的踩过：`wab --home /x status` 因为 `argv[0]` 成了 `--home`，
 * 直接掉进 help，什么都不干还返回 0。
 *
 *   node --test test/cli.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(PKG_ROOT, 'src', 'cli.mjs');

/** 起一次 CLI，返回 stdout（stderr 合并，方便断言报错） */
function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const tmp = () => mkdtempSync(join(tmpdir(), 'wab-cli-'));

test('status 会报出实际用的数据目录，并把它建出来', () => {
  const dir = tmp();
  try {
    const out = run(['status', '--home', dir]);
    assert.match(out, /state 目录/);
    assert.ok(out.includes(dir), `输出里应当出现 ${dir}`);
    assert.ok(existsSync(join(dir, 'state')), 'state/ 应当被建出来');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回归：--home 写在子命令**前面**也要正常派发（不能掉进 help）', () => {
  const dir = tmp();
  try {
    const before = run(['--home', dir, 'status']);
    const after = run(['status', '--home', dir]);
    assert.match(before, /state 目录/, '前置 --home 时仍应执行 status');
    assert.ok(!before.includes('用法'), '不该打出 help');
    // 两种写法必须等价
    assert.equal(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--home=<目录> 等价写法', () => {
  const dir = tmp();
  try {
    assert.match(run([`--home=${dir}`, 'status']), /state 目录/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WAB_HOME 生效', () => {
  const dir = tmp();
  try {
    const out = run(['status'], { WAB_HOME: dir });
    assert.ok(out.includes(dir), `输出里应当出现 ${dir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--home 压过 WAB_HOME', () => {
  const a = tmp();
  const b = tmp();
  try {
    const out = run(['status', '--home', a], { WAB_HOME: b });
    assert.ok(out.includes(a), '该用 --home 指定的目录');
    assert.ok(!out.includes(b), '不该用 WAB_HOME 的目录');
    assert.ok(!existsSync(join(b, 'state')), 'WAB_HOME 目录不该被动过');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('源码检出下默认用包目录（不是 ~/.wechat-agent-bridge）', () => {
  const out = run(['status']);
  assert.ok(out.includes(PKG_ROOT), `默认应当用 ${PKG_ROOT}`);
  assert.ok(!out.includes('.wechat-agent-bridge'), '源码检出下不该跑到用户目录');
});

test('其它子命令不受 --home 影响', () => {
  const dir = tmp();
  try {
    const out = run(['--home', dir, 'backends']);
    assert.match(out, /内置 agent 后端/);
    assert.match(out, /echo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('help 里说明了数据目录怎么改', () => {
  const out = run(['help']);
  assert.match(out, /--home/);
  assert.match(out, /WAB_HOME/);
});

test('未知子命令 → 打 help，不崩', () => {
  const out = run(['nonsense']);
  assert.match(out, /wechat-agent-bridge/);
});
