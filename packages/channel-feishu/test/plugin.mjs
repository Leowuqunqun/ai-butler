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

test('凭据没填时拒绝上线，说的是"去哪拿"和"我去哪找过"，而不是"appId is required"', async () => {
  const home = freshHome();
  const { channel } = makeFeishu({ appId: '', appSecret: '', home });
  await assert.rejects(() => channel.start(), (error) => {
    assert.match(error.message, /butler run/, '要告诉他怎么拿');
    // 也要说清**去哪儿找过**：最常见的原因是凭据存到了另一个管家目录（用了 --config）
    assert.ok(error.message.includes(join(home, 'state', 'secrets.json')), `要说清找过哪儿，实际：${error.message}`);
    assert.match(error.message, /--home=/, '要点出那个最常见的坑');
    return true;
  });
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

test('自检：没凭据时说清怎么拿；有凭据时**真探一次活**', async () => {
  const { channel } = makeFeishu({ appId: '', appSecret: '', home: freshHome() });
  const bad = await channel.check();
  assert.equal(bad[0].ok, false);
  assert.match(bad[0].fix, /butler run/);

  // 探活走 REST（getAppInfo），所以**不用先 start** 就能验凭据 —— 这正是 doctor 要的：
  // 什么都没启动的时候，回答"这串凭据到底对不对"
  const { channel: ok, fake } = makeFeishu({ home: freshHome() });
  const got = await ok.check();
  assert.equal(got[0].ok, true);
  assert.match(got[0].detail, new RegExp(fake.appInfo.appName), '要说清是哪个应用');
});

test('★ 自检被拒时给两种可能，而且**绝不吐出那个一次性授权链接**', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  fake.appInfoFails = 'permission denied';
  fake.appInfoContext = { consoleUrl: 'https://open.feishu.cn/one-click?sign=SECRET-TOKEN' };

  const out = await channel.check(); // 接缝规矩：check 不许抛
  assert.equal(out[0].ok, false);
  assert.match(out[0].detail, /permission denied/, '把事实（code / message）如实报出来');
  assert.match(out[0].fix, /缺权限/);
  assert.match(out[0].fix, /凭据不属于这个应用/);

  // `context.consoleUrl` 是**签了名的一次性授权链接** —— 官方类型声明里写明
  // "是凭据，别写进日志 / 工单 / 聊天"。所以自检输出里一个字都不许有
  const all = JSON.stringify(out);
  assert.ok(!all.includes('SECRET-TOKEN'), '授权链接是凭据，不许出现在自检输出里');
  assert.ok(!all.includes('consoleUrl'), '连字段名都不带出来');
});

test('自检：探活超时就如实说，不许挂着不动', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome(), checkTimeoutMs: 5 });
  fake.appInfoHangs = true;
  const out = await channel.check();
  assert.equal(out[0].ok, false);
  assert.match(out[0].detail, /超过 5 毫秒/);
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

test('★ 去重表写不进去时，宁可漏一次去重，也不能把消息吞了', async () => {
  const home = freshHome();
  // 让落盘必失败：把 `state` 这个"目录"做成一个普通文件（只读挂载、磁盘满也是同一形状）
  writeFileSync(join(home, 'state'), 'not a directory');

  const { channel, fake } = makeFeishu({ home });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg.text));
  fake.emit(normalized({ content: '写不进去也得让我收到' }));
  await settle();

  // 去重是保护，投递才是本职。写不进去时内存里那张表还在管事，只是跨重启那层没了 ——
  // 而这种时候把整条消息吞掉，用户看到的是"发了没反应"，比偶发重复糟得多。
  assert.deepEqual(got, ['写不进去也得让我收到'], '去重表坏了是遗憾，消息被吞是事故');
});

test('★ 处理链自己抛错，不会变成 unhandled rejection（下一条照收）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const got = [];
  channel.onMessage((msg) => got.push(msg.text));
  // 消费者的 bug 由接缝兜（它只接同步抛错）；这里要证的是**处理链自己**漏出去的异常
  // 也有落点 —— 漏出去会变成 unhandled rejection，而 Node 默认把它升级成进程退出。
  fake.emit(normalized({ content: '第一条' }));
  await settle();
  fake.emit(normalized({ content: '第二条', messageId: 'om_2' }));
  await settle();

  assert.deepEqual(got, ['第一条', '第二条'], '一条出错不该影响下一条');
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
