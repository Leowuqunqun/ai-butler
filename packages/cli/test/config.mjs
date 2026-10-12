/**
 * 配置与 patch 叠加的测试。纯逻辑，全部离线。
 *
 *   node --test test/config.mjs
 *
 * 这里钉的是 dsh 那几条**反直觉**的语义 —— 尤其是"config 是整体替换，不是深合并"。
 * 那条如果不写测试，将来一定会有人"顺手"改成深合并，然后所有人的默认值集体消失。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, mergeRows, loadConfig, readConfigFile, ConfigError } from '@butler/cli';

const row = (id, config = {}, name = `pkg-${id}`) => ({ id, name, config });

// ───────────────────────── 读取与形状校验 ─────────────────────────


/**
 * 一个**保证不存在**的路径：在一个新建的临时目录里取一个没建过的名字。
 *
 * ⚠️ 别硬编码 `/tmp/绝对不会存在` 这种哨兵路径 —— `/tmp` 是共享的，
 * 早先的测试跑过、或者别的工具建过，它就真存在了，然后这条断言开始
 * 无缘无故地红。这是实测踩过的（`/tmp/绝对没有这个目录-zzz` 真的在）。
 */
function missing(name) {
  return join(mkdtempSync(join(tmpdir(), 'gone-')), name);
}

test('读一个正常配置', () => {
  const c = parseConfig('{"plugins":[{"id":"a","name":"pkg-a"}]}', 'x.json');
  assert.deepEqual(c.plugins, [{ id: 'a', name: 'pkg-a' }]);
});

test('没有 plugins 字段 = 空，不算错', () => {
  assert.deepEqual(parseConfig('{}', 'x.json').plugins, []);
});

test('坏 JSON 的报错带上文件路径 —— 小白看不懂"第 3 行"', () => {
  assert.throws(
    () => parseConfig('{ 不是 json }', '/Users/me/.butler/config.json'),
    (e) => e instanceof ConfigError && e.message.includes('/Users/me/.butler/config.json') && /不是合法的 JSON/.test(e.message),
  );
});

test('形状不对的几种都给得出人话', () => {
  const cases = [
    ['[]', /最外层应当是一个对象/],
    ['{"plugins":{}}', /"plugins" 应当是数组/],
    ['{"plugins":[1]}', /plugins\[0\] 应当是一个对象/],
    ['{"plugins":[{"name":"x"}]}', /缺少 id/],
    ['{"plugins":[{"id":"a"}]}', /缺少 name/],
    ['{"plugins":[{"id":"a","name":"x","config":"nope"}]}', /config 应当是一个对象/],
    ['{"plugins":[{"id":"a","name":"x","disabled":"yes"}]}', /disabled 只能是 true\/false/],
  ];
  for (const [text, re] of cases) {
    assert.throws(() => parseConfig(text, 'x.json'), re, `这段应当报错：${text}`);
  }
});

test('文件不存在时明说"文件不存在"，不是把 ENOENT 糊给用户', () => {
  assert.throws(() => readConfigFile(missing('config.json')), /文件不存在/);
});

// ───────────────────────── 叠加语义 ─────────────────────────

