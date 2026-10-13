/**
 * 落盘的去重表。规矩是"宁可漏，不可重" —— 但飞书没有游标，
 * 所以"读不出来"这件事只能如实降级（见 seen.ts 文件头）。
 *
 * @module @butler/channel-feishu/test/seen
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SeenStore } from '../lib/seen.js';

/** 一个空的 home（`state/` 建好：测试要往里面塞坏文件，SeenStore 自己只会在"写"的时候建目录） */
const file = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'butler-seen-')), 'state', 'feishu-seen.json');
  mkdirSync(dirname(f), { recursive: true });
  return f;
};

test('记过的就是记过的；没记过的就是没记过', () => {
  const store = new SeenStore(file());
  assert.equal(store.has('om_1'), false);
  store.add('om_1');
  assert.equal(store.has('om_1'), true);
  store.add('om_1'); // 重复 add 不该撑大表
  assert.equal(store.has('om_2'), false);
});

test('换一个实例还记得（这是它存在的全部理由：进程重启后重推照样要被拦住）', () => {
  const f = file();
  new SeenStore(f).add('om_restart');
  assert.equal(new SeenStore(f).has('om_restart'), true);
});

test('表满之后丢最旧的，不是丢最新的', () => {
  const f = file();
  const store = new SeenStore(f, 3);
  for (const id of ['a', 'b', 'c', 'd']) store.add(id);

  const reread = new SeenStore(f, 3);
  assert.equal(reread.has('a'), false, '最旧的该被丢掉');
  assert.equal(reread.has('d'), true, '刚记下的必须还在');
});

test('文件坏了 / 形状不对 → 当空表，且不抛错', () => {
  const f = file();
  writeFileSync(f, '{ 这不是 json');
  assert.equal(new SeenStore(f).has('whatever'), false);

  const f2 = file();
  writeFileSync(f2, JSON.stringify({ version: 1, ids: 'not-an-array' }));
  assert.equal(new SeenStore(f2).has('whatever'), false);

  const f3 = file();
  writeFileSync(f3, JSON.stringify({ version: 1, ids: [1, 'ok', null] }));
  const store = new SeenStore(f3);
  assert.equal(store.has('ok'), true);
});

test('落盘的文件是 0600（这张表里有用户的 messageId，不是公开信息）', () => {
  const f = file();
  new SeenStore(f).add('om_secret');
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).ids, ['om_secret']);
});
