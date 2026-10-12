/**
 * Telegram 通道的插件级测试 —— 真 HTTP、真 cordis 容器、真落盘。
 *
 *   node --test test/plugin.mjs
 *
 * 全部离线：`startFakeTelegram()` 起一个只监听 127.0.0.1 的假 Bot API。
 * 这里不碰真 Telegram、不联网、不弹任何东西。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FAKE_TOKEN, FILE_BODY, startFakeTelegram } from './fake-telegram.mjs';
import { chunkText } from '../lib/index.js';
import TelegramChannel from '../lib/index.js';

/** 起一个装好通道的容器 + 一个假服务器。**不 start** —— 由用例决定什么时候上线 */
async function boot(t, cfg = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tg-'));
  const fake = await startFakeTelegram();
  const ctx = new Context();
  const received = [];
  await ctx.plugin(TelegramChannel, {
    botToken: FAKE_TOKEN,
    home,
    baseUrl: fake.url,
    pollTimeoutSec: 1,
    ...cfg,
  });
  ctx.channel.onMessage((m) => received.push(m));

  t.after(async () => {
    await ctx.channel.stop().catch(() => {});
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { ctx, fake, received, home };
}

/** 等到某件事发生，或者超时（超时 = 用例失败，不是"等久一点"） */
async function waitFor(fn, ms = 4000, what = '条件') {
  const until = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) throw new Error(`等了 ${ms}ms，${what}还是没发生`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('★ 装上容器：它就成了 ctx.channel（这就是 seam 的全部要求）', async (t) => {
  const { ctx } = await boot(t);
  assert.equal(ctx.channel.id, 'telegram');
  assert.ok(ctx.channel instanceof TelegramChannel);
});

test('没填 token：start() 说一句人话（含去哪拿），check() 早就提示过', async (t) => {
  const { ctx } = await boot(t, { botToken: '' });

  const checks = await ctx.channel.check();
  assert.equal(checks[0].ok, false);
  assert.match(checks[0].fix, /BotFather/, '要告诉他去哪拿 token');

  await assert.rejects(
    async () => { await ctx.channel.start(); },
    (e) => {
      assert.match(e.message, /bot token/);
      assert.match(e.message, /BotFather/, '错误里也要有出路');
      assert.doesNotMatch(e.message, /botToken is required|required/, '别把校验器的原话抛给用户');
      return true;
    },
  );
});

test('填了 token：check() 是绿的（现在会真去问一句"我是谁"，所以对着假服务器问）', async (t) => {
  const { ctx } = await boot(t);
  const checks = await ctx.channel.check();
  assert.equal(checks.find((c) => c.name === 'Telegram 登录态').ok, true);
});

test('★ 收一条文本：谁说的、说什么、回哪一条，都对', async (t) => {
  const { ctx, fake, received } = await boot(t);
  await ctx.channel.start();

  fake.push({ message: { message_id: 10, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '把下载文件夹清一下' } });
  const got = await waitFor(() => received[0], 4000, '收到消息');

  assert.equal(got.channel, 'telegram');
  assert.equal(got.fromId, '42');
  assert.equal(got.text, '把下载文件夹清一下');
  assert.equal(got.contextToken, '42:10');
  assert.ok(got.raw, 'raw 是逃生舱，得原样带上');
  assert.equal(got.files, undefined, '没有附件就别给个空数组');
});

test('★ 收一张图片：真的落到本机、字节和服务端一致、权限 0600', async (t) => {
  const { ctx, fake, received, home } = await boot(t);
  await ctx.channel.start();

  fake.push({ message: { message_id: 11, chat: { id: 42 }, photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: FILE_BODY.length }] } });
  const got = await waitFor(() => received[0], 4000, '收到图片');

  assert.equal(got.files.length, 1);
  const f = got.files[0];
  assert.equal(f.kind, 'image');
  assert.equal(f.size, FILE_BODY.length);
  assert.ok(f.path.startsWith(join(home, 'inbox')), `附件该落在 inbox 里：${f.path}`);
  assert.deepEqual(readFileSync(f.path), FILE_BODY, '落盘的字节要和服务器上的一模一样');
  assert.equal(statSync(f.path).mode & 0o777, 0o600, '用户让管家收的文件可能是私人的');
});

test('★ offset 落盘：重启之后从"读到哪"接着读，不重放', async (t) => {
  const { ctx, fake, home, received } = await boot(t);
  await ctx.channel.start();
  fake.push({ message: { message_id: 20, chat: { id: 7 }, text: '第一句' } });
  await waitFor(() => received.length === 1, 4000, '收到第一条');

  const file = join(home, 'state', 'telegram.json');
  await waitFor(() => existsSync(file), 2000, 'offset 文件出现');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.offset, 2, '收到 update_id=1 之后该记 2');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  await ctx.channel.stop();
  // 再起一次：服务器会看到我们从 2 开始要
  const before = fake.state.requests.filter((r) => r.path.endsWith('/getUpdates')).length;
  await ctx.channel.start();
  await waitFor(() => fake.state.requests.filter((r) => r.path.endsWith('/getUpdates')).length > before, 3000, '轮询重新开始');

  const last = JSON.parse(fake.state.requests.filter((r) => r.path.endsWith('/getUpdates')).pop().body.toString());
  assert.equal(last.offset, 2, '接着上次的地方读，而不是从头');
  assert.equal(received.length, 1, '旧的不能重放');
});

