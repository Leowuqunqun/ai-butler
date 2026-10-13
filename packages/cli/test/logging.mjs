/**
 * 插件自己的日志往哪儿去（第 46 轮）。
 *
 *   node --test test/logging.mjs
 *
 * 这个文件存在的理由：**一个从来没被打印过的日志，和一个不存在的日志，看起来一模一样**。
 * Cordis 的 `Context` 自带一个 exporter，但它只 `buffer.push(message)`（上限 1000，环形），
 * 没有读者。于是 `feishu: 上线了（机器人身份：…）` 这种"用户该看见"的行，终端里没有、
 * 自启动的 `logs/autostart.log`（只收 stdout）里也没有 —— 而**谁都没报错**。
 * 所以下面既钉"级别怎么算"，也钉"挂上之后真的会打、摘掉之后真的会停"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Context } from '@deepseek-ai/cordis';

import { boot, installConsoleLog, logLevelOf, DEFAULT_LOG_LEVEL } from '../lib/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function tmpConfig(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'log-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ plugins: rows }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 把 console 的两个出口换掉，收集每一行；`restore()` 必须放 finally 里 */
function capture() {
  const out = { stdout: [], stderr: [] };
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => out.stdout.push(a.join(' '));
  console.error = (...a) => out.stderr.push(a.join(' '));
  return { out, restore: () => { console.log = orig.log; console.error = orig.error; } };
}

test('★ 级别表：默认 warn；名字认识就按名字；不认识要出声', () => {
  assert.deepEqual(logLevelOf({}), { name: 'warn', level: 2 });
  assert.equal(DEFAULT_LOG_LEVEL, 'warn');

  assert.deepEqual(logLevelOf({ BUTLER_LOG_LEVEL: 'debug' }), { name: 'debug', level: 3 });
  assert.deepEqual(logLevelOf({ BUTLER_LOG_LEVEL: '  ERROR  ' }), { name: 'error', level: 0 });
  // ⚠️ Cordis 的排法是 error=0、info=1、warn=2、debug=3 —— `info` 排在 `warn` **前面**，
  //    所以 info 档**看不到 warn**。反直觉，但这是它自己的数，别照直觉改。
  assert.deepEqual(logLevelOf({ BUTLER_LOG_LEVEL: 'info' }), { name: 'info', level: 1 });
  assert.deepEqual(logLevelOf({ BUTLER_LOG_LEVEL: 'warn' }), { name: 'warn', level: 2 });

  const bad = logLevelOf({ BUTLER_LOG_LEVEL: 'deubg' });
  assert.equal(bad.name, 'warn', '不认识的值按默认来');
  assert.match(bad.warning, /deubg/, '要说清楚是哪个值不认识');
  assert.match(bad.warning, /error \/ info \/ warn \/ debug/, '并给出可选的那几个');
});

test('★★ 挂上之后：info 走 stdout、warn/error 走 stderr，低于级别的一条都不打', () => {
  const ctx = new Context();
  const c = capture();
  try {
    const off = installConsoleLog(ctx, { BUTLER_LOG_LEVEL: 'warn' });
    ctx.logger.info('一条 info');
    ctx.logger.warn('一条 warn');
    ctx.logger.error('一条 error');
    ctx.logger.debug('一条 debug');
    off();
  } finally {
    c.restore();
  }
  assert.deepEqual(c.out.stdout, ['一条 info']);
  assert.deepEqual(c.out.stderr, ['一条 warn', '一条 error']);
  assert.equal(
    JSON.stringify(c.out).includes('debug'),
    false,
    '默认档不该把 debug 打出来（官方 SDK 的 info 就降在这一档）',
  );
});

test('★★ debug 档会把最低那一级也放出来', () => {
  const ctx = new Context();
  const c = capture();
  try {
    const off = installConsoleLog(ctx, { BUTLER_LOG_LEVEL: 'debug' });
    ctx.logger.debug('最低一级');
    off();
  } finally {
    c.restore();
  }
  assert.deepEqual(c.out.stdout, ['最低一级']);
});

test('★★ 摘掉之后就不再打了（返回的那个 disposer 真管用）', () => {
  const ctx = new Context();
  const c = capture();
  try {
    const off = installConsoleLog(ctx, { BUTLER_LOG_LEVEL: 'debug' });
    ctx.logger.info('摘之前');
    off();
    ctx.logger.info('摘之后');
  } finally {
    c.restore();
  }
  assert.deepEqual(c.out.stdout, ['摘之前']);
});

test('★★ boot() 里已经挂好了：插件装完之后，ctx.logger.info 能到终端上', async () => {
  const t = tmpConfig([{ id: 'channel', name: './plugins/check-channel.mjs' }]);
  const c = capture();
  let b;
  try {
    b = await boot({ configPath: t.file, configDir: FIX, logLevel: 'warn' });
    b.ctx.logger.info('插件说话了');
  } finally {
    c.restore();
    await b?.dispose();
    t.cleanup();
  }
  assert.ok(
    c.out.stdout.includes('插件说话了'),
    `boot 之后插件日志要能到 stdout；实际收到：${JSON.stringify(c.out.stdout)}`,
  );
});
