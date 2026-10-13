/**
 * 入站附件的**纯逻辑**：名字消毒、类型翻译、落盘位置。
 *
 *   node --test test/files.mjs
 *
 * 这里全是纯函数 —— 不下载、不联网、不碰 cordis。所以它们能钉死每一件
 * "跟安全有关"的事，其中最要紧的一条：**文件名是对方给的**。
 * 对方可以随便把文件叫 `../../.ssh/authorized_keys`，那种名字必须死在消毒函数里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { destFor, downloadTypeOf, guessMime, kindOf, sanitizeName } from '../lib/files.js';

test('★ 文件名消毒：路径分隔符活不下来，`..` 也翻不出收件箱', () => {
  const evil = sanitizeName('../../.ssh/authorized_keys');
  assert.ok(!evil.includes('/'), '不能留分隔符');
  assert.ok(!evil.includes('\\'), '反斜杠也不行（Windows 上那是分隔符）');
  assert.ok(!evil.startsWith('.'), '不能在收件箱里造出隐藏文件');

  // 真正要保证的是**这条性质**，而不是某个具体的替换结果：
  // 拼出来的路径必须还在收件箱里面
  const { path } = destFor('/inbox', { type: 'file', fileKey: 'k', fileName: '../../.ssh/authorized_keys' });
  assert.ok(path.startsWith('/inbox/'), `落盘路径必须在收件箱里，实际 ${path}`);
  assert.ok(!path.split('/').includes('..'), '路径里不能出现上跳段');
});

test('文件名消毒：中文名保住，空白换成下划线，超长的截断', () => {
  assert.equal(sanitizeName('会议纪要 2026.pdf'), '会议纪要_2026.pdf');
  assert.equal(sanitizeName('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt');
  assert.equal(sanitizeName('x'.repeat(200)).length, 120);
  assert.equal(sanitizeName(undefined), '');
  assert.equal(sanitizeName('.hidden'), 'hidden');
});

test('类型翻译：飞书叫 audio，接缝叫 voice；下载只有 image / file 两条路', () => {
  assert.equal(kindOf('image'), 'image');
  assert.equal(kindOf('video'), 'video');
  assert.equal(kindOf('audio'), 'voice');
  assert.equal(kindOf('sticker'), 'image');
  assert.equal(kindOf('file'), 'file');

  // 官方类型定义就是 `type ResourceType = 'image' | 'file'` —— 别的都得走 file
  assert.equal(downloadTypeOf('image'), 'image');
  for (const t of ['file', 'audio', 'video', 'sticker']) {
    assert.equal(downloadTypeOf(t), 'file', `${t} 要走 file`);
  }
});

test('MIME：服务器说的优先，它没说才按扩展名猜', () => {
  assert.equal(guessMime('a.bin', 'image/png'), 'image/png', '服务器说的更可信');
  assert.equal(guessMime('a.png'), 'image/png');
  assert.equal(guessMime('会议.opus'), 'audio/opus');
  assert.equal(guessMime('没后缀'), 'application/octet-stream');
  assert.equal(guessMime('a.png', 'application/octet-stream'), 'image/png',
    '官方包的兜底值没有信息量，要让扩展名说话');
  assert.equal(guessMime('a.png', 'IMAGE/PNG; charset=utf-8'), 'image/png', '大小写和参数都要处理');
});

test('落盘位置：时间戳在前（可排序、不撞名），没后缀就按类型补一个', () => {
  const at = Date.UTC(2026, 0, 2, 3, 4, 5);
  const a = destFor('/inbox', { type: 'image', fileKey: 'k', fileName: '照片.jpg' }, at);
  assert.match(a.path, /^\/inbox\/2026-01-02T03-04-05/);
  assert.ok(a.path.endsWith('-照片.jpg'));
  assert.equal(a.name, '照片.jpg');

  const b = destFor('/inbox', { type: 'image', fileKey: 'k', fileName: '没后缀' }, at);
  assert.ok(b.path.endsWith('.jpg'), '图片没后缀要补 .jpg');

  const c = destFor('/inbox', { type: 'audio', fileKey: 'k' }, at);
  assert.ok(c.path.endsWith('.opus'), '飞书的语音是 OPUS');

  // 同一条消息里两张都叫 image.jpg 的图，靠时间戳区分 ✗ 靠 fileKey 不行
  const d1 = destFor('/inbox', { type: 'image', fileKey: 'k1', fileName: 'image.jpg' }, at);
  const d2 = destFor('/inbox', { type: 'image', fileKey: 'k2', fileName: 'image.jpg' }, at + 1000);
  assert.notEqual(d1.path, d2.path);
});
