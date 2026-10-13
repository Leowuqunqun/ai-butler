/**
 * 探针的测试 —— 主要盯一件小事：**凭据写下去的形状，和 CLI 读的那条约定是不是同一个**。
 *
 * 为什么值得单独立一个文件：这条路的唯一产出就是那个文件。它写错了，用户会看到
 * "探针说存好了、`butler run` 却说还没有 app_id"，而**两边各自的测试都是绿的**
 * （探针原来没测试；CLI 只测自己读的那一半）。这就是"两边都自洽、合起来不通"。
 *
 * CLI 那一半的读法钉在 `packages/cli/test/secrets.mjs`（形如
 * `{ "version": 1, "channels": { "feishu": { "appId": …, "appSecret": … } } }`）；
 * 这里钉写的那一半。改任何一边的形状，另一边会红 —— 这是故意的。
 *
 * @module @butler/channel-feishu/test/probe
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { homeOf, saveCreds, secretsFileOf } from '../probe/save.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const freshHome = () => mkdtempSync(join(tmpdir(), 'butler-probe-'));

test('管家目录的优先级：--home= > BUTLER_HOME > ~/.butler', () => {
  assert.equal(homeOf(['node', 'x', '--home=/tmp/one'], { BUTLER_HOME: '/tmp/two' }), '/tmp/one');
  assert.equal(homeOf(['node', 'x'], { BUTLER_HOME: '/tmp/two' }), '/tmp/two');
  assert.match(homeOf(['node', 'x'], {}), /\.butler$/, '都没有就落在默认位置');
});

test('★ 写出来的形状，就是 CLI 读的那条约定（两边都自洽、合起来不通，最难查）', () => {
  const home = freshHome();
  const file = saveCreds(home, 'cli_from_probe', 'secret_from_probe');

  assert.equal(file, join(home, 'state', 'secrets.json'), '位置：<管家目录>/state/secrets.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.channels.feishu, { appId: 'cli_from_probe', appSecret: 'secret_from_probe' });
});

test('0600：凭据文件只有主人能读', () => {
  const file = saveCreds(freshHome(), 'a', 'b');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('★ 合并写：别人的 token 一个字都不能碰（那是他的微信/Telegram）', () => {
  const home = freshHome();
  saveCreds(home, 'first', 's1', 'telegram');
  saveCreds(home, 'second', 's2');          // 再存一次飞书（模拟先跑了 telegram 再跑飞书）

  const raw = JSON.parse(readFileSync(secretsFileOf(home), 'utf8'));
  assert.deepEqual(raw.channels.telegram, { appId: 'first', appSecret: 's1' }, '别人那格必须原样');
  assert.deepEqual(raw.channels.feishu, { appId: 'second', appSecret: 's2' });
});

test('坏文件会被覆盖成新的（因为一个坏文件就再也存不进凭据，是更难查的故障）', () => {
  const home = freshHome();
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(secretsFileOf(home), '{ 这不是 JSON');
  assert.doesNotThrow(() => saveCreds(home, 'a', 'b'), '坏文件不能让存凭据这条路直接崩');
  const raw = JSON.parse(readFileSync(secretsFileOf(home), 'utf8'));
  assert.deepEqual(raw.channels.feishu, { appId: 'a', appSecret: 'b' });
});

test('不留临时文件（先临时文件再 rename，是为了断电不留半个 JSON）', () => {
  const home = freshHome();
  saveCreds(home, 'a', 'b');
  const names = readdirSync(join(home, 'state'));
  assert.deepEqual(names, ['secrets.json'], 'tmp 必须已经 rename 走了');
});

// ── dry：你打的第一条命令。它必须**不联网、不落盘**，而且说真话 ──────────────

test('★ --dry 只说不做：退出 0、一个文件都不写、说清要干什么', () => {
  const home = freshHome();
  const r = spawnSync('bash', [join(pkgRoot, 'probe', 'run.sh'), '--dry', '--home=' + home], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(r.status, 0, '--dry 不能失败：那是用户对项目的第一印象');
  assert.match(r.stdout, /dry run/, '明说这是空跑');
  assert.match(r.stdout, /registerApp|扫码/, '说清没凭据会走扫码');
  assert.match(r.stdout, /connect\(\)/, '说清要连长连接');
  assert.deepEqual(readdirSync(home), [], 'dry 一个文件都不该写（连目录都不建）');
});

test('★ --dry 里的 --save 必须说**真**路径（用 --home= 时最容易存错地方）', () => {
  const home = freshHome();
  const r = spawnSync('bash', [join(pkgRoot, 'probe', 'run.sh'), '--dry', '--save', '--home=' + home], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(r.status, 0);
  assert.ok(
    r.stdout.includes(join(home, 'state', 'secrets.json')),
    `要说真路径，别写死 ~/.butler —— 用户用 --home= 就是怕存错地方。实际输出：\n${r.stdout}`,
  );
});

/**
 * 第一枪最容易让人查错方向的那件事，探针必须**当面说**。
 *
 * 同一个应用开两条长连接时，飞书把事件在两条之间**分流投递** —— 表现是"消息偶尔不回"，
 * 而两边看起来都正常。最常见的顺序就是：探针验通了没关，又起了 `butler run`。
 * 文档里写着（第十二节），但用户在终端里盯的是探针，不是文档 —— 所以这句必须由探针自己说。
 */
test('★ --dry 里必须警告"别让管家同时连着同一个应用"（两条长连接会分流）', () => {
  const home = freshHome();
  const r = spawnSync('bash', [join(pkgRoot, 'probe', 'run.sh'), '--dry', '--home=' + home], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /别让管家/, '要指名道姓说"别让管家也连着"');
  assert.match(r.stdout, /分流/, '要说清机制：事件被分流投递，不是"坏了"');
  assert.match(r.stdout, /偶尔不回/, '要说清症状 —— 不然遇到时会往错的方向查');
});

/**
 * 和上一条同一个道理、同一份文本：**连上了却没有消息**是事件订阅 / 权限点的问题，
 * 而用户从终端里看不出来（长连接是通的，机器人身份也打出来了）。文档第十二节那张表
 * 写着这三条，可"用户在终端里盯的是探针，不是文档" —— 所以这句得由探针自己说。
 *
 * 这条只钉 `--dry` 那一份：真跑那份在 `connect()` 之后，离线测不到。但两处调的是**同一个
 * 函数**（和上一条一样），文本在这儿钉住就够了。
 */
test('★ --dry 里必须说清"连上了却没动静"往哪查（权限点 / 事件订阅）', () => {
  const home = freshHome();
  const r = spawnSync('bash', [join(pkgRoot, 'probe', 'run.sh'), '--dry', '--home=' + home], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /一条都收不到/, '先把症状说出来 —— 不然他会以为是自己消息发错了');
  assert.match(r.stdout, /im\.message\.receive_v1/, '给一个能照着查的锚点：事件名');
  assert.match(r.stdout, /长连接/, '订阅方式得是长连接');
  assert.match(r.stdout, /发版/, '最常见的坑：权限改完不发版不生效（文档那张表里也写着）');
});
