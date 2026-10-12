/**
 * 通道凭据：存哪、怎么存、谁能覆盖谁。
 *
 *   node --test test/secrets.mjs
 *
 * 这个文件存在的理由：**凭据文件是"等同账号密码"的东西**（能冒充你的机器人
 * 发消息），所以它落在哪、权限多少、被谁覆盖，每一条都要钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  channelSecretNeed,
  injectChannelSecrets,
  readSecrets,
  saveSecret,
  secretOf,
  secretsFileOf,
} from '@butler/cli';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-secrets-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const TGM = { name: '@butler/channel-telegram', config: { botToken: '' } };
const WECHAT = { name: 'wechat-agent-bridge/plugin', config: {} };

test('落点：<管家目录>/state/secrets.json', () => {
  assert.equal(secretsFileOf('/home/x/.butler'), join('/home/x/.butler', 'state', 'secrets.json'));
});

test('存一项：0600、能读回来、不留临时文件', () => {
  const s = sandbox();
  try {
    const file = secretsFileOf(s.dir);
    saveSecret(file, 'telegram', 'botToken', '123:ABC-DEF');
    assert.equal(secretOf(file, 'telegram', 'botToken'), '123:ABC-DEF');
    assert.equal(statSync(file).mode & 0o777, 0o600, '凭据文件必须只有本人可读');
    assert.deepEqual(readdirSync(dirname(file)), ['secrets.json'], '不许留 .tmp');
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.version, 1, '带版本号，以后改结构有地方判断');
  } finally { s.cleanup(); }
});

test('合并写：第二个通道不会把第一个弄丢（同一个文件）', () => {
  const s = sandbox();
  try {
    const file = secretsFileOf(s.dir);
    saveSecret(file, 'telegram', 'botToken', 'a');
    saveSecret(file, 'other', 'token', 'b');
    assert.equal(secretOf(file, 'telegram', 'botToken'), 'a');
    assert.equal(secretOf(file, 'other', 'token'), 'b');
  } finally { s.cleanup(); }
});

test('★ 读坏了当"还没有"：一个坏文件不该让 butler run 直接崩', () => {
  const s = sandbox();
  try {
    const file = secretsFileOf(s.dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ 这不是 JSON');
    assert.deepEqual(readSecrets(file), { version: 1, channels: {} });
    assert.equal(secretOf(file, 'telegram', 'botToken'), null);
  } finally { s.cleanup(); }
});

test('空值不写（那等于没填），空白也 trim 掉', () => {
  const s = sandbox();
  try {
    const file = secretsFileOf(s.dir);
    assert.throws(() => saveSecret(file, 'telegram', 'botToken', '   '), /空的值不写/);
    saveSecret(file, 'telegram', 'botToken', '  123:AB  ');
    assert.equal(secretOf(file, 'telegram', 'botToken'), '123:AB');
  } finally { s.cleanup(); }
});

test('哪个通道要凭据：Telegram 要，微信不要（它靠扫码）', () => {
  const need = channelSecretNeed(TGM);
  assert.equal(need?.channel, 'telegram');
  assert.equal(need?.key, 'botToken');
  assert.match(need?.name ?? '', /Telegram/);
  assert.match(need?.hint ?? '', /BotFather/, '要告诉他去哪儿拿');
  assert.equal(channelSecretNeed(WECHAT), null);
});

test('★ 注入只填**空的**：配置里手写的值优先级最高', () => {
  const s = sandbox();
  try {
    const file = secretsFileOf(s.dir);
    saveSecret(file, 'telegram', 'botToken', '123:FROM-PAGE');

    const blank = { name: '@butler/channel-telegram', config: { botToken: '' } };
    assert.deepEqual(injectChannelSecrets([blank], file), ['botToken']);
    assert.equal(blank.config.botToken, '123:FROM-PAGE');

    const written = { name: '@butler/channel-telegram', config: { botToken: '456:MINE' } };
    assert.deepEqual(injectChannelSecrets([written], file), [], '手写的不许被覆盖');
    assert.equal(written.config.botToken, '456:MINE');

    const wechat = { name: 'wechat-agent-bridge/plugin', config: {} };
    assert.deepEqual(injectChannelSecrets([wechat], file), []);
  } finally { s.cleanup(); }
});

test('没有存过的凭据：一个字段都不填', () => {
  const s = sandbox();
  try {
    const row = { name: '@butler/channel-telegram', config: { botToken: '' } };
    assert.deepEqual(injectChannelSecrets([row], secretsFileOf(s.dir)), []);
    assert.equal(row.config.botToken, '');
  } finally { s.cleanup(); }
});
