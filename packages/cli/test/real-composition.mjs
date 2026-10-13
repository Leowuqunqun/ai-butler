/**
 * **真实组合**能不能装进容器。
 *
 *   node --test test/real-composition.mjs
 *
 * 前面所有测试用的都是夹具。这一条不一样：用的是**真正的三个插件** ——
 * 真的微信通道、真的内核、真的 dsh agent。
 *
 * ⚠️ **只装载，不启动。** 通道的构造函数只建客户端不连网，连网发生在 start()
 * 里 —— 真连上会跟正在跑的那条桥抢同一个微信账号的消息（两个循环游标打架）。
 * 所以这里验的是"这套组合装得起来、服务位齐、配置传对了"，
 * 而"连上之后能不能收发"是线上那条桥在验的事。
 *
 * 这一条是"架构真的合得上"的最强证据：五个包、三条接缝，能同时立在一个容器里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boot } from '@butler/cli';

/** 造一份"跟真实产品一样"的配置：包名寻址，三行缺一不可 */
function realConfig(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'real-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    plugins: [
      {
        id: 'channel-wechat',
        name: 'wechat-agent-bridge/plugin',
        config: { home: dir, botType: '3' },
      },
      {
        id: 'agent-dsh',
        name: '@butler/agent-dsh',
        config: {
          // 只需要非空，构造时校验；这里不真跑 dsh
          patchFile: join(dir, 'dsh.patch.yml'),
          home: join(dir, 'dsh-home'),
          bin: 'dsh',
        },
      },
      {
        id: 'core',
        name: '@butler/core',
        config: { workspace: dir, stateFile: join(dir, 'state.json') },
      },
    ],
    ...extra,
  }));
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('真实组合：真通道 + 真内核 + 真 agent，三行都装得上', async () => {
  const t = realConfig();
  const b = await boot({ configPath: t.file });
  try {
    assert.deepEqual(
      b.failures.map((f) => `${f.id}: ${f.message}`),
      [],
      '这三行是产品的主干，一行都不该装不上',
    );
    assert.deepEqual(b.loaded.map((r) => r.id), ['channel-wechat', 'agent-dsh', 'core']);
  } finally { await b.dispose(); t.cleanup(); }
});

test('真实组合：三个能力位都在，而且是**真的实现**（不是夹具）', async () => {
  const t = realConfig();
  const b = await boot({ configPath: t.file });
  try {
    for (const name of ['channel', 'agent', 'core']) {
      assert.equal(b.has(name), true, `ctx.${name} 应当就位`);
    }
    // 内核只认接缝，不该认识具体实现 —— 这条是那个分层原则的运行时证据
    assert.equal(b.ctx.channel.id, 'wechat', '通道自报的 id');
    assert.equal(b.ctx.agent.id, 'dsh', '大脑自报的 id');
    assert.equal(b.ctx.core.cwd, t.dir, '内核的工作目录来自配置，端到端传到了');
  } finally { await b.dispose(); t.cleanup(); }
});

test('真实组合：记忆这一行接上之后，用的是**真存储**、落在对的地方', async () => {
  // 这份配置比 realConfig 多一行：真的 memory-file（不是夹具）。
  // 要验的是两件事：能力位真的是那个实现；它把文件落在配置说的那个 home 下。
  const dir = mkdtempSync(join(tmpdir(), 'real-mem-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    plugins: [
      { id: 'channel-wechat', name: 'wechat-agent-bridge/plugin', config: { home: dir, botType: '3' } },
      {
        id: 'agent-dsh',
        name: '@butler/agent-dsh',
        config: {
          patchFile: join(dir, 'dsh.patch.yml'),
          home: join(dir, 'dsh-home'),
          bin: 'dsh',
        },
      },
      { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
      { id: 'memory', name: '@butler/memory-file', config: { home: dir } },
    ],
  }));

  const b = await boot({ configPath: file });
  try {
    assert.deepEqual(b.failures.map((f) => `${f.id}: ${f.message}`), [], '记忆那一行不该装不上');
    assert.equal(b.has('memory'), true, 'ctx.memory 应当就位');
    assert.equal(b.ctx.memory.id, 'file', '要是真实现，不是夹具');

    await b.ctx.memory.set('简历放哪', 'Documents/简历/', { source: 'owner' });
    assert.equal(await b.ctx.memory.get('简历放哪'), 'Documents/简历/');

    const where = join(dir, 'state', 'memory.json');
    assert.ok(existsSync(where), `记忆该落在配置说的 home 下：${where}`);
    assert.equal(statSync(where).mode & 0o777, 0o600, '含隐私，只有本人可读');
  } finally {
    await b.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真实组合：内核的 config 真的落到了内核身上（含默认值补齐）', async () => {
  const t = realConfig();
  const b = await boot({ configPath: t.file });
  try {
    const cfg = b.ctx.core.config;
    assert.equal(cfg.workspace, t.dir);
    assert.equal(cfg.quoteReply, true, '没写的字段由 schema 补默认值');
    assert.equal(cfg.maxQueue, 5);
    assert.deepEqual(cfg.allowFrom, []);
  } finally { await b.dispose(); t.cleanup(); }
});