test('id 不存在 → 追加（相当于 dsh 的 insert）', () => {
  const out = mergeRows([row('a')], [row('b')]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
});

test('id 存在 → 覆盖', () => {
  const out = mergeRows([row('a', { x: 1 })], [{ id: 'a', name: 'pkg-a', config: { x: 2 } }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].config, { x: 2 });
});

test('**config 是整体替换，不是深合并**（漏了默认值就等于没写）', () => {
  const base = [row('agent', { bin: 'dsh', timeoutMs: 300_000, profile: 'headless' })];
  const out = mergeRows(base, [{ id: 'agent', name: 'pkg-agent', config: { bin: '/opt/dsh' } }]);
  assert.deepEqual(out[0].config, { bin: '/opt/dsh' }, 'timeoutMs/profile 应当**消失**，不是被保留');
});

test('只写了的字段才被覆盖，没写的沿用 base（name / disabled）', () => {
  const base = [{ id: 'a', name: 'pkg-a', config: { x: 1 }, disabled: false }];
  const out = mergeRows(base, [{ id: 'a', name: 'pkg-a', config: { x: 2 } }]);
  assert.equal(out[0].disabled, false, 'patch 没提 disabled，就该沿用');
});

test('disabled 可以被 patch 打开或关掉', () => {
  const base = [{ id: 'a', name: 'pkg-a', disabled: true }];
  assert.equal(mergeRows(base, [{ id: 'a', name: 'pkg-a', disabled: false }])[0].disabled, false);
});

test('同一个文件里同一个 id 写两次 → 后写的赢', () => {
  const out = mergeRows([], [row('a', { x: 1 }), row('a', { x: 2 })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].config, { x: 2 });
});

test('行的顺序不承载语义：三条 patch 谁先谁后，结果只取决于最后的写入', () => {
  const base = [row('a', { v: 'base' })];
  const first = mergeRows(mergeRows(base, [row('a', { v: 'p1' })]), [row('a', { v: 'p2' })]);
  assert.deepEqual(first[0].config, { v: 'p2' });
});

test('不改动传进来的数组（patch 不该有副作用）', () => {
  const base = [row('a', { x: 1 })];
  const baseCopy = JSON.parse(JSON.stringify(base));
  mergeRows(base, [row('a', { x: 2 })]);
  assert.deepEqual(base, baseCopy);
});

test('空 base + 空 patch = 空', () => {
  assert.deepEqual(mergeRows([], []), []);
});

// ───────────────────────── 多文件叠加 ─────────────────────────

test('loadConfig：base + 多个 patch，后写的赢', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const base = join(dir, 'config.json');
    const p1 = join(dir, 'team.json');
    const p2 = join(dir, 'me.json');
    writeFileSync(base, JSON.stringify({
      plugins: [
        { id: 'agent', name: 'pkg-agent', config: { bin: 'dsh', timeoutMs: 300000 } },
        { id: 'core', name: 'pkg-core', config: { workspace: '/a' } },
      ],
    }));
    writeFileSync(p1, JSON.stringify({ plugins: [{ id: 'agent', name: 'pkg-agent', config: { bin: 'team-dsh' } }] }));
    writeFileSync(p2, JSON.stringify({ plugins: [{ id: 'agent', name: 'pkg-agent', config: { bin: 'my-dsh' } }] }));

    const loaded = loadConfig(base, [p1, p2]);
    assert.deepEqual(loaded.files, [base, p1, p2], 'files 要按叠加顺序记下来，doctor 要靠它告诉用户看的是哪儿');
    const agent = loaded.rows.find((r) => r.id === 'agent');
    assert.deepEqual(agent.config, { bin: 'my-dsh' }, '最后一份 patch 赢，且是整体替换');
    assert.equal(loaded.rows.find((r) => r.id === 'core').config.workspace, '/a', '没被碰的行原样保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig：disabled 的行不进 rows，但会被单独记下来给用户看', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const base = join(dir, 'config.json');
    writeFileSync(base, JSON.stringify({
      plugins: [
        { id: 'on', name: 'pkg-on' },
        { id: 'off', name: 'pkg-off', disabled: true },
      ],
    }));
    const loaded = loadConfig(base);
    assert.deepEqual(loaded.rows.map((r) => r.id), ['on']);
    assert.deepEqual(loaded.disabled.map((r) => r.id), ['off'], '关掉的行要能报出来，不然用户会以为配置丢了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadConfig：patch 把某行关掉，那一行就不装', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  try {
    const base = join(dir, 'config.json');
    const patch = join(dir, 'off.json');
    writeFileSync(base, JSON.stringify({ plugins: [{ id: 'a', name: 'pkg-a' }] }));
    writeFileSync(patch, JSON.stringify({ plugins: [{ id: 'a', name: 'pkg-a', disabled: true }] }));
    assert.deepEqual(loadConfig(base, [patch]).rows, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('patch 文件不存在 → 报错里点名是哪个文件（别让用户猜）', () => {
  assert.throws(
    () => loadConfig('/tmp/没有这个-base.json'),
    /没有这个-base\.json/,
  );
});
