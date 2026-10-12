/**
 * `butler autostart on|off|status` —— 单元文件的内容、路径、命令，全部离线验。
 *
 *   node --test test/autostart.mjs
 *
 * 最重要的一条纪律：**测试不许碰真的 launchctl/systemctl，也不许碰真家目录**。
 * 所以每个用例都传临时 `home` + 注入的 `run`（假装是系统命令），
 * 一个字节都不出临时目录。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autostartPlan, autostartOn, autostartOff, autostartStatus, formatPlan } from '@butler/cli';

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'butler-autostart-'));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** 假装是系统命令：记下来，按剧本返回成功/失败 */
function fakeRunner(script = {}) {
  const calls = [];
  const run = (cmd) => {
    calls.push([...cmd]);
    const key = cmd.join(' ');
    const force = script[key];
    return { ok: force === undefined ? true : force, out: force ? '（系统说的）' : '' };
  };
  return { calls, run };
}

const BASE = {
  platform: 'darwin',
  nodePath: '/opt/node/bin/node',
  cliPath: '/opt/butler/lib/cli.js',
  configPath: '/Users/x/.butler/config.json',
  uid: 501,
  env: { PATH: '/opt/node/bin:/usr/bin:/bin' },
};

// ───────────────────────── 单元文件长什么样 ─────────────────────────

test('macOS：plist 里 node、入口、配置、--no-open、PATH、日志，一个都不能少', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, home: s.home });
    assert.ok(plan, 'darwin 必须有计划');
    assert.match(plan.kind, /launchd/);
    assert.equal(plan.file, join(s.home, 'Library', 'LaunchAgents', 'com.butler.hub.plist'));

    for (const want of [
      '<string>/opt/node/bin/node</string>',
      '<string>/opt/butler/lib/cli.js</string>',
      '<string>run</string>',
      '<string>--config</string>',
      '<string>/Users/x/.butler/config.json</string>',
      '<string>--no-open</string>',
      '<key>RunAtLoad</key>',
      '<key>KeepAlive</key>',
      '<key>PATH</key>',
      '<string>/opt/node/bin:/usr/bin:/bin</string>',
      join(s.home, '.butler', 'logs', 'autostart.log'),
    ]) {
      assert.ok(plan.content.includes(want), `plist 里少了：${want}`);
    }
    assert.deepEqual(plan.load[0], ['launchctl', 'bootstrap', 'gui/501', plan.file]);
    assert.deepEqual(plan.load[1], ['launchctl', 'load', '-w', plan.file], '新写法不成要能回退');
  } finally { s.cleanup(); }
});

test('★ PATH 必须写进单元文件 —— 登录时系统给的那份里没有 dsh', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, home: s.home, env: { PATH: '/Users/x/.nvm/bin:/usr/bin' } });
    assert.match(plan.content, /<string>\/Users\/x\/\.nvm\/bin:\/usr\/bin<\/string>/);
  } finally { s.cleanup(); }
});

test('★ 路径里有 & 或 < 也要转义（plist 是 XML，不转会直接解析失败）', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, home: s.home, cliPath: '/opt/a&b/<c>/cli.js' });
    assert.ok(plan.content.includes('/opt/a&amp;b/&lt;c&gt;/cli.js'), '要转义');
    assert.ok(!plan.content.includes('/opt/a&b/<c>/cli.js'), '不能留原文');
  } finally { s.cleanup(); }
});

test('Linux：systemd 用户级 unit，ExecStart 带引号、Restart 有、WantedBy 有', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, platform: 'linux', home: s.home });
    assert.equal(plan.file, join(s.home, '.config', 'systemd', 'user', 'butler.service'));
    assert.match(plan.content, /\[Service\]/);
    assert.match(plan.content, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/butler\/lib\/cli\.js" "run"/);
    assert.match(plan.content, /Environment=PATH=\/opt\/node\/bin:\/usr\/bin:\/bin/);
    assert.match(plan.content, /Restart=always/);
    assert.match(plan.content, /WantedBy=default\.target/);
    assert.deepEqual(plan.load[0], ['systemctl', '--user', 'daemon-reload']);
    assert.deepEqual(plan.load[1], ['systemctl', '--user', 'enable', '--now', 'butler.service']);
  } finally { s.cleanup(); }
});

test('Windows：还没有 —— 返回 null（宁可说没做，也不写一个跑不起来的注册表项）', () => {
  assert.equal(autostartPlan({ ...BASE, platform: 'win32' }), null);
});

// ───────────────────────── on / off / status ─────────────────────────