test('真实组合：patch 能改中间那一行，另外两行不受影响', async () => {
  const t = realConfig();
  const patch = join(t.dir, 'me.json');
  writeFileSync(patch, JSON.stringify({
    plugins: [{
      id: 'agent-dsh',
      name: '@butler/agent-dsh',
      config: { patchFile: join(t.dir, 'p2.yml'), home: join(t.dir, 'h2'), timeoutMs: 12_345 },
    }],
  }));

  const b = await boot({ configPath: t.file, patches: [patch] });
  try {
    assert.deepEqual(b.failures, []);
    assert.equal(b.ctx.agent.config.timeoutMs, 12_345, '补丁生效');
    assert.equal(b.ctx.core.cwd, t.dir, '别的行一点没动');
    assert.equal(b.ctx.channel.id, 'wechat', '别的行一点没动');
  } finally { await b.dispose(); t.cleanup(); }
});

test('真实组合：少一行主干，boot 不报错但**能力位缺**，由调用方判断', async () => {
  const t = realConfig();
  // 把内核那行关掉
  const patch = join(t.dir, 'off.json');
  writeFileSync(patch, JSON.stringify({
    plugins: [{ id: 'core', name: '@butler/core', disabled: true }],
  }));

  const b = await boot({ configPath: t.file, patches: [patch] });
  try {
    assert.deepEqual(b.failures, [], 'boot 自己不判断"够不够"，只如实汇报装了什么');
    assert.equal(b.has('core'), false);
    assert.equal(b.has('channel'), true);
    assert.deepEqual(b.disabled.map((r) => r.id), ['core']);
    // `butler run` 就是靠这两个信号决定要不要拦下来的
  } finally { await b.dispose(); t.cleanup(); }
});

test('真实组合：卸载之后三个服务位一起消失，不留半截', async () => {
  const t = realConfig();
  const b = await boot({ configPath: t.file });
  assert.equal(b.has('channel'), true);
  await b.dispose();
  try {
    for (const name of ['channel', 'agent', 'core']) {
      assert.equal(b.has(name), false, `dispose 之后 ctx.${name} 不该还在`);
    }
  } finally { t.cleanup(); }
});

/**
 * 飞书那一行的**装载**：没有凭据也必须装得上。
 *
 * 这一条是照着真机上撞到的坑写的（第 8 轮）：官方包在**构造时**就校验凭据，
 * 而插件是**装载时**构造的 —— 于是"用户还没填 app_id"（一个正常状态：凭据是
 * `butler run` 现从 `state/secrets.json` 注入的）变成了**插件装载失败**：
 * `doctor` 说"配置里一行都没有"、`butler run` 起不来，而适配层里那两段人话**永远到不了**。
 *
 * 为什么放这儿而不是适配层自己的测试里：那边验的是 `new FeishuChannel(...)` 的行为，
 * 这里验的是**产品真路径**（`boot()` + 包名寻址 + 空凭据）—— 用户走的是这条。
 */
