/**
 * 适配器本体：把官方通道折成 `ctx.channel` 那一层。
 *
 * 边界假在"官方通道的接口"上（理由见 fake-lark.mjs 的文件头）。
 *
 * @module @butler/channel-feishu/test/plugin
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeFeishu, normalized } from './fake-lark.mjs';

/** 让 void 出去的异步处理跑完（`handleIncoming` 里有一次取引用的 await） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const freshHome = () => mkdtempSync(join(tmpdir(), 'butler-feishu-'));

test('凭据没填时拒绝上线，并且说的是"去哪拿"而不是"appId is required"', async () => {
  const { channel } = makeFeishu({ appId: '', appSecret: '' });
  await assert.rejects(() => channel.start(), /butler run/);
});

test('上线：先订阅再连（连上后立刻到达的消息不能漏），且重复调用不起第二条连接', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();
  assert.equal(fake.connected, true);
  assert.equal(fake.subscribed, true, 'connect 之前就必须已经订阅');

  // 幂等：起两条长连接会让飞书在集群里随机挑一条投递，表现是"消息偶尔不回"
  const before = fake.handlers.get('message').size;
  await channel.start();
  assert.equal(fake.handlers.get('message').size, before);
});

test('一条消息真的走到消费者手里（接缝那 5 个方法通了）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.emit(normalized({ content: '把下载文件夹清了' }));
  await settle();

  assert.equal(got.length, 1);
  assert.equal(got[0].channel, 'feishu');
  assert.equal(got[0].fromId, 'ou_alice');
  assert.equal(got[0].text, '把下载文件夹清了');
  // contextToken 里带着"回哪个会话、回哪句话" —— 发回复时要靠它
  assert.deepEqual(JSON.parse(got[0].contextToken), { chatId: 'oc_chat', messageId: 'om_1' });
});

test('同一条 messageId 只送一次 —— 飞书是"至少一次"投递，重推会真的来', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  const msg = normalized({ messageId: 'om_dup', content: '删掉临时文件' });
  fake.emit(msg);
  fake.emit(msg); // 官方文档：即使成功接收仍会收到重复消息
  fake.emit(normalized({ messageId: 'om_dup', content: '删掉临时文件' }));
  await settle();

  assert.equal(got.length, 1, '重复投递必须被拦住，否则那句"删掉"会被执行三遍');
});

test('去重跨重启也成立（内存去重在几小时后的重推面前是空的）', async () => {
  const home = freshHome();
  const first = makeFeishu({ home });
  await first.channel.start();
  first.fake.emit(normalized({ messageId: 'om_across', content: '清空回收站' }));
  await settle();

  // 新进程：新的实例、新的内存，同一份 home
  const second = makeFeishu({ home });
  await second.channel.start();
  const got = [];
  second.channel.onMessage((msg) => got.push(msg));
  second.fake.emit(normalized({ messageId: 'om_across', content: '清空回收站' }));
  await settle();

  assert.equal(got.length, 0, '落盘的去重表要接住跨重启的重推');
});

test('别的机器人发的消息直接不理（两个机器人互相 @ 会刷屏）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.emit(normalized({ senderIsBot: true, content: '我是另一个机器人' }));
  await settle();

  assert.equal(got.length, 0);
});

test('回消息走原生引用回复；主动推送没有 contextToken 时发给收件人', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const token = JSON.stringify({ chatId: 'oc_chat', messageId: 'om_1' });
  const res = await channel.sendText('ou_alice', '好的', { contextToken: token });
  assert.equal(fake.replies.length, 1);
  assert.equal(fake.sent.length, 0, '有 contextToken 就不该走普通发送');
  assert.deepEqual(fake.replies[0].target, { chatId: 'oc_chat', messageId: 'om_1' });
  assert.equal(fake.replies[0].input.markdown, '好的');
  assert.equal(res.chunks, 1);

  // 主动推送（进度、将来的提醒）：没有 contextToken，退化到收件人
  await channel.sendText('ou_alice', '我还在干');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].to, 'ou_alice');
});

test('被引用的原文取得到就带上，取不到就照常送（少一段上下文好过不回）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));

  fake.fetched.set('om_old', normalized({ messageId: 'om_old', content: '第一行\n第二行' }));
  fake.emit(normalized({ messageId: 'om_q1', replyToMessageId: 'om_old', content: '照这个来' }));
  await settle();
  assert.equal(got[0].quote, '第一行 / 第二行', '引用必须是压成一行');

  fake.emit(normalized({ messageId: 'om_q2', replyToMessageId: 'om_missing', content: '还是照这个来' }));
  await settle();
  assert.equal(got[1].quote, undefined);
  assert.equal(got[1].text, '还是照这个来');
});

test('非文本消息不硬塞 text（图片/文件是下一步的事，别假装收下了）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.emit(normalized({
    messageId: 'om_img',
    rawContentType: 'image',
    content: '',
    resources: [{ type: 'image', fileKey: 'img_1' }],
  }));
  await settle();

  assert.equal(got[0].text, undefined);
});

test('文件超过飞书上限时给一句人话，而不是让官方包报一个看不懂的错', async () => {
  const { channel } = makeFeishu({ home: freshHome() });
  await channel.start();

  // 稀疏文件：报大小但不吃磁盘
  const big = join(freshHome(), 'big.bin');
  writeFileSync(big, '');
  truncateSync(big, 31 * 1024 * 1024);

  await assert.rejects(() => channel.sendFile('ou_alice', big), /飞书收不下/);
  await assert.rejects(() => channel.sendFile('ou_alice', join(freshHome(), '没有这个文件')), /读不到/);
});

test('stop() 在没 start 过时也能调（doctor、卸载、启动失败回滚都会调到）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.stop();
  assert.equal(fake.connected, false);

  await channel.start();
  await channel.stop();
  assert.equal(fake.connected, false);
  assert.equal(fake.subscribed, false, '停掉之后不该还挂着订阅');
});

test('自检：没凭据时说清怎么拿，有凭据时不假装探过活', async () => {
  const { channel } = makeFeishu({ appId: '', appSecret: '', home: freshHome() });
  const bad = await channel.check();
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].fix, /butler run/);

  const { channel: ok, fake } = makeFeishu({ home: freshHome() });
  const before = await ok.check();
  assert.equal(before[0].ok, true);
  assert.match(before[0].detail, /没探活/, 'doctor 不做重活，就别假装做了');

  await ok.start();
  const after = await ok.check();
  assert.match(after[0].detail, new RegExp(fake.identity.name));
});

// ───────────────────────── M-b：入站附件落盘 ─────────────────────────

test('★ 收到图片：真落到本机，接缝要的那几项都对', async () => {
  const home = freshHome();
  const { channel, fake } = makeFeishu({ home });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.downloadContentType = 'image/png';
  fake.downloadBytes = Buffer.from('假装这是一张图');
  fake.emit(normalized({
    content: '',
    rawContentType: 'image',
    resources: [{ type: 'image', fileKey: 'file_v2_abc', fileName: '截图.png' }],
  }));
  await settle();

  assert.equal(fake.downloads.length, 1);
  assert.equal(fake.downloads[0].messageId, 'om_1', '下载要拿这条消息的 id 去换资源');
  assert.equal(fake.downloads[0].type, 'image', '图片走 image 那条下载路');

  const files = got[0].files;
  assert.equal(files.length, 1);
  const f = files[0];
  // 接缝的硬要求：拿到它的时候，这个路径已经是**一个能读的真实文件**
  assert.ok(existsSync(f.path), 'path 必须已经可读');
  assert.ok(f.path.startsWith(join(home, 'state', 'files', 'feishu')), '落到管家目录下的收件箱');
  assert.equal(f.name, '截图.png');
  assert.equal(f.kind, 'image');
  assert.equal(f.mime, 'image/png');
  assert.equal(f.size, fake.downloadBytes.length);
  // 纯附件消息没有正文 —— 核心层会用"看看是什么"那类默认提示词，不用我们编
  assert.equal(got[0].text, undefined);
});

test('★ 一个附件下载失败：消息照走，正文一个字都不丢', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.downloadFails = 'permission denied: im:resource';
  fake.emit(normalized({
    content: '看下这个报价',
    resources: [{ type: 'file', fileKey: 'k', fileName: '报价.pdf' }],
  }));
  await settle();

  // 少一个附件是遗憾，整条消息不回是事故
  assert.equal(got.length, 1);
  assert.equal(got[0].text, '看下这个报价');
  assert.equal(got[0].files, undefined);
});

test('★ 附件超过上限：不交给 agent，而且不留在收件箱里', async () => {
  const home = freshHome();
  // 上限设成 ~10 字节，下面那个 64 字节的附件必然超
  const { channel, fake } = makeFeishu({ home, maxFileMb: 0.00001 });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.downloadBytes = Buffer.alloc(64, 1);
  fake.emit(normalized({
    content: '',
    rawContentType: 'file',
    resources: [{ type: 'file', fileKey: 'k', fileName: '大文件.bin' }],
  }));
  await settle();

  assert.equal(got.length, 1, '消息本身还是要走的');
  assert.equal(got[0].files, undefined, '太大的不能交出去（agent 多半会整个读进上下文）');
  assert.deepEqual(readdirSync(join(home, 'state', 'files', 'feishu')), [], '落了盘发现太大，要删掉');
});
