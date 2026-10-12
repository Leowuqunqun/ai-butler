/**
 * `Update → 入站消息` 的映射测试 —— 纯函数，不用起服务器。
 *
 *   node --test test/update.mjs
 *
 * 这里钉的是 Telegram 那套嵌套结构里最容易搞错的地方：图片是**一组**分辨率、
 * 文件名是**发送方**给的（可以带路径）、编辑过的消息不是新消息。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUpdate, parseContextToken, safeName } from '../lib/update.js';
import { quotedMedia } from '@butler/seam-channel';

/** 一条普通的私聊消息 */
function msg(extra) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 42, first_name: '主人' },
      chat: { id: 42, type: 'private' },
      date: 1_700_000_000,
      ...extra,
    },
  };
}

test('纯文本：认得出谁说的、说什么、回哪一条', () => {
  const got = normalizeUpdate(msg({ text: '帮我把下载文件夹清一下' }));
  assert.equal(got.fromId, '42');
  assert.equal(got.text, '帮我把下载文件夹清一下');
  assert.equal(got.contextToken, '42:10', '回信时要能引用这一条');
  assert.deepEqual(got.pending, []);
});

test('群里的 id 是负数 —— 别把它当"没有发送者"', () => {
  const got = normalizeUpdate(msg({ chat: { id: -1001234567890, type: 'supergroup' }, text: '在吗' }));
  assert.equal(got.fromId, '-1001234567890');
  assert.deepEqual(parseContextToken(got.contextToken), { chatId: '-1001234567890', messageId: 10 });
});

test('★ 图片：好几档分辨率里取**最大的**那张，不然模型只能看 90px 缩略图', () => {
  const got = normalizeUpdate(msg({
    photo: [
      { file_id: 'small', width: 90, height: 68, file_size: 1000 },
      { file_id: 'medium', width: 320, height: 240, file_size: 9000 },
      { file_id: 'big', width: 1280, height: 960, file_size: 120_000 },
    ],
  }));
  assert.equal(got.pending.length, 1);
  assert.equal(got.pending[0].fileId, 'big');
  assert.equal(got.pending[0].kind, 'image');
  assert.equal(got.pending[0].mime, 'image/jpeg');
  assert.equal(got.pending[0].name, 'photo-10.jpg');
});

test('图片的配文算文本（Telegram 用 caption，不是 text）', () => {
  const got = normalizeUpdate(msg({
    photo: [{ file_id: 'p', file_size: 10 }],
    caption: '这是昨天那张图',
  }));
  assert.equal(got.text, '这是昨天那张图');
  assert.equal(got.pending.length, 1);
});

test('文件：用发送方给的文件名和 MIME', () => {
  const got = normalizeUpdate(msg({
    document: { file_id: 'd1', file_name: '季度报表.xlsx', mime_type: 'application/vnd.ms-excel', file_size: 2048 },
  }));
  assert.equal(got.text, undefined, '纯附件消息没有文本');
  assert.deepEqual(got.pending[0], {
    fileId: 'd1', name: '季度报表.xlsx', mime: 'application/vnd.ms-excel', kind: 'file', size: 2048,
  });
});

test('★ 恶意文件名：`../../` 一律切掉，只留基名（Windows 的反斜杠也切）', () => {
  assert.equal(safeName('../../etc/passwd', 'x'), 'passwd');
  assert.equal(safeName('..\\..\\Windows\\system32\\evil.dll', 'x'), 'evil.dll');
  assert.equal(safeName('a/b/c.txt', 'x'), 'c.txt');
  assert.equal(safeName('', 'fallback.txt'), 'fallback.txt');
  assert.equal(safeName('..', 'fallback.txt'), 'fallback.txt');
  assert.equal(safeName('a\u0000b\n.txt', 'x'), 'a_b_.txt', '控制字符换掉');

  const got = normalizeUpdate(msg({ document: { file_id: 'd', file_name: '../../../.ssh/authorized_keys' } }));
  assert.equal(got.pending[0].name, 'authorized_keys', '落到 inbox 里也只能是这个名字');
});

test('语音：Telegram 不转写，所以只能把音频本身交出去（不编造文本）', () => {
  const got = normalizeUpdate(msg({ voice: { file_id: 'v1', duration: 3, mime_type: 'audio/ogg', file_size: 5000 } }));
  assert.equal(got.text, undefined, '没有文本就是没有，不许假装听懂了');
  assert.equal(got.pending[0].kind, 'voice');
  assert.equal(got.pending[0].name, 'voice-10.ogg');
});

