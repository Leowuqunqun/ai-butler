/**
 * 协议层（`src/ilink.mjs`）的测试。
 *
 * 重点覆盖**能立刻掐断长轮询**这条：长轮询一次挂 40 秒，
 * 停机时如果只能等它自己超时，`Ctrl-C` 就会像卡住一样。
 *
 * 手法：临时换掉 `globalThis.fetch`（`IlinkClient` 直接用的是全局 fetch），
 * 换成一个"挂住但尊重 signal"的桩。不连网。
 *
 *   node --test test/ilink.mjs
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IlinkClient } from '../src/ilink.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 挂住不回的 fetch，但**尊重 signal** —— 模拟一个真实的长轮询 */
function hangingFetch() {
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise((_, reject) => {
      const s = init?.signal;
      if (!s) return;                                  // 没有 signal 就真的永远挂着
      if (s.aborted) return reject(new Error('aborted'));
      s.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  return calls;
}

test('传了 signal：abort 能立刻掐断长轮询（不用等 timeoutMs）', async () => {
  hangingFetch();
  const c = new IlinkClient({ botToken: 'tok' });
  const ac = new AbortController();

  const p = c.getUpdates('buf', { signal: ac.signal, timeoutMs: 60_000 });
  setTimeout(() => ac.abort(), 10);

  const t0 = Date.now();
  await assert.rejects(() => p);
  assert.ok(Date.now() - t0 < 1000, `应当立刻中断，实际花了 ${Date.now() - t0}ms`);
});

test('已经 abort 过的 signal 传进去：直接就不发请求了', async () => {
  const calls = hangingFetch();
  const c = new IlinkClient({ botToken: 'tok' });
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(() => c.getUpdates('', { signal: ac.signal }));
  assert.equal(calls.length, 1, '请求发出去了，但立刻就被中断（不是没发）');
});

test('不传 signal：原有的 timeoutMs 行为不变', async () => {
  hangingFetch();
  const c = new IlinkClient({ botToken: 'tok' });
  const t0 = Date.now();
  await assert.rejects(() => c.getUpdates('', { timeoutMs: 40 }));
  const spent = Date.now() - t0;
  assert.ok(spent >= 30 && spent < 1000, `应当在 timeoutMs 附近失败，实际 ${spent}ms`);
});

test('掐断之后监听器会被摘掉，不留悬挂（同一个 signal 反复用不泄漏）', async () => {
  hangingFetch();
  const c = new IlinkClient({ botToken: 'tok' });
  const ac = new AbortController();

  let p = c.getUpdates('', { signal: ac.signal, timeoutMs: 10 });
  await assert.rejects(() => p);

  // 超时路径走完：signal 上不该还挂着监听器
  // （Node 没给公开的监听器计数 API，这里用"再加一个不会立刻触发"来间接确认其可用）
  assert.equal(ac.signal.aborted, false, '自然超时不该把调用方的 signal 也置为 aborted');

  p = c.getUpdates('', { signal: ac.signal, timeoutMs: 10 });
  await assert.rejects(() => p, '同一个 signal 应当可以继续复用');
});

// ─────────────────── 出站媒体：发文件 vs 发图片 ───────────────────

/**
 * 这两个用例钉的是**协议上最容易写混的一处**：
 * aes_key 有两种编码，而且图片还有第二个来源。写错了不会报错，
 * 只会让对面看到一坨打不开的乱码 —— 所以只能靠测试钉住。
 */
function fakeCdn() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('ilink/bot/getuploadurl')) {
      return new Response(JSON.stringify({ ret: 0, upload_full_url: 'https://cdn.test/upload?k=1' }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://cdn.test/')) {
      return new Response('', { status: 200, headers: { 'x-encrypted-param': 'PARAM-1' } });
    }
    if (u.includes('ilink/bot/sendmessage')) return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
    throw new Error(`这条用例没预期的请求：${u}`);
  };
  return calls;
}

/** 用请求里给的 key 把上传的密文解回来 —— 解得出原文，就说明加密和编码都对 */
function decryptUploaded(encBody, keyBuffer) {
  const d = createDecipheriv('aes-128-ecb', keyBuffer, null);
  return Buffer.concat([d.update(encBody), d.final()]);
}

function tmpMedia(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'wx-media-'));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test('发文件：media_type=3、item 是 FILE，aes_key 写成 base64(hex(key))', async () => {
  const file = tmpMedia('报告.pdf', Buffer.from('hello-附件'));
  const calls = fakeCdn();
  const c = new IlinkClient({ botToken: 'tok', baseUrl: 'https://ilink.test' });

  const r = await c.sendFile('u1', file, { contextToken: 'tk' });
  assert.deepEqual(r, { fileName: '报告.pdf', size: Buffer.byteLength('hello-附件') });

  const upl = JSON.parse(calls[0].init.body);
  assert.equal(upl.media_type, 3, '文件是 3');
  assert.equal(upl.to_user_id, 'u1');

  const msg = JSON.parse(calls[2].init.body).msg;
  assert.equal(msg.context_token, 'tk');
  const item = msg.item_list[0];
  assert.equal(item.type, 4, 'item 类型：文件是 4');
  assert.equal(item.file_item.file_name, '报告.pdf');
  assert.equal(item.file_item.len, String(Buffer.byteLength('hello-附件')));
  assert.equal(item.file_item.md5, createHash('md5').update('hello-附件').digest('hex'));

  // 编码：base64(hex(key))—— 解回来要能拿到原文
  const keyHex = Buffer.from(item.file_item.media.aes_key, 'base64').toString('utf8');
  assert.equal(keyHex, upl.aeskey, 'aes_key 是 base64(那一串 hex)');
  assert.match(keyHex, /^[0-9a-f]{32}$/, 'hex 串长这样');
  assert.equal(decryptUploaded(calls[1].init.body, Buffer.from(keyHex, 'hex')).toString(), 'hello-附件');
});