test('★ 没有 offset 记录时跳过积压 —— 宁可漏几条，也不能把昨天的"清空"再执行一遍', async (t) => {
  const { ctx, fake, received } = await boot(t);
  // 服务器上堆着三条"历史消息"（上次退出之后、这次启动之前用户说的）
  for (const i of [1, 2, 3]) {
    fake.push({ update_id: i, message: { message_id: i, chat: { id: 42 }, text: `旧命令 ${i}` } });
  }

  await ctx.channel.start();
  await new Promise((r) => setTimeout(r, 300)); // 给它足够时间去（错误地）收下这些
  assert.equal(received.length, 0, '历史消息一条都不许重放');

  // 但"现在说的话"必须收到
  fake.push({ update_id: 4, message: { message_id: 4, chat: { id: 42 }, text: '这是新的' } });
  const got = await waitFor(() => received[0], 4000, '收到新消息');
  assert.equal(got.text, '这是新的');
});

test('★ stop() 要能立刻掐断挂着的长轮询（不许等它自己超时）', async (t) => {
  const { ctx, fake } = await boot(t, { pollTimeoutSec: 25 });
  fake.hang(); // 服务器永不回话
  await ctx.channel.start();
  await waitFor(() => fake.state.waiting.length > 0, 3000, '长轮询挂上');

  const t0 = Date.now();
  await ctx.channel.stop();
  const spent = Date.now() - t0;
  assert.ok(spent < 2000, `stop() 花了 ${spent}ms —— 它在等长轮询，而不是掐断它`);
});

test('start() 幂等：调两次不会出现两个轮询在偷对方的消息', async (t) => {
  const { ctx, fake } = await boot(t, { pollTimeoutSec: 25 });
  await ctx.channel.start();
  await ctx.channel.start();
  await waitFor(() => fake.state.waiting.length > 0, 3000, '长轮询挂上');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(fake.state.waiting.length <= 1, `服务器上挂着 ${fake.state.waiting.length} 个长轮询，说明起了两个循环`);
});

test('★ 超长文本切段：第一段引用原消息，后面不引用（不然满屏引用框）', async (t) => {
  const { ctx, fake } = await boot(t);
  await ctx.channel.start();

  await ctx.channel.sendText('42', 'A'.repeat(9000), { contextToken: '42:10', quote: '帮我看看这个' });
  const sent = fake.state.sent.filter((s) => s._method === 'sendMessage');
  assert.equal(sent.length, 3, '9000 字该切成 3 段');
  assert.ok(sent.every((s) => s.text.length <= 4096), '每段都不能超上限');
  assert.equal(sent[0].reply_to_message_id, 10);
  assert.equal(sent[1].reply_to_message_id, undefined);
  assert.equal(sent[2].reply_to_message_id, undefined);
  assert.equal(sent[0].chat_id, '42');
  // Telegram 有原生引用，所以文本**一个字都不该动**：
  // 以前内核替所有通道顶一行 `↩ …`，Telegram 用户会看到同一句话被引用两次。
  assert.ok(sent.every((s) => !s.text.includes('↩')), '原生引用之外不许再顶文本前缀');
});

test('★ 没有 quote 就不引用（进度提示不是"在回答某句话"）—— 这是"引用两次"的另一半', async (t) => {
  const { ctx, fake } = await boot(t);
  await ctx.channel.start();

  await ctx.channel.sendText('42', '还在处理…（已 30s）', { contextToken: '42:10' });
  await ctx.channel.sendText('42', '好了', { contextToken: '42:10', quote: '帮我看下这个' });

  const sent = fake.state.sent.filter((s) => s._method === 'sendMessage');
  assert.equal(sent[0].reply_to_message_id, undefined, '进度提示不该引用用户那句');
  assert.ok(!sent[0].text.includes('↩'), '也不该顶一行文本');
  assert.equal(sent[1].reply_to_message_id, 10, '真正的答复才引用');
});