test('on：写好单元文件、跑装上命令、返回 0', () => {
  const s = sandbox();
  try {
    const { calls, run } = fakeRunner();
    const lines = [];
    const code = autostartOn({ ...BASE, home: s.home, run, log: (l) => lines.push(l) });
    assert.equal(code, 0);
    const plan = autostartPlan({ ...BASE, home: s.home });
    assert.ok(existsSync(plan.file), '单元文件要真的写出来');
    assert.equal(readFileSync(plan.file, 'utf8'), plan.content);
    assert.deepEqual(calls, [['launchctl', 'bootstrap', 'gui/501', plan.file]]);
    assert.match(lines.join('\n'), /自启动已生效/);
  } finally { s.cleanup(); }
});

test('on：系统不认新写法时回退到老的 load -w（两条都试过才算失败）', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, home: s.home });
    const { calls, run } = fakeRunner({ [['launchctl', 'bootstrap', 'gui/501', plan.file].join(' ')]: false });
    const code = autostartOn({ ...BASE, home: s.home, run, log: () => {} });
    assert.equal(code, 0);
    assert.equal(calls.length, 2, '第一条失败要接着试第二条');
    assert.deepEqual(calls[1], ['launchctl', 'load', '-w', plan.file]);
  } finally { s.cleanup(); }
});

test('on：全都失败要说实话 —— 文件留下了，但要告诉人怎么补救', () => {
  const s = sandbox();
  try {
    const run = () => ({ ok: false, out: 'Operation not permitted' });
    const lines = [];
    const code = autostartOn({ ...BASE, home: s.home, run, log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.ok(existsSync(autostartPlan({ ...BASE, home: s.home }).file), '文件还是留着的');
    assert.match(lines.join('\n'), /没能\*\*当场\*\*装上去/);
    assert.match(lines.join('\n'), /Operation not permitted/, '系统的原话要转述给人看');
  } finally { s.cleanup(); }
});

test('off：摘掉命令 + 删掉单元文件；本来没装就明说没装', () => {
  const s = sandbox();
  try {
    const plan = autostartPlan({ ...BASE, home: s.home });
    const { calls, run } = fakeRunner();
    const first = [];
    assert.equal(autostartOff({ ...BASE, home: s.home, run, log: (l) => first.push(l) }), 0);
    assert.equal(calls.length, 0, '本来没装就一条命令都不该跑');
    assert.match(first.join('\n'), /本来就没装/);

    mkdirSync(join(s.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plan.file, plan.content);
    assert.equal(autostartOff({ ...BASE, home: s.home, run, log: () => {} }), 0);
    assert.ok(!existsSync(plan.file), '文件要删掉');
    assert.deepEqual(calls[0], ['launchctl', 'bootout', `gui/501/com.butler.hub`]);
  } finally { s.cleanup(); }
});

test('status：没装 / 在跑 / 没在跑，三种都要说得清清楚楚', () => {
  const s = sandbox();
  try {
    const lines = [];
    assert.equal(autostartStatus({ ...BASE, home: s.home, run: fakeRunner().run, log: (l) => lines.push(l) }), 0);
    assert.match(lines.join('\n'), /没装/);

    const plan = autostartPlan({ ...BASE, home: s.home });
    mkdirSync(join(s.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(plan.file, plan.content);

    const ok = [];
    autostartStatus({ ...BASE, home: s.home, run: fakeRunner().run, log: (l) => ok.push(l) });
    assert.match(ok.join('\n'), /服务状态：在跑/);

    const bad = [];
    autostartStatus({ ...BASE, home: s.home, run: () => ({ ok: false, out: 'not loaded' }), log: (l) => bad.push(l) });
    assert.match(bad.join('\n'), /服务状态：没在跑/);
    assert.match(bad.join('\n'), /not loaded/, '为什么没在跑要带上，别让人猜');
  } finally { s.cleanup(); }
});

test('Windows：on/off/status 都说"还没做"，而且一个文件都不写', () => {
  const s = sandbox();
  try {
    for (const fn of [autostartOn, autostartOff, autostartStatus]) {
      const lines = [];
      const code = fn({ ...BASE, platform: 'win32', home: s.home, run: fakeRunner().run, log: (l) => lines.push(l) });
      assert.equal(code, 2);
      assert.match(lines.join('\n'), /还没做/);
    }
    assert.deepEqual(readdirSync(s.home), [], '临时家目录必须是空的');
  } finally { s.cleanup(); }
});

test('formatPlan：--dry-run 念给人听的内容里有文件路径和命令', () => {
  const s = sandbox();
  try {
    const text = formatPlan(autostartPlan({ ...BASE, home: s.home }));
    assert.match(text, /com\.butler\.hub\.plist/);
    assert.match(text, /launchctl bootstrap/);
    assert.match(text, /--no-open/, '念出来的命令里也要有它');
  } finally { s.cleanup(); }
});