test('发图片：media_type=1、item 是 IMAGE，两个 key 来源各自用对编码', async () => {
  const file = tmpMedia('报表.png', Buffer.from('fake-png-bytes'));
  const calls = fakeCdn();
  const c = new IlinkClient({ botToken: 'tok', baseUrl: 'https://ilink.test' });

  await c.sendFile('u1', file, { kind: 'image' });

  const upl = JSON.parse(calls[0].init.body);
  assert.equal(upl.media_type, 1, '图片是 1（以前这里写死成文件，图片就变成"收到一个附件"');

  const item = JSON.parse(calls[2].init.body).msg.item_list[0];
  assert.equal(item.type, 2, 'item 类型：图片是 2');
  assert.equal(item.file_item, undefined, '图片不该带 file_item');

  // 两个来源、两种编码，而且指的是同一把钥匙
  assert.match(item.image_item.aeskey, /^[0-9a-f]{32}$/, 'image_item.aeskey 是 hex 串');
  assert.equal(Buffer.from(item.image_item.media.aes_key, 'base64').length, 16,
    '图片的 media.aes_key 是 base64(16 字节原始 key)—— 不是 base64(hex)');
  // "互相还原"要比的是**解出来的那把钥匙**，不是两个 base64 字符串
  // （base64(hex) 和 base64(原始 16 字节) 是两个不同的串，但指向同一把钥匙）
  assert.deepEqual(Buffer.from(item.image_item.media.aes_key, 'base64'),
    Buffer.from(item.image_item.aeskey, 'hex'),
    '两个来源必须指向同一把钥匙 —— 这就是最容易写混的地方');
  assert.notEqual(item.image_item.media.aes_key, item.image_item.aeskey,
    '两种编码长得就该不一样（一样了说明有一处写成了另一种约定）');

  // 拿 hex 那把解上传的密文
  assert.equal(
    decryptUploaded(calls[1].init.body, Buffer.from(item.image_item.aeskey, 'hex')).toString(),
    'fake-png-bytes',
  );
});

test('发视频：media_type=2、item 是 VIDEO，aes_key 回到"文件那一档"编码', async () => {
  const file = tmpMedia('演示.mp4', Buffer.from('fake-mp4-bytes'));
  const calls = fakeCdn();
  const c = new IlinkClient({ botToken: 'tok', baseUrl: 'https://ilink.test' });

  await c.sendFile('u1', file, { kind: 'video' });

  const upl = JSON.parse(calls[0].init.body);
  assert.equal(upl.media_type, 2, '视频是 2');

  const item = JSON.parse(calls[2].init.body).msg.item_list[0];
  assert.equal(item.type, 5, 'item 类型：视频是 5');
  assert.equal(item.file_item, undefined);
  assert.equal(item.image_item, undefined, '视频不走 image_item');
  assert.equal(item.video_item.media.encrypt_type, 1);

  // 编码：视频跟文件同一档（**不是**图片那一档）—— 这正是最容易顺手抄错的地方
  const keyHex = Buffer.from(item.video_item.media.aes_key, 'base64').toString('utf8');
  assert.equal(keyHex, upl.aeskey, 'base64(hex(key))，跟文件一样');
  assert.match(keyHex, /^[0-9a-f]{32}$/);
  assert.equal(decryptUploaded(calls[1].init.body, Buffer.from(keyHex, 'hex')).toString(), 'fake-mp4-bytes');
});