test('★ 切段不能把 emoji 劈成两半（代理对边界）', () => {
  const one = '🙂'; // 两个 UTF-16 单元
  const chunks = chunkText(one.repeat(10), 5);
  for (const c of chunks) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), '不能以"高代理"结尾 —— 那是半个 emoji');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c), '不能以"低代理"开头');
  }
  assert.equal(chunks.join(''), one.repeat(10), '拼回去要一字不差');

  // 中文按 UTF-16 单元算长度（Telegram 就是这么算的）
  assert.deepEqual(chunkText('一二三四五', 2), ['一二', '三四', '五']);
  // 优先切在换行上（上限 5 时，第 3 个单元正好是那个换行）
  assert.deepEqual(chunkText('第一行\n第二行', 5), ['第一行', '第二行']);
  // 上限比一行还小时只能硬切 —— 但每一段都不许超
  assert.deepEqual(chunkText('第一行\n第二行', 2), ['第一', '行', '第二', '行']);
  assert.deepEqual(chunkText('', 10), []);
});

test('sendFile：图片当图片发（点开能看大图），别的当文件原样发', async (t) => {
  const { ctx, fake, home } = await boot(t);
  await ctx.channel.start();

  const pic = join(home, 'a.png');
  writeFileSync(pic, FILE_BODY);
  const doc = join(home, '报表.txt');
  writeFileSync(doc, FILE_BODY);

  const r1 = await ctx.channel.sendFile('42', pic);
  const r2 = await ctx.channel.sendFile('42', doc, { caption: '你要的报表' });

  assert.equal(fake.state.uploads[0].method, 'sendPhoto');
  assert.equal(fake.state.uploads[1].method, 'sendDocument');
  for (const up of fake.state.uploads) {
    assert.match(up.contentType, /^multipart\/form-data; boundary=/, '真的发了 multipart');
    assert.match(up.raw, /name="chat_id"/);
    assert.match(up.raw, /42/);
    assert.ok(!up.raw.includes('reply_to_message_id'), '没传 quote 就不引用（进度/配文不是答复）');
  }

  // ★ 附件也是答复的一部分：传了 quote，文件就挂成那条消息的原生引用回复
  //   （和文本一条规则 —— `SendOpts.quote` 不该只在 sendText 上有意义）
  await ctx.channel.sendFile('42', doc, { contextToken: '42:77', quote: '把报表发我' });
  const quoted = fake.state.uploads.at(-1);
  assert.match(quoted.raw, /name="reply_to_message_id"/);
  assert.match(quoted.raw, /77/);

  // 光有 quote 不够：解不出消息号就只能不引用（不硬编一个假 id）
  await ctx.channel.sendFile('42', doc, { quote: '把报表发我' });
  const noId = fake.state.uploads.at(-1);
  assert.ok(!noId.raw.includes('reply_to_message_id'), '没有消息号就没法引用，宁可不说');
  assert.match(fake.state.uploads[1].raw, /你要的报表/, '配文要带上');
  assert.match(fake.state.uploads[1].raw, /报表\.txt/, '文件名要给对，不然对方看到一串随机数');
  assert.ok(fake.state.uploads[1].raw.includes(FILE_BODY.toString('utf8')), '文件字节要在 multipart 里');
  assert.equal(r1.fileName, 'a.png');
  assert.equal(r2.size, FILE_BODY.length);
});

test('sendFile：文件不在的时候给一句人话，而不是 ENOENT', async (t) => {
  const { ctx } = await boot(t);
  await ctx.channel.start();
  await assert.rejects(
    async () => { await ctx.channel.sendFile('42', '/definitely/not/here.txt'); },
    (e) => {
      assert.match(e.message, /找不到了/);
      assert.doesNotMatch(e.message, /ENOENT/);
      return true;
    },
  );
});

test('allowFrom：不在名单里的会话，理都不理', async (t) => {
  const { ctx, fake, received } = await boot(t, { allowFrom: ['999'] });
  await ctx.channel.start();

  fake.push({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: '陌生人' } });
  fake.push({ update_id: 2, message: { message_id: 2, chat: { id: 999 }, text: '自己人' } });

  const got = await waitFor(() => received[0], 4000, '收到消息');
  assert.equal(got.text, '自己人');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(received.length, 1, '陌生人那条不该被交上去');
});

