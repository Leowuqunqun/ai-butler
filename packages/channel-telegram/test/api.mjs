/**
 * Bot API 客户端层的测试 —— 真 HTTP，假服务器。
 *
 *   node --test test/api.mjs
 *
 * 这里钉的是"出错的时候，用户会看到哪句话"。Telegram 的错误描述是英文、
 * 而且带上了很多实现细节（`Conflict: terminated by other getUpdates request`），
 * 直接抛给用户等于没抛。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_BODY, FILE_PATH, FAKE_TOKEN, startFakeTelegram } from './fake-telegram.mjs';
import { TelegramApi, TelegramError } from '../lib/api.js';

async function withFake(t) {
  const fake = await startFakeTelegram();
  t.after(() => fake.close());
  return fake;
}

test('getMe：认得出自己是谁', async (t) => {
  const fake = await withFake(t);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  const me = await api.getMe();
  assert.equal(me.username, 'butler_test_bot');
});

test('token 不对：说"token 不认"，而不是 Unauthorized', async (t) => {
  const fake = await withFake(t);
  const api = new TelegramApi({ token: '123456:WRONG', baseUrl: fake.url });
  await assert.rejects(
    async () => { await api.getMe(); },
    (e) => {
      assert.ok(e instanceof TelegramError);
      assert.equal(e.code, 401);
      assert.match(e.message, /token 不认/);
      assert.equal(e.description, 'Unauthorized', '原文不能丢，排查时还要用');
      return true;
    },
  );
});

test('★ 409（另一个程序在抢同一个 token）：要说清楚"会随机丢消息"这件事', async (t) => {
  const fake = await withFake(t);
  fake.failOnce(409);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await assert.rejects(
    async () => { await api.getUpdates({ offset: 0 }); },
    (e) => {
      assert.match(e.message, /另一个程序/);
      assert.match(e.message, /随机/, '光说"冲突"用户不知道该怕什么');
      return true;
    },
  );
});

test('429：把 Telegram 说的等待时间带出来', async (t) => {
  const fake = await withFake(t);
  fake.failOnce(429);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await assert.rejects(
    async () => { await api.sendMessage({ chatId: '1', text: 'hi' }); },
    (e) => {
      assert.equal(e.code, 429);
      assert.equal(e.retryAfterSec, 1);
      return true;
    },
  );
});

test('网络不通：说"检查一下能不能上外网"，不是 fetch failed', async () => {
  const api = new TelegramApi({
    token: FAKE_TOKEN,
    fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
  });
  await assert.rejects(
    async () => { await api.getMe(); },
    (e) => {
      assert.match(e.message, /连不上 Telegram/);
      assert.match(e.message, /上外网/);
      assert.doesNotMatch(e.message, /fetch failed/);
      return true;
    },
  );
});

test('getUpdates：offset 原样送出去，且只订阅 message', async (t) => {
  const fake = await withFake(t);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await api.getUpdates({ offset: 7, timeoutSec: 0 });

  const body = JSON.parse(fake.state.requests.find((r) => r.path.endsWith('/getUpdates')).body.toString());
  assert.equal(body.offset, 7);
  assert.deepEqual(body.allowed_updates, ['message'], '编辑过的消息、频道帖子都不是"有人在跟我说话"');
});

test('sendMessage：给了 replyTo 才带引用', async (t) => {
  const fake = await withFake(t);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await api.sendMessage({ chatId: '42', text: '不带引用' });
  await api.sendMessage({ chatId: '42', text: '带引用', replyTo: 10 });

  assert.equal(fake.state.sent[0].reply_to_message_id, undefined);
  assert.equal(fake.state.sent[1].reply_to_message_id, 10);
  assert.equal(fake.state.sent[1].chat_id, '42');
});

test('★ 发文件：真的是 multipart，文件名和字节都在里面', async (t) => {
  const fake = await withFake(t);
  const dir = mkdtempSync(join(tmpdir(), 'tg-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '说明.txt');
  writeFileSync(file, FILE_BODY);

  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await api.sendDocument({ chatId: '42', path: file, name: '说明.txt', caption: '给' });

  const up = fake.state.uploads[0];
  assert.equal(up.method, 'sendDocument');
  assert.match(up.contentType, /^multipart\/form-data; boundary=/);
  assert.match(up.raw, /name="document"; filename="说明\.txt"/);
  assert.match(up.raw, /给/);
  assert.ok(up.raw.includes(FILE_BODY.toString('utf8')), '字节要在 body 里');
});

test('getFile + download：两段式取件，落盘字节一致', async (t) => {
  const fake = await withFake(t);
  const dir = mkdtempSync(join(tmpdir(), 'tg-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  const info = await api.getFile('f1');
  assert.equal(info.file_path, FILE_PATH);

  const dest = join(dir, 'got.txt');
  await api.download(info.file_path, dest);
  assert.deepEqual(readFileSync(dest), FILE_BODY);
});

test('文件路径不对（或太大了）：下载要抛一句人话', async (t) => {
  const fake = await withFake(t);
  const dir = mkdtempSync(join(tmpdir(), 'tg-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  await assert.rejects(
    async () => { await api.download('documents/other/nope.bin', join(dir, 'x')); },
    (e) => {
      assert.match(e.message, /下载文件失败/);
      return true;
    },
  );
});

test('文件下载走的是 /file/bot<token>/… 那条路（不是方法名那条）', async (t) => {
  const fake = await withFake(t);
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });
  assert.equal(api.fileBase, `${fake.url}/file/bot${FAKE_TOKEN}`);
});

test('长轮询挂住的时候 abort 能立刻掐断（stop 的底层保证）', async (t) => {
  const fake = await withFake(t);
  fake.hang();
  const api = new TelegramApi({ token: FAKE_TOKEN, baseUrl: fake.url });

  const ac = new AbortController();
  const p = api.getUpdates({ offset: 0, timeoutSec: 25, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);

  const t0 = Date.now();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 1500, '掐断要立刻生效，不是等 25 秒');
});