test('真实组合：飞书那行**没填凭据也装得上**，而且如实报 ✗ 并指向探针', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'real-feishu-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    plugins: [
      // 空凭据 —— 这不是错误状态，是"还没跑探针"的常态
      { id: 'channel-feishu', name: '@butler/channel-feishu', config: { home: dir, appId: '', appSecret: '' } },
      { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
    ],
  }));

  const b = await boot({ configPath: file });
  try {
    assert.deepEqual(
      b.failures.map((f) => `${f.id}: ${f.message}`),
      [],
      '没凭据不该是"装载失败" —— 那样 doctor 会报"配置里一行都没有"，用户完全看不懂',
    );
    assert.equal(b.has('channel'), true);
    assert.equal(b.ctx.channel.id, 'feishu', '要是真实现，不是夹具');

    // 装得上 ≠ 假装没事：自检要如实报 ✗，并给出**能照着做**的出路
    const checks = await b.ctx.channel.check();
    const cred = checks.find((c) => /app_id/.test(c.name ?? '') || /凭据|登录态/.test(c.name ?? ''));
    assert.ok(cred, `自检里应当有一条讲凭据的，实际：${JSON.stringify(checks)}`);
    assert.equal(cred.ok, false, '没凭据就得报 ✗，不能误导');
    // 出路里的命令必须**真的能照着敲**：写死 `packages/...` 只在源码树里成立，
    // 用 install.sh 装的人没有 packages/ —— 那条提示会变成死路
    assert.match(cred.fix, /probe\/smoke\.mjs/, '出路要指向探针（它会扫码并把凭据装好）');
    const probe = /`?node ([^`]+?) --save/.exec(cred.fix)?.[1];
    assert.ok(probe && existsSync(probe), `提示里的探针路径要真的存在：${probe}`);
  } finally {
    await b.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 引导页里那段"怎么弄一个飞书应用"，用户是**照着敲**的。
 *
 * 所以这里真的起一次 CLI，看它**打印出来**的东西里那条命令能不能用 ——
 * 不是检查源码里有没有那行字。文案原来写死 `bash packages/channel-feishu/probe/run.sh`，
 * 而用 `install.sh` 装的人没有 `packages/`（那是 tarball 装进 `~/.butler/prefix`）。
 *
 * ⚠️ `--config` + `BUTLER_HOME` 两道锁：这条测试绝不碰用户真正的 `~/.butler`。
 */
test('真实组合：`butler init --im feishu` 打印出来的引导页里，探针那条命令能照着敲', () => {
  const dir = mkdtempSync(join(tmpdir(), 'real-guide-'));
  try {
    const out = execFileSync(process.execPath, [
      fileURLToPath(new URL('../lib/cli.js', import.meta.url)),
      'init', '--im', 'feishu', '--config', join(dir, 'config.json'),
    ], { encoding: 'utf8', env: { ...process.env, BUTLER_HOME: dir } });

    const probe = /node ([^\s`]+probe\/smoke\.mjs) --save/.exec(out)?.[1];
    assert.ok(probe, `引导页里要有一条能照着敲的探针命令，实际打印的是：\n${out}`);
    assert.ok(existsSync(probe), `引导页里的探针路径要真的存在：${probe}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 第 59 轮那两项（`dmMode` / `dmAllowlist`）在**产品真路径**上到底有没有到插件身上。
 *
 * 为什么非得在这儿再验一遍：适配层那边（`channel-feishu/test/policy.mjs`）全是
 * `new FeishuChannel(...)`，走的是**构造函数**；而用户改的是 `config.json` ——
 * 那条路是 **schema 在接**。只验构造函数，等于**假设** schema 接住了它。
 */
test('★ 真实组合：config.json 里的 dmMode / dmAllowlist 真的落到插件身上（没写的补默认）', async () => {
  const bootWith = async (channelConfig) => {
    const dir = mkdtempSync(join(tmpdir(), 'real-dm-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({
      plugins: [
        {
          id: 'channel-feishu',
          name: '@butler/channel-feishu',
          config: { home: dir, appId: '', appSecret: '', ...channelConfig },
        },
        { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
      ],
    }));
    const b = await boot({ configPath: file });
    return { b, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  // ① 写了的：原样到插件身上
  const set = await bootWith({ dmMode: 'allowlist', dmAllowlist: ['ou_someone'] });
  try {
    assert.equal(set.b.ctx.channel.config.dmMode, 'allowlist');
    assert.deepEqual(set.b.ctx.channel.config.dmAllowlist, ['ou_someone']);
  } finally { await set.b.dispose(); set.cleanup(); }

  // ② 没写的：由 schema 补默认。默认必须是 open —— 改默认就是悄悄改所有人的行为
  const dflt = await bootWith({});
  try {
    assert.equal(dflt.b.ctx.channel.config.dmMode, 'open');
    assert.deepEqual(dflt.b.ctx.channel.config.dmAllowlist, []);
  } finally { await dflt.b.dispose(); dflt.cleanup(); }
});

test('★ 真实组合：config.json 里 dmMode 拼错 ⇒ 装载**如实报错**，而不是悄悄按 open 放行', async () => {
  // 这条是第 59 轮那个联合类型的真正落点：官方对不认识的 dmMode 是照 open 处理的，
  // 所以"拼错"在真机上表现为**谁都能私聊**，没有任何别的信号。必须在装载时就红。
  const dir = mkdtempSync(join(tmpdir(), 'real-dm-bad-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    plugins: [
      {
        id: 'channel-feishu',
        name: '@butler/channel-feishu',
        config: { home: dir, appId: '', appSecret: '', dmMode: 'allowList' },
      },
      { id: 'core', name: '@butler/core', config: { workspace: dir, stateFile: join(dir, 'state.json') } },
    ],
  }));

  const b = await boot({ configPath: file });
  try {
    const msgs = b.failures.map((f) => `${f.id}: ${f.message}`);
    assert.ok(
      msgs.some((m) => /dmMode/.test(m)),
      `拼错的 dmMode 必须让装载如实报出来，实际 failures=${JSON.stringify(msgs)}`,
    );
  } finally {
    await b.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
