/**
 * 适配器本体：把官方通道折成 `ctx.channel` 那一层。
 *
 * 边界假在"官方通道的接口"上（理由见 fake-lark.mjs 的文件头）。
 *
 * @module @butler/channel-feishu/test/plugin
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { makeFeishu, normalized } from './fake-lark.mjs';
import { FeishuChannel } from '../lib/index.js';

/** 让 void 出去的异步处理跑完（`handleIncoming` 里有一次取引用的 await） */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const freshHome = () => mkdtempSync(join(tmpdir(), 'butler-feishu-'));

/** 把每一次日志调用记下来的假 logger（形状和 Cordis 的一样：格式串 + 参数） */
function spyLogger() {
  const got = [];
  const at = (level) => (...args) => got.push([level, ...args]);
  return { got, log: { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') } };
}

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

test('附件承载的类型不硬塞 text（图片的信息在附件上；其余类型的正文必须带上，见第 18 轮）', async () => {
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

/**
 * 话题群 / 线程：我们**必须**把 `threadId` 传下去 —— 官方就是靠它决定要不要 `reply_in_thread`：
 *
 *     reply(msg, input, opts) {
 *       return this.send(msg.chatId, input, {
 *         ...opts,
 *         replyTo: opts?.replyTo ?? msg.messageId,
 *         replyInThread: opts?.replyInThread ?? Boolean(msg.threadId),
 *       });
 *     }
 *
 * （这条是读官方实现记下来的，同一条也记在 `test/policy.mjs` 开头。）
 * 少了它，话题里的回复会**落到话题外面**；凭空多一个，普通群里每条回复都会被开成一朵话题。
 *
 * 反向（没有话题时不能凭空造）已由上面那句 `deepEqual(fake.replies[0].target, {…})` 钉着：
 * 我们是用 `...(ctx.threadId ? { threadId } : {})` 省掉那个键的，凭空加键会让它红。
 */
test('★ 话题里的消息，回文本和回文件都要带 threadId（两处调用会各自漂移）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const token = JSON.stringify({ chatId: 'oc_topic', messageId: 'om_1', threadId: 'omt_1' });

  await channel.sendText('ou_alice', '好的', { contextToken: token });
  assert.equal(fake.replies[0].target.threadId, 'omt_1', '在话题里问的，回复要落回同一个话题');

  const file = join(freshHome(), '小文件.txt');
  writeFileSync(file, 'x');
  await channel.sendFile('ou_alice', file, { contextToken: token });
  assert.equal(fake.replies[1].target.threadId, 'omt_1', 'sendFile 那条路也要带 —— 两处调用会各自漂移');
});

/**
 * **引用回不了 ≠ 不回。**
 *
 * 最现实的触发：你把自己那条消息删了（引用目标没了）。这时官方的 `reply` 会失败，
 * 而答案是刚算出来的（可能花了几十秒）—— 丢掉它、让你干等，是这里最坏的结局：
 * 入站去重已经记过账，飞书重推也不会再试一次。
 *
 * "少一段引用，好过什么都不回" 和取不到被引原文时那条规矩是同一个取舍。
 */
test('★★ 引用回复失败就退回直接发送：答案是算出来的，不能因为引用丢了就不回', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const token = JSON.stringify({ chatId: 'oc_chat', messageId: 'om_1' });
  fake.failReply = true;

  await channel.sendText('ou_alice', '这是算了半天的答案', { contextToken: token });
  assert.equal(fake.replies.length, 1, '先试过引用回复');
  assert.equal(fake.sent.length, 1, '引用失败后必须退回直接发送 —— 不能什么都不回');
  assert.equal(fake.sent[0].to, 'oc_chat', '要发回同一个会话（你删的是那条消息，不是一个会话）');
  assert.equal(fake.sent[0].input.markdown, '这是算了半天的答案', '内容一字不改');

  const p = join(freshHome(), '答案.txt');
  writeFileSync(p, 'x');
  await channel.sendFile('ou_alice', p, { contextToken: token });
  assert.equal(fake.sent.length, 2, 'sendFile 也要退回直接发送 —— 两处调用会各自漂移');
});

test('★ 两条路都失败才往上抛（那已经不是"展示方式"的问题了，交给内核去说）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();
  fake.failReply = true;
  fake.failSend = true;

  await assert.rejects(
    () => channel.sendText('ou_alice', 'x', { contextToken: JSON.stringify({ chatId: 'oc', messageId: 'om' }) }),
    /send rejected/,
  );
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

// ─────────────── 第 60 轮：自检要说出"谁能私聊它" ───────────────

test('★ 自检里那条「谁能私聊它」：默认 open 如实说，但**不吓人**', async () => {
  // 默认 open 在企业里意味着"同公司谁都能私聊驱动机器人" —— 这是事实，要说出来；
  // 但它是**默认值**，不是错误：报成 ✗ 只会训练用户忽略自检（这是第 60 轮的分寸）。
  const { channel } = makeFeishu({ appId: '', appSecret: '', home: freshHome() });
  const line = (await channel.check()).find((c) => c.name === '飞书私聊准入');
  assert.ok(line, '自检里应当有这一行');
  assert.equal(line.ok, true, 'open 是默认，不是错误');
  assert.match(line.detail, /dmMode=open/);
  assert.match(line.detail, /谁都能私聊它/, '要如实说出它的实际含义');
});

test('★ 名单里填了应用 id（cli_…）⇒ 自检报 ✗，而且出路能照着做', async () => {
  const { channel } = makeFeishu({
    appId: '',
    appSecret: '',
    home: freshHome(),
    dmMode: 'allowlist',
    dmAllowlist: ['ou_real', 'cli_wrong'],
  });
  const line = (await channel.check()).find((c) => c.name === '飞书私聊准入');
  assert.ok(line, '自检里应当有这一行');
  assert.equal(line.ok, false, '填了 cli_ 等于谁也没放行 —— 这是确凿的配错');
  assert.match(line.detail, /1 条/, '说清有几条不对');
  assert.match(line.fix, /senderId/, '出路要指向"从探针那段 JSON 里抄 senderId"');
  assert.match(line.fix, /ou_/, '要说清要的是 ou_ 开头的那种 id');
});

test('allowlist / pair / disabled 如实描述，而且都**不**报 ✗', async () => {
  const cases = [
    ['allowlist', ['ou_a', 'ou_b'], /只有名单里的/, /名单 2 条/],
    ['pair', [], /只有配对过的/, null],
    ['disabled', [], /谁也不能私聊它/, null],
  ];
  for (const [mode, list, re, extra] of cases) {
    const { channel } = makeFeishu({
      appId: '', appSecret: '', home: freshHome(), dmMode: mode, dmAllowlist: list,
    });
    const line = (await channel.check()).find((c) => c.name === '飞书私聊准入');
    assert.ok(line, `${mode} 时也要有这一行`);
    assert.equal(line.ok, true, `${mode} 是合法配置，不该报 ✗`);
    assert.match(line.detail, re);
    if (extra) assert.match(line.detail, extra);
  }
});

test('★ 没凭据和有凭据**两条出口**都要报这一行（它跟凭据无关）', async () => {
  const empty = makeFeishu({ appId: '', appSecret: '', home: freshHome() }).channel;
  const full = makeFeishu({ home: freshHome() }).channel;
  for (const [what, ch] of [['没凭据', empty], ['有凭据', full]]) {
    const names = (await ch.check()).map((c) => c.name);
    assert.ok(names.includes('飞书私聊准入'), `${what}那条出口漏了：${JSON.stringify(names)}`);
  }
});

test('★★ 给探针出路的那几句，家不在默认位置时**每一处**都要带 --home=', async () => {
  // 第 53 轮补的。这一族已经踩过四次：
  //   · 第 35 轮修了 `check()`（没凭据那条）和 `start()`（没凭据那条）两处漏传管家目录；
  //   · 同一族里 `connectFailed` 是"第三处"（注释里点过名，补了断言）；
  //   · 第 53 轮拿假凭据真跑 `butler doctor`，家故意不在默认位置 —— 复现出**第四处**：
  //     `check()` 里"拿应用信息没成功"那条 fix 只摆两种可能，**压根没给"重扫一次"的命令**。
  // 与其再补一条针对单句的断言（下次还会有第五处），不如把**这一族**一次钉住：
  // 把插件在五种状态下会吐给用户的每一段话都拿出来，凡是给了 `smoke.mjs` 命令的，
  // 就必须带 `--home=`。
  //
  // ⚠️ 第 60 轮：加了「谁能私聊它」那条自检之后，这条守卫**差点**变成假绿 ——
  //    它原来只在 dmAllowlist 为空时收集，而那条 fix 只在 `cli_` 配错时才出现 ⇒
  //    把它写死成不带 --home= 的命令，这里**照样绿**（实测过）。所以补了下面那个 ④：
  //    "守卫的范围是假设的"本身就是一个沉默的洞。
  const home = '/tmp/别处的管家目录';   // 故意不是默认家
  const texts = [];

  // ① 还没填凭据：check + start 各一句
  const empty = makeFeishu({ appId: '', appSecret: '', home });
  for (const c of await empty.channel.check()) texts.push(c.detail ?? '', c.fix ?? '');
  texts.push(String((await empty.channel.start().then(() => null, (e) => e))?.message ?? ''));

  // ② 凭据在、探活被拒（就是真机复现命中的那条）
  const { channel, fake } = makeFeishu({ home });
  fake.appInfoFails = 'permission denied';
  for (const c of await channel.check()) texts.push(c.detail ?? '', c.fix ?? '');

  // ③ 连不上长连接
  fake.connectError = 'boom';
  texts.push(String((await channel.start().then(() => null, (e) => e))?.message ?? ''));

  // ④ dmAllowlist 里填了应用 id —— 第 60 轮那条 fix 只在这个状态下才出现
  const dm = makeFeishu({ appId: '', appSecret: '', home, dmMode: 'allowlist', dmAllowlist: ['cli_wrong'] });
  for (const c of await dm.channel.check()) texts.push(c.detail ?? '', c.fix ?? '');

  const withHint = texts.filter((t) => t.includes('smoke.mjs'));
  for (const t of withHint) {
    assert.ok(
      t.includes(`--home="${home}"`),
      `这句给了探针命令却没带 --home=，用户照抄会把凭据存到别的家（实际：${t}）`,
    );
  }
  // ⚠️ 防沉默：上面那个循环一条都不查也算"过"。这一族**必须**有好几处探针出路，
  //    数量对不上就说明这段话没被收集到（比如字段改名了，或者新加的状态没进这个数组）。
  assert.ok(
    withHint.length >= 5,
    `该有 5 处以上探针出路（没凭据×2、探活被拒、连不上、dmAllowlist 配错），实际只收到 ${withHint.length} 处 —— 检查收集逻辑`,
  );
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

test('★ 处理链自己抛错：错误有人看见，而且**下一条照收**（不是 unhandled rejection）', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const s = spyLogger();
  channel.ctx.logger = s.log;
  const got = [];
  channel.onMessage((msg) => got.push(msg.text));

  // 让"处理链自己"在某一条上炸掉 —— 模拟实现里的 bug（**不是**消费者的错：
  // 消费者抛的是同步的，那种由接缝兜，见下面那条用例的注释）。
  //
  // ⚠️ 这条用例在第 56 轮之前**只是名字和注释在说要证这件事**，函数体里却没有任何东西会抛：
  //    它发两条正常消息、断言两条都到 —— 把适配层那个 `.catch` 整个删掉它照样绿。
  //    量覆盖率才露出来：`handleIncoming` 的 catch 从来没被执行过（`lib/index.js:256` 未覆盖）。
  const real = channel.fetchFiles.bind(channel);
  let armed = true;
  channel.fetchFiles = async (msg) => {
    if (armed) {
      armed = false;
      throw new Error('实现里的 bug（本条用例模拟）');
    }
    return real(msg);
  };

  fake.emit(normalized({ content: '第一条' }));
  await settle();
  fake.emit(normalized({ content: '第二条', messageId: 'om_2' }));
  await settle();

  assert.deepEqual(got, ['第二条'], '炸掉的那条不该送到大脑；后面那条**必须照收**');
  const said = s.got.filter((g) => g[0] === 'error').map((g) => String(g[1]));
  assert.ok(
    said.some((m) => m.includes('处理这条消息时出错')),
    `炸了必须有人看见 —— 沉默才是事故。实际日志：${JSON.stringify(s.got)}`,
  );
});

test('★ 断开时报错不影响"停下来"：记一条 warn，但绝不往外抛', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const s = spyLogger();
  channel.ctx.logger = s.log;
  fake.disconnectError = 'disconnect failed (fake)：这条连接已经烂了';

  // 抛了这条用例就红 —— 进程正要走，不该被一条 warn 拦住（`lib/index.js:284` 那行同理）
  await channel.stop();

  assert.equal(fake.connected, false, '该断还是得断');
  const warned = s.got.filter((g) => g[0] === 'warn').map((g) => String(g[1]));
  assert.ok(warned.some((m) => m.includes('断开时出错')), `实际日志：${JSON.stringify(s.got)}`);
});

test('★ dmAllowlist 里填了应用 id（cli_…）：照传，但 start() 会替你喊一声', async () => {
  // "透传"那半在 policy.mjs 用**真的** @larksuite/channel 钉着（这个假实现没有 policy）。
  // 这里只钉"我们有没有说一声"：官方要的是**发送者** id，填 cli_ 等于谁也没放行，
  // 而用户看着自己写的白名单只会以为配好了 —— 这种沉默正是最该打破的（第 59 轮）。
  const { channel } = makeFeishu({
    home: freshHome(),
    dmMode: 'allowlist',
    dmAllowlist: ['ou_a_real_person', 'cli_this_is_an_app_id'],
  });
  const s = spyLogger();
  channel.ctx.logger = s.log;
  await channel.start();

  const warned = s.got.filter((g) => g[0] === 'warn').map((g) => String(g[1]));
  assert.ok(
    warned.some((m) => m.includes('dmAllowlist 里有应用 id')),
    `填成 cli_ 要喊一声，实际日志：${JSON.stringify(s.got)}`,
  );
});

test('没配 dmAllowlist（默认 open）时**一声不吭** —— 别拿警告淹用户', async () => {
  const { channel } = makeFeishu({ home: freshHome() });
  const s = spyLogger();
  channel.ctx.logger = s.log;
  await channel.start();

  const warned = s.got.filter((g) => g[0] === 'warn').map((g) => String(g[1]));
  assert.deepEqual(warned, [], `默认路径不该有警告：${JSON.stringify(s.got)}`);
});

test('★ 取被引消息失败：当没引用，正文一个字不少地照送', async () => {
  const { channel, fake } = makeFeishu({ home: freshHome() });
  await channel.start();

  const s = spyLogger();
  channel.ctx.logger = s.log;
  fake.fetchMessageFails = 'fetch failed (fake)：被引的那句已经不在了';

  const got = [];
  channel.onMessage((msg) => got.push(msg));
  fake.emit(normalized({ content: '上面那句是什么意思', replyToMessageId: 'om_missing' }));
  await settle();

  assert.equal(got.length, 1, '少一段上下文，好过整条不回 —— 还是要送到大脑');
  assert.equal(got[0].quote, undefined, '取不到就当没引用');
  assert.equal(got[0].text, '上面那句是什么意思', '正文一个字都不能少');
  const debugs = s.got.filter((g) => g[0] === 'debug').map((g) => String(g[1]));
  assert.ok(debugs.some((m) => m.includes('取被引消息失败')), `实际日志：${JSON.stringify(s.got)}`);
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

test('★★ 没凭据也要能装载（真机第一枪之前，就是这个状态）', async () => {
  // 这条用**真的** FeishuChannel（不走假通道）。它曾经会崩：
  // 官方包在构造时就校验凭据（`createLarkChannel({ appId: '' })` 直接抛 `appId is needed`），
  // 而我们原来在**构造函数**里就把它造出来了。插件是**装载时**构造的 —— 于是"还没填凭据"
  // 变成了**插件装载失败**：doctor 只说"配置里一行都没有"、`butler run` 直接起不来，
  // 而 check() / start() 里那两段人话永远到不了。
  // 凭据是 `butler run` 从 state/secrets.json 注入的，所以"还没填"是**正常状态**，不是错误状态。
  const ctx = new Context();
  const home = freshHome();
  let ch;
  assert.doesNotThrow(
    () => { ch = new FeishuChannel(ctx, { appId: '', appSecret: '', home }); },
    '没凭据时构造函数绝不能抛 —— 抛了插件就装不上，用户看到的是"配置里一行都没有"',
  );

  const checks = await ch.check();
  assert.equal(checks[0].ok, false, '自检要如实报 ✗');
  assert.match(checks[0].detail, /app_id/);
  assert.match(checks[0].fix, /probe\/smoke\.mjs/, '出路要指向**真会开二维码**的那条（探针）');
  assertRunnableProbeHint(checks[0].fix);
  // ⚠️ 第 35 轮补的**明确**断言：家不在默认位置时，这句话里的命令必须自己带 `--home=`。
  //    上一版这里只有一条"宽容"的正则（容忍这个参数、却不要求它）—— 于是 `scanHint` 的
  //    参数漏传时它照样绿，而用户照抄那条命令会把凭据存进 `~/.butler`，CLI 却在别处读。
  assert.ok(
    checks[0].fix.includes(`--home="${home}"`),
    `别处的家必须带上 --home=，否则这条"出路"是把人引到错地方（实际：${checks[0].fix}）`,
  );

  const startErr = await ch.start().then(() => null, (e) => e);
  assert.match(startErr.message, /probe\/smoke\.mjs/, '启动时给同一句人话');
  assert.ok(
    startErr.message.includes(`--home="${home}"`),
    `启动那句也一样要带 --home=（实际：${startErr.message}）`,
  );
  assertRunnableProbeHint(startErr.message);
});

/**
 * 「出路」里那条命令必须**真的能照着敲** —— 不是"写着探针"就算。
 *
 * 这是踩出来的：文案原来写死 `bash packages/channel-feishu/probe/run.sh`，而那句话
 * **只在源码树里成立**（用 `install.sh` 装的人没有 `packages/` —— 那是 tarball 装进
 * `~/.butler/prefix`，照敲只会得到 `No such file`）。现在文案按包自己的位置算，
 * 所以这里也按"算出来的路径真的存在"来验。
 */
function assertRunnableProbeHint(text) {
  // ⚠️ `--save` 后面**还允许有别的东西**：家不在默认位置时，命令会带上 `--home=<那个目录>`
  //    （不带的话探针会把凭据存到另一个目录，而 CLI 在别处读）。所以别把闭引号钉死在 `--save` 上。
  const m = /`node ([^`]+?) --save([^`]*)`/.exec(text);
  assert.ok(m, `出路里要有一条能照着敲的命令，实际：${text}`);
  assert.ok(existsSync(m[1]), `命令里的探针路径必须真的存在：${m[1]}`);
}

test('★★ 探针命令：算出来的路径真的在，而且 `files` 里必须带着 probe', async () => {
  const { defaultHome, probeCommand, probePath } = await import('../lib/probe-path.js');

  const cmd = probeCommand(defaultHome());
  assert.ok(cmd, '源码树里必须算得出来 —— 探针就在包内');
  const file = /node (.+?) --save/.exec(cmd)?.[1];
  assert.ok(file && existsSync(file), `算出来的路径要真的存在：${file}`);
  assert.ok(probePath().endsWith(join('probe', 'smoke.mjs')));

  // 这条是**根**：路径算得出来，靠的是探针跟着包一起被装走。
  // 少了 `probe`，装完之后 `probeCommand()` 会变成 null —— 提示会悄悄退化成
  // "去源码里跑"，而那正是这次要修的坑。所以这条测试盯的是 package.json 本身。
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(
    pkg.files.includes('probe'),
    'package.json 的 files 少了 probe：装完之后用户就拿不到探针了',
  );

  // ⚠️ 家不在默认位置（`--config` 安在别处）时，那条命令必须**自己**带上 `--home=` ——
  //    否则探针把凭据存进 `~/.butler`，CLI 却在别处读：用户看见"探针说存好了、
  //    `butler run` 却说还没有 app_id"。默认位置则不加，让最常见那句话保持最短。
  assert.ok(!cmd.includes('--home='), `默认的家不必带 --home=（实际：${cmd}）`);
  const custom = probeCommand('/tmp/别处的家');
  assert.ok(
    custom?.includes('--home="/tmp/别处的家"'),
    `别处的家必须带上 --home=（实际：${custom}）`,
  );
});

test('★ 连不上长连接时：中文事实 + 出路，而且绝不回显那条一次性授权链接', async () => {
  const home = freshHome();
  const { channel, fake } = makeFeishu({ home });
  // 原文照抄**实测**抓到的形态：拿假凭据真连了一次官方长连接，回来的就是这句
  fake.connectError = 'could not resolve bot identity via /open-apis/bot/v3/info — required for channel to function';
  fake.connectErrorCode = 'not_connected';
  fake.connectErrorContext = { consoleUrl: 'https://open.feishu.cn/one-click?sign=SECRET-TOKEN' };

  const err = await channel.start().then(() => null, (e) => e);
  assert.ok(err, '凭据不对时 start 必须失败，不能假装连上了');

  assert.match(err.message, /could not resolve bot identity/, '官方原文一个字不改，别藏起来');
  assert.match(err.message, /not_connected/, '把官方的 code 也带上');
  assert.match(err.message, /probe\/smoke\.mjs/, '要说怎么办 —— 只说"不行"等于没说');
  assertRunnableProbeHint(err.message);
  assert.match(err.message, /发新版/, '权限那条坑要提醒（改完不发版不生效）');
  // ⚠️ 第 36 轮补的两条。上面那条 `assertRunnableProbeHint` 是**宽容**的（容忍 `--home=`、
  //    却不要求它），而 `connectFailed` 正是同一族里**第三处**漏传管家目录的调用点 ——
  //    第 35 轮修好了、却没有任何断言盯它。家不在默认位置时它必须自己带 `--home=`。
  assert.ok(
    err.message.includes(`--home="${home}"`),
    `别处的家必须带上 --home=，否则这条"出路"把人引到错地方（实际：${err.message}）`,
  );
  // ⚠️ context.consoleUrl 是签了名的一次性授权链接 = 凭据，绝不能出现在任何输出里。
  //    上面验的是**合成**的那个 token；这一条换成更强的形态：这条消息里**一个 URL 都不该有**
  //    （第 36 轮拿假凭据真连了一次官方长连接，实测抓到的原文里就夹着那条签名链接）。
  assert.ok(!err.message.includes('SECRET-TOKEN'), '一次性授权链接绝不能回显');
  assert.ok(!err.message.includes('consoleUrl'));
  assert.ok(
    !/https?:\/\//.test(err.message),
    `这条消息里不该有任何 URL —— 官方原文那句里夹着签名链接（实际：${err.message}）`,
  );

  assert.equal(fake.connected, false);
  assert.equal(fake.subscribed, false, '连不上要退订 —— 别留半个订阅在那儿');
});
