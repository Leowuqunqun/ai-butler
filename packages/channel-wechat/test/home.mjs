/**
 * 数据目录解析的测试。
 *
 * 这套优先级是有原因的（全局安装写坏 node_modules），所以必须钉住：
 * 以后谁改了顺序，这里会红。
 *
 *   node --test test/home.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { resolveHome, USER_HOME_DIR } from '../src/home.mjs';

/** 模拟一个源码检出 */
const DEV = join(sep, 'Users', 'leo', 'code', 'wechat-agent-bridge', 'packages', 'channel-wechat');
/** 模拟一个 npm 全局安装（路径里带 node_modules） */
const INSTALLED = join(sep, 'usr', 'local', 'lib', 'node_modules', 'wechat-agent-bridge');

const h = (argv = [], env = {}, pkgRoot = DEV) => resolveHome({ pkgRoot, argv, env });

test('源码检出：默认就用包目录（state/ 在仓库里，方便翻）', () => {
  assert.equal(h(), resolve(DEV));
});

test('安装态：路径里带 node_modules 就改用用户目录，绝不往包目录里写', () => {
  assert.equal(resolveHome({ pkgRoot: INSTALLED, argv: [], env: {} }), USER_HOME_DIR);
  assert.ok(!h([], {}, INSTALLED).includes('node_modules'), '结果里不能再出现 node_modules');
});

test('USER_HOME_DIR 是绝对路径，且落在用户主目录下', () => {
  assert.ok(isAbsolute(USER_HOME_DIR));
  assert.ok(
    USER_HOME_DIR.startsWith(homedir()),
    `${USER_HOME_DIR} 应当落在 ${homedir()} 下面`,
  );
});

// ── --home ──────────────────────────────────────────────────────

test('--home=<目录> 生效', () => {
  assert.equal(h(['status', `--home=${join(sep, 'tmp', 'wab')}`]), join(sep, 'tmp', 'wab'));
});

test('--home <目录> 生效（写在子命令后面也行）', () => {
  assert.equal(h(['run', '--home', join(sep, 'tmp', 'wab')]), join(sep, 'tmp', 'wab'));
  assert.equal(h(['--home', join(sep, 'tmp', 'wab'), 'run']), join(sep, 'tmp', 'wab'));
});

test('--home 优先级高于 WAB_HOME', () => {
  const home = join(sep, 'tmp', 'from-flag');
  const env = { WAB_HOME: join(sep, 'tmp', 'from-env') };
  assert.equal(h(['--home', home], env), home);
});

test('--home 后面没跟值 → 忽略，回落到下一优先级', () => {
  assert.equal(h(['--home'], { WAB_HOME: join(sep, 'tmp', 'env') }), join(sep, 'tmp', 'env'));
  assert.equal(h(['run', '--home']), resolve(DEV));
});

test('--home 后面跟的是另一个 flag → 不能把它当目录', () => {
  assert.equal(h(['--home', '--port', '8080']), resolve(DEV));
});

// ── WAB_HOME ────────────────────────────────────────────────────

test('WAB_HOME 生效，且优先于默认值', () => {
  assert.equal(h([], { WAB_HOME: join(sep, 'srv', 'wab') }), join(sep, 'srv', 'wab'));
  assert.equal(resolveHome({ pkgRoot: INSTALLED, argv: [], env: { WAB_HOME: join(sep, 'srv', 'wab') } }), join(sep, 'srv', 'wab'));
});

test('WAB_HOME 为空字符串视作没设（不返回空路径）', () => {
  assert.equal(h([], { WAB_HOME: '' }), resolve(DEV));
});

// ── 通用性质 ────────────────────────────────────────────────────

test('永远返回绝对路径（相对路径会被解析）', () => {
  assert.equal(h(['--home', 'relative/dir']), resolve('relative/dir'));
  assert.equal(h([], { WAB_HOME: 'relative/env' }), resolve('relative/env'));
  for (const out of [h(), h([], {}, INSTALLED), h(['--home', 'x']), h([], { WAB_HOME: 'y' })]) {
    assert.ok(isAbsolute(out), `${out} 应当是绝对路径`);
  }
});

test('不传 pkgRoot 会明确报错，而不是静默把数据写到别处', () => {
  assert.throws(() => resolveHome(), /pkgRoot/);
  assert.throws(() => resolveHome({}), /pkgRoot/);
});