test('★ 超大附件：不下载，但要在消息里说明一句（不然用户以为管家没看见）', async (t) => {
  const { ctx, fake, received } = await boot(t, { maxMediaBytes: 4 });
  await ctx.channel.start();

  fake.push({ message: { message_id: 12, chat: { id: 42 }, document: { file_id: 'huge', file_name: '大文件.zip', file_size: 999_999_999 } } });
  const got = await waitFor(() => received[0], 4000, '收到消息');

  assert.equal(got.files, undefined);
  assert.match(got.text, /超过上限/, '得说清楚为什么没拿到');
  assert.ok(!fake.state.requests.some((r) => r.path.endsWith('/getFile')), '既然太大了就不该去问路径');
});

test('setTyping：发得出去就发，发不出去也不许影响回复', async (t) => {
  const { ctx, fake } = await boot(t);
  await ctx.channel.start();

  await ctx.channel.setTyping('42', true, { contextToken: '42:10' });
  assert.equal(fake.state.sent.filter((s) => s._method === 'sendChatAction').length, 1);

  await ctx.channel.setTyping('42', false); // 关掉没有对应的 API，静默即可
  assert.equal(fake.state.sent.filter((s) => s._method === 'sendChatAction').length, 1);
});

test('★ 出了 409（有人抢同一个 token）：不崩、不刷屏，恢复之后还能收信', async (t) => {
  const { ctx, fake, received } = await boot(t);
  await ctx.channel.start();
  // 注入放在 start() 之后：start 里的 getMe 不该被这条错误吃掉
  fake.failOnce(409);

  fake.push({ message: { message_id: 30, chat: { id: 42 }, text: '还在吗' } });
  const got = await waitFor(() => received[0], 5000, '收到消息（说明它退避之后又试了）');
  assert.equal(got.text, '还在吗');
});

test('stop() 之后再 start() 还能用（不是一次性的）', async (t) => {
  const { ctx, fake, received } = await boot(t);
  await ctx.channel.start();
  await ctx.channel.stop();
  await ctx.channel.start();

  fake.push({ message: { message_id: 40, chat: { id: 42 }, text: '重启之后' } });
  const got = await waitFor(() => received[0], 4000, '收到消息');
  assert.equal(got.text, '重启之后');
});

test('offset 文件坏了（半个 JSON）：当作没有记录，去跳过积压而不是从头重放', async (t) => {
  const { ctx, fake, received, home } = await boot(t);
  const file = join(home, 'state', 'telegram.json');
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(file, '{ "offset": 12');

  fake.push({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: '旧命令' } });
  await ctx.channel.start();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(received.length, 0, '坏文件不能变成"从头重放"');
});

// ─────────────────── 自检里的 token 验证（doctor 靠它说真话）───────────────────

test('★ 自检：token 好使 —— 真去问一句"我是谁"，把机器人名字说出来', async (t) => {
  const b = await boot(t);
  const checks = await b.ctx.channel.check();
  const tg = checks.find((c) => c.name === 'Telegram 登录态');
  assert.equal(tg.ok, true);
  assert.match(tg.detail, /@butler_test_bot/, '连上了就该说清是哪个机器人');
});

test('★ 自检：token 被拒（401）—— 判 ✗，并且给出 `--again` 这条出路', async (t) => {
  // 假服务器只认 FAKE_TOKEN，别的都回 401 —— 正是"在 @BotFather 那边 revoke 过"的样子
  const b = await boot(t, { botToken: '123456:REVOKED' });
  const checks = await b.ctx.channel.check();
  const tg = checks.find((c) => c.name === 'Telegram 登录态');
  assert.equal(tg.ok, false, '作废的 token 必须报 ✗ —— 这正是"昨天还好好的今天不回消息"的原因');
  assert.match(tg.detail, /不认|token/, '要说人话，不是 errno');
  assert.match(tg.fix, /--again/, '出路要点名那条命令');
});

test('★ 自检：连不上 Telegram —— 说"这次没查"，**不报红**（网断了不是他的错）', async (t) => {
  // 指到一个没人监听的端口 = 连不上。这里不许判 ✗：否则用户会去修一个不存在的问题
  const b = await boot(t, { baseUrl: 'http://127.0.0.1:9' });
  const checks = await b.ctx.channel.check();
  const tg = checks.find((c) => c.name === 'Telegram 登录态');
  assert.equal(tg.ok, true, '连不上是"没查"，不是"token 坏了"');
  assert.match(tg.detail, /没查/);
  // 别的检查照样给出来（自检不该因为一件事查不了就整体哑掉）
  assert.ok(checks.some((c) => c.name === '取件目录'));
});
