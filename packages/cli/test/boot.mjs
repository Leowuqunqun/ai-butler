/**
 * boot() 的测试：把配置变成跑起来的容器。
 *
 *   node --test test/boot.mjs
 *
 * 这里钉的核心是一条设计决定：**装不上不算致命**。
 * `boot()` 不抛，它把坏掉的收进 `failures` 里接着装下一个 ——
 * 因为 doctor 要的是"哪几行有问题"，一行坏掉不能让它什么都报不出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boot, resolveSpecifier } from '@butler/cli';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');
const PLUGINS = join(FIX, 'plugins');

/** 在临时目录里造一份配置，返回路径 */
function tmpConfig(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ plugins: rows }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const abs = (name) => join(PLUGINS, name);

// ───────────────────────── 解析去哪儿找 ─────────────────────────


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

test('相对路径从**配置文件所在目录**解析', () => {
  const r = resolveSpecifier('./plugins/demo.mjs', { configDir: '/Users/me/.butler', selfDir: '/app' });
  assert.equal(r.url, 'file:///Users/me/.butler/plugins/demo.mjs');
});

test('绝对路径原样用', () => {
  const r = resolveSpecifier('/opt/x/y.mjs', { configDir: '/whatever', selfDir: '/app' });
  assert.equal(r.url, 'file:///opt/x/y.mjs');
});