test('视频和贴纸也算附件', () => {
  const v = normalizeUpdate(msg({ video: { file_id: 'vid', mime_type: 'video/mp4', file_size: 999 } }));
  assert.equal(v.pending[0].kind, 'video');
  const s = normalizeUpdate(msg({ sticker: { file_id: 'st', file_size: 20 } }));
  assert.equal(s.pending[0].kind, 'image');
  assert.equal(s.pending[0].mime, 'image/webp');
});

test('编辑过的消息不是新消息（当新消息处理会把同一件事干两遍）', () => {
  assert.equal(normalizeUpdate({ update_id: 2, edited_message: { message_id: 9, chat: { id: 1 }, text: '改一下' } }), null);
});

test('频道的帖子、进群通知这些噪音一律返回 null（不是抛错）', () => {
  assert.equal(normalizeUpdate({ update_id: 3, channel_post: { message_id: 1, chat: { id: -5 }, text: '广播' } }), null);
  assert.equal(normalizeUpdate({ update_id: 4 }), null);
  assert.equal(normalizeUpdate(undefined), null);
  assert.equal(normalizeUpdate({ update_id: 5, message: { message_id: 1, chat: {}, text: 'x' } }), null, '没有 chat id');
  assert.equal(normalizeUpdate({ update_id: 6, message: { message_id: 1, chat: { id: 1 } } }), null, '既没字也没附件');
});

test('★ 用户引用了某句话：走 quote 字段，**不并进正文**（并进去会让引用里的 @设备 生效）', () => {
  const got = normalizeUpdate(msg({
    text: '@家里那台 再发一次',
    reply_to_message: { message_id: 5, chat: { id: 42 }, text: '@别的设备 你好' },
  }));
  assert.equal(got.text, '@家里那台 再发一次', '正文只有用户这次说的话');
  assert.equal(got.quote, '@别的设备 你好', '引用单独一个字段 —— 路由只看正文，agent 两个都看得到');
});

test('引用原样带出去，不截断（它是给 agent 的上下文，不是显示给用户看的一行）', () => {
  const long = '这是一句很长的话'.repeat(10);
  const got = normalizeUpdate(msg({ text: '就这个', reply_to_message: { message_id: 5, chat: { id: 42 }, text: long } }));
  assert.equal(got.quote, long);
  assert.ok(!got.text.includes('↩'), '正文里不该有引用装饰 —— 那是出站的事');
});

test('引用的是图片/文件（没有文字）：也得说清楚引的是什么', () => {
  const got = normalizeUpdate(msg({
    text: '这张是去年的',
    reply_to_message: { message_id: 5, chat: { id: 42 }, photo: [{ file_id: 'p' }] },
  }));
  assert.equal(got.text, '这张是去年的');
  assert.equal(got.quote, '[图片]', '媒体描述用 seam 的统一写法（和微信那侧逐字一致）');
  assert.equal(got.quote, quotedMedia('image'));

  // 有文件名的必须带上 —— "回的是哪个文件"才是用户想问的
  const doc = normalizeUpdate(msg({
    text: '看这个',
    reply_to_message: { message_id: 5, chat: { id: 42 }, document: { file_id: 'd', file_name: '季度报表.xlsx' } },
  }));
  assert.equal(doc.quote, '[文件（季度报表.xlsx）]');
});

test('全是空白的文本等于没有文本 —— 但"只有引用、没说话"是内容，得交上去', () => {
  assert.equal(normalizeUpdate(msg({ text: '   \n  ' })), null, '没字、没附件、没引用 = 真·空消息');

  // 用户引用某句话、自己一个字没打：他是在**指着**那句话，那是内容。
  // （以前引用拼在正文里，"光引用不说话"确实处理不了；现在它是独立字段。
  //   微信那条通道也一样交上去 —— 同一件事两个通道不许有两种答案。）
  const only = normalizeUpdate(msg({ reply_to_message: { message_id: 5, chat: { id: 42 }, text: '引用' } }));
  assert.equal(only.text, undefined, '他没说话，正文就是空的');
  assert.equal(only.quote, '引用', '但他指着的那句要交上去');
  assert.equal(only.contextToken, '42:10', '回话的凭据照旧');
});

test('contextToken 的解：带 message id 就解出来，不带就当一个整体', () => {
  assert.deepEqual(parseContextToken('42:10'), { chatId: '42', messageId: 10 });
  assert.deepEqual(parseContextToken('42'), { chatId: '42' });
  assert.deepEqual(parseContextToken(''), { chatId: '' });
  assert.deepEqual(parseContextToken(undefined), { chatId: '' });
  assert.deepEqual(parseContextToken('42:abc'), { chatId: '42:abc' }, '解不出 id 就整个当 chat id，别猜');
  assert.deepEqual(parseContextToken('42:0'), { chatId: '42:0' }, '0 不是合法的 message id');
});
