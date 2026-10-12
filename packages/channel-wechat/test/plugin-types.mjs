/**
 * 防漂移：`src/plugin.d.ts` 是手写的，实现是 `plugin.mjs`（JS）。
 * 两份东西一旦对不上，消费方（核心层）拿到的类型就是**假的**——
 * 这个测试就是拿来防这件事的。
 *
 * 查三件：
 *   ① `.d.ts` 里声明的名字，运行时必须真的有（防写错/防删了没改）
 *   ② seam 的每个抽象成员，`WechatChannel` 必须真的实现（防漏实现）
 *   ③ 声明里的每个方法，运行时必须是函数（防声明成属性了）
 *
 *   node --test test/plugin-types.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { WechatChannel } from '../src/plugin.mjs';

const dts = readFileSync(new URL('../src/plugin.d.ts', import.meta.url), 'utf8');

/** 从 `.d.ts` 的类体里抠出成员名（只认 `  name(` 和 `  name:` 两种写法） */
function declaredMembers(source) {
  const body = source.slice(source.indexOf('export declare class WechatChannel'));
  const members = new Set();
  for (const line of body.split('\n')) {
    const m = /^ {2}(?:readonly |static )?([a-zA-Z_][\w]*)\s*[(:<]/.exec(line);
    if (m) members.add(m[1]);
  }
  return members;
}

const declared = declaredMembers(dts);

/**
 * 造一个真实例。
 *
 * 注意 **不能用 `WechatChannel.prototype` 来判定成员是否存在**：
 * `id = 'wechat'` 和 `config` 是 class field，落在**实例**上；
 * `static Config` 落在**构造函数**上；只有方法是挂在 prototype 上的。
 * 这个坑是这个测试第一版踩出来的。
 */
async function makeChannel() {
  const home = mkdtempSync(join(tmpdir(), 'wab-types-'));
  const ctx = new Context();
  await ctx.plugin(WechatChannel, { home });
  return {
    channel: ctx.channel,
    done: async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }); },
  };
}

test('抠声明这件事本身是对的（别测了个空集合）', () => {
  assert.ok(declared.size >= 8, `抠出来的成员太少，解析大概坏了：${[...declared]}`);
  for (const must of ['start', 'stop', 'sendText', 'sendFile', 'setTyping', 'id', 'config', 'createIlink']) {
    assert.ok(declared.has(must), `声明里应该提到 ${must}`);
  }
});

test('① 声明里写的名字，运行时都真的存在', async () => {
  const { channel, done } = await makeChannel();
  const missing = [];
  for (const name of declared) {
    if (name === 'constructor') continue;
    if (!(name in channel) && !(name in WechatChannel)) missing.push(name);
  }
  assert.deepEqual(missing, [], `声明了但运行时没有：${missing.join(', ')}`);
  await done();
});

test('② seam 的每个抽象成员都真的实现了', async () => {
  const { channel, done } = await makeChannel();
  // 跟 seam-channel/src/index.ts 里的 abstract 列表一一对应
  for (const name of ['start', 'stop', 'sendText', 'sendFile']) {
    assert.equal(typeof channel[name], 'function', `${name} 没实现`);
  }
  // id 是 abstract readonly，必须真的能读出字符串
  assert.equal(typeof channel.id, 'string');
  assert.equal(channel.id, 'wechat');
  await done();
});

test('③ 声明成方法的，运行时确实是函数（不是属性）', async () => {
  const { channel, done } = await makeChannel();
  const methods = ['start', 'stop', 'sendText', 'sendFile', 'setTyping', 'createIlink', 'enqueue', 'fetchInbound'];
  for (const name of methods) {
    assert.equal(typeof channel[name], 'function', `${name} 应该是方法`);
  }
  await done();
});

test('基类白送的东西也还在（onMessage / offMessage / emitMessage）', async () => {
  const { channel, done } = await makeChannel();
  for (const name of ['onMessage', 'offMessage', 'emitMessage']) {
    assert.equal(typeof channel[name], 'function', `${name} 应当从基类继承`);
  }
  await done();
});

test('默认导出和具名导出是同一个东西（有人两种写法都用）', async () => {
  const mod = await import('../src/plugin.mjs');
  assert.equal(mod.default, mod.WechatChannel);
});
