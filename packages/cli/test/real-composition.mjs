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
import { existsSync, mkdtempSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