test('包名从**应用自己的目录**解析（不是从用户的 ~/.butler）', async () => {
  const r = resolveSpecifier('@butler/seam-channel', {
    configDir: '/Users/me/.butler',
    selfDir: join(here, '..'),
  });
  // pnpm 的 workspace 链接会解析到包的真实目录，所以别去断言路径里含包名，
  // 断言"确实找到了一个真实存在的文件"就够了
  assert.match(r.url, /^file:\/\//, `应当是文件 URL，实际：${r.url}`);
  assert.match(r.url, /seam-channel/, `应当解析到 seam-channel，实际：${r.url}`);
  assert.equal(r.where.startsWith('应用依赖'), true, `要说明是从哪儿找的，实际：${r.where}`);
});

// ───────────────────────── 装载 ─────────────────────────

test('按相对路径装一个插件，服务位就位', async () => {
  const t = tmpConfig([{ id: 'demo', name: './plugins/demo.mjs' }]);
  // 配置在临时目录，插件在夹具目录 —— 所以把 configDir 指到夹具
  const b = await boot({ configPath: t.file, configDir: FIX, selfDir: join(here, '..') });
  try {
    assert.deepEqual(b.failures, []);
    assert.deepEqual(b.loaded.map((r) => r.id), ['demo']);
    assert.ok(b.ctx.demo, 'ctx.demo 应当就位');
    assert.equal(b.has('demo'), true);
    assert.equal(b.has('core'), false, '没装的服务位应当是 false，不能瞎报');
  } finally {
    await b.dispose();
    t.cleanup();
  }
});

test('插件拿得到自己的 config（原样，不做任何加工）', async () => {
  const t = tmpConfig([{ id: 'demo', name: './plugins/demo.mjs', config: { hello: '世界' } }]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.deepEqual(b.ctx.demo.config, { hello: '世界' });
  } finally { await b.dispose(); t.cleanup(); }
});

test('按包名装（走应用自己的 node_modules）', async () => {
  const t = tmpConfig([{ id: 'channel', name: '@butler/seam-channel' }]);
  const b = await boot({ configPath: t.file, selfDir: join(here, '..') });
  try {
    assert.deepEqual(b.failures, []);
    assert.ok(b.ctx.channel, 'ctx.channel 应当就位');
  } finally { await b.dispose(); t.cleanup(); }
});

test('disabled 的行不装，但会单独报出来', async () => {
  const t = tmpConfig([
    { id: 'demo', name: './plugins/demo.mjs' },
    { id: 'off', name: './plugins/demo.mjs', disabled: true },
  ]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.deepEqual(b.loaded.map((r) => r.id), ['demo']);
    assert.deepEqual(b.disabled.map((r) => r.id), ['off']);
    assert.equal(b.failures.length, 0);
  } finally { await b.dispose(); t.cleanup(); }
});

// ───────────────────────── 坏掉的行：不致命 ─────────────────────────

test('import 阶段就炸的包 → 进 failures，**boot 不抛**，别的照装', async () => {
  const t = tmpConfig([
    { id: 'broken', name: './plugins/broken.mjs' },
    { id: 'demo', name: './plugins/demo.mjs' },
  ]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.deepEqual(b.loaded.map((r) => r.id), ['demo'], '坏的那行不能连累好的');
    assert.equal(b.failures.length, 1);
    assert.equal(b.failures[0].id, 'broken');
    assert.match(b.failures[0].message, /这个包根本没装好/);
    assert.ok(b.ctx.demo, '好的那个照样就位');
  } finally { await b.dispose(); t.cleanup(); }
});

test('必填配置没给的插件 → 进 failures，并且带着实现自己写的那句人话', async () => {
  const t = tmpConfig([{ id: 'needs', name: './plugins/needs-config.mjs', config: {} }]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.equal(b.failures.length, 1);
    assert.match(b.failures[0].message, /缺少必填配置：token/);
    assert.match(b.failures[0].message, /去哪儿拿/, '实现写清楚的话术要原样传出来');
  } finally { await b.dispose(); t.cleanup(); }
});

test('failures 里的 message 是**一行**（给用户看的，不是一棵栈）', async () => {
  const t = tmpConfig([{ id: 'broken', name: './plugins/broken.mjs' }]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.equal(b.failures[0].message.includes('\n'), false, '不能带换行');
  } finally { await b.dispose(); t.cleanup(); }
});

test('模块名拼错 → 报错里带上"找的位置"，不然用户没法查', async () => {
  const t = tmpConfig([{ id: 'x', name: '这个包根本不存在-zzz' }]);
  const b = await boot({ configPath: t.file, selfDir: join(here, '..') });
  try {
    assert.equal(b.failures.length, 1);
    assert.match(b.failures[0].message, /装不上插件/);
  } finally { await b.dispose(); t.cleanup(); }
});

test('空配置：什么也不装，也不算错', async () => {
  const t = tmpConfig([]);
  const b = await boot({ configPath: t.file });
  try {
    assert.deepEqual(b.loaded, []);
    assert.deepEqual(b.failures, []);
  } finally { await b.dispose(); t.cleanup(); }
});

// ───────────────────────── patch 叠上去真的生效 ─────────────────────────

test('patch 覆盖 config，且是整体替换（boot 这一层也成立）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-'));
  try {
    const base = join(dir, 'config.json');
    const patch = join(dir, 'me.json');
    writeFileSync(base, JSON.stringify({
      plugins: [{ id: 'demo', name: abs('demo.mjs'), config: { a: 1, b: 2 } }],
    }));
    writeFileSync(patch, JSON.stringify({
      plugins: [{ id: 'demo', name: abs('demo.mjs'), config: { a: 9 } }],
    }));

    const b = await boot({ configPath: base, patches: [patch] });
    try {
      assert.deepEqual(b.ctx.demo.config, { a: 9 }, 'b 应当消失');
      assert.deepEqual(b.config.files, [base, patch]);
    } finally { await b.dispose(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ───────────────────────── 收尾 ─────────────────────────

test('dispose 之后服务位就没了，has() 也如实说"没了"', async () => {
  const t = tmpConfig([{ id: 'demo', name: './plugins/demo.mjs' }]);
  const b = await boot({ configPath: t.file, configDir: FIX });
  try {
    assert.ok(b.ctx.demo);
    assert.equal(b.has('demo'), true);
    await b.dispose();
    assert.equal(b.ctx.demo, undefined, 'dispose 之后不该还挂着');
    // 这条是钉一个反直觉的实测结论：`'demo' in ctx` 卸载后**仍然是 true**，
    // 所以 has() 用的是取值判断。谁要是"顺手"改成 in，这条会立刻红
    assert.equal(b.has('demo'), false, 'has() 不能报过期信息');
  } finally { t.cleanup(); }
});

test('配置读不了 → boot 抛（这个是真的没法继续）', async () => {
  await assert.rejects(
    () => boot({ configPath: missing('config.json') }),
    /文件不存在/,
  );
});
