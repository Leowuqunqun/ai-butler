/**
 * 微信通道 cordis 插件的测试 —— **全部离线**。
 *
 * 做法：子类重写 `createIlink()` 换成一个假协议客户端，
 * 于是收信、附件下载、发信、正在输入这些路径全都能真跑一遍，
 * 不连网、不需要微信账号、不会给任何人发消息。
 *
 *   node --test test/plugin.mjs
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';

import { WechatChannel } from '../src/plugin.mjs';
import { Store } from '../src/store.mjs';

/** AES-128-ECB + PKCS7 —— 跟通道解密那条路配对的加密，用来伪造"CDN 上的密文" */
const encrypt = (plain, key) => {
  const c = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
};

// ───────────────────────── 假协议客户端 ─────────────────────────

/**
 * 假的 iLink 客户端。
 *
 * `getUpdates` 的行为跟真的对齐：**没有新消息时挂住**（不是立刻返回空），
 * 否则收信循环会变成忙等，把 CPU 打满。
 */
class FakeIlink {
  constructor() {
    this.n = 0;
    this.sent = [];
    this.typed = [];
    this.ticketsAsked = 0;
    this.polls = 0;
    this.cursorSeen = [];
    this._queue = [];
    this._waiter = null;
    this.failNext = null;
  }

  /** 塞一批消息进去（或塞一个 Error 让这次长轮询失败） */
  push(batch) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w(batch);
    } else {
      this._queue.push(batch);
    }
  }

  async getUpdates(buf, { signal } = {}) {
    this.polls += 1;
    this.cursorSeen.push(buf);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }

    let batch;
    if (this._queue.length) {
      batch = this._queue.shift();
    } else {
      // 跟真的一样：没有新消息就挂住。**必须尊重 signal** ——
      // 否则 stop() 会像真实现那样干等一场长轮询
      batch = await new Promise((resolve, reject) => {
        this._waiter = resolve;
        if (signal) {
          const onAbort = () => { this._waiter = null; reject(new Error('长轮询被中断')); };
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
    if (batch instanceof Error) throw batch;
    return { ret: 0, msgs: batch, get_updates_buf: `buf-${++this.n}` };
  }

  async sendText(to, text, opts) {
    this.sent.push({ kind: 'text', to, text, opts });
    return 1;
  }

  async sendFile(to, absPath, opts) {
    this.sent.push({ kind: 'file', to, absPath, opts });
    return { fileName: absPath.split('/').pop(), size: 7 };
  }

  async typingTicket() {
    this.ticketsAsked += 1;
    return 'TICKET';
  }

  async setTyping(ticket, status) {
    this.typed.push({ ticket, status });
  }
}

/** 装一个假的 HTTP，用来喂 CDN 回包 */
function fakeFetch(handler) {
  return async (url, init) => handler(String(url), init);
}

const okResponse = (bytes) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

// ───────────────────────── 脚手架 ─────────────────────────

const cleanups = [];
after(() => { for (const c of cleanups.splice(0)) c(); });

function setup(config = {}, { loggedIn = true, ilink = new FakeIlink() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wab-plugin-'));
  const store = new Store(home);
  if (loggedIn) store.writeToken({ baseUrl: 'https://x.test', botToken: 'tok', ilinkUserId: 'me' });

  class TestChannel extends WechatChannel {
    createIlink() { return ilink; }
  }

  const ctx = new Context();
  const cleanup = async () => {
    try { await ctx.fiber.dispose(); } finally { rmSync(home, { recursive: true, force: true }); }
  };
  cleanups.push(cleanup);

  return {
    home, store, ilink, ctx, cleanup,
    /** 加载插件（不启动） */
    async load(cfg = {}) {
      await ctx.plugin(TestChannel, { home, ...config, ...cfg });
      return ctx.channel;
    },
  };
}

/** 等某个条件成立，超时就抛（比 sleep 死等稳） */
async function waitFor(fn, { timeoutMs = 3000, label = '条件' } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`等 ${label} 超时`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ───────────────────────── 加载与生命周期 ─────────────────────────

test('作为 cordis 插件加载：ctx.channel 就位，且双身份成立', async () => {
  const s = setup();
  const ch = await s.load();
  assert.ok(ch);
  assert.ok(ch instanceof WechatChannel, '是实现类的实例');
  assert.ok(ch instanceof ChannelService, '也是 seam 的实例 —— 核心层只按 seam 消费');
  assert.equal(ch.id, 'wechat');
  await s.cleanup();
});

test('配置的默认值来自 schema，传入值覆盖', async () => {
  const s = setup({ replyChars: 500 });
  const ch = await s.load();
  assert.equal(ch.config.replyChars, 500, '传了的要被用上');
  assert.equal(ch.config.mediaEnabled, true, '没传的要拿默认值');
  assert.equal(ch.config.typing, true);
  assert.deepEqual(ch.config.allowFrom, []);
  assert.equal(typeof ch.config.maxMediaBytes, 'number');
  await s.cleanup();
});

test('没登录、又关掉了扫码页：明确报错并指出怎么办（不能静默跑着）', async () => {
  // 关掉扫码页是没有浏览器的地方（服务器 / CI）该有的行为：
  // 这里必须**报错**，而不是静默跑着什么都不收
  const s = setup({}, { loggedIn: false });
  const ch = await s.load({ qrPage: false });

  const error = await ch.start().then(() => null, (e) => e);
  assert.ok(error, '没登录又没扫码页，就必须报错');
  assert.match(error.message, /还没登录|扫码/, '要报错且提示扫码');
  assert.match(error.message, /qrPage=false|wechat-agent-bridge qr/,
    '要告诉他没有浏览器时该怎么办');
  assert.equal(ch.started, false, '失败后不该标记成已启动');
  await s.cleanup();
});

test('★ 没登录、但开着扫码页：启动时**自己去登录**，不要用户敲第二条命令', async () => {
  // 这是小白路上最容易断的一截：他刚敲完 butler run，
  // 得到的不能是一句"先去跑 wechat-agent-bridge qr"（那条命令的名字他猜不出来）
  const ilink = new FakeIlink();
  ilink.login = async ({ onQr }) => {
    onQr?.({ content: 'https://weixin.qq.com/x/QR', cycle: 1 });
    return { baseUrl: 'https://x.test', botToken: 'tok-new', ilinkUserId: 'me' };
  };

  const s = setup({ qrPort: 8500 + (process.pid % 300) }, { loggedIn: false, ilink });
  const ch = await s.load();
  const opened = [];
  ch.openBrowser = (url) => opened.push(url);        // 测试里不该真弹一个窗口

  await ch.start();

  assert.equal(s.store.readToken().botToken, 'tok-new', '登录态要落盘，第二次启动就不用再扫');
  assert.equal(opened.length, 1, '该把浏览器打开到扫码页');
  assert.match(opened[0], /^http:\/\/127\.0\.0\.1:\d+$/, `开的地址不对：${opened[0]}`);
  assert.equal(ch.started, true, '登录完就该接着上线');

  await ch.stop();
  await s.cleanup();
});

test('start 幂等：重复调用不会起第二个循环', async () => {
  const s = setup();
  const ch = await s.load();
  await ch.start();
  const pollsAfterFirst = s.ilink.polls;
  await ch.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(s.ilink.polls - pollsAfterFirst <= 1, '不该多出一倍的轮询');
  await ch.stop();
  await s.cleanup();
});

test('stop 之后循环真的停了；没 start 过调 stop 也不炸', async () => {
  const s = setup();
  const ch = await s.load();
  await ch.stop();                       // 没 start 过
  await ch.start();
  await s.ilink.push([]);                // 让它转一圈，确认在跑
  await waitFor(() => s.ilink.polls > 0, { label: '轮询开始' });
  await ch.stop();
  const after = s.ilink.polls;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.ilink.polls, after, 'stop 之后不该再轮询');
  await s.cleanup();
});

// ───────────────────────── 收信 ─────────────────────────

test('收到用户消息 → 交出一条带文本/fromId/contextToken 的入站消息', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'tk-1',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
  }]);

  await waitFor(() => got.length === 1, { label: '收到消息' });
  assert.equal(got[0].channel, 'wechat');
  assert.equal(got[0].fromId, 'u1');
  assert.equal(got[0].text, '你好');
  assert.equal(got[0].contextToken, 'tk-1', '回复时要靠它');
  assert.equal(got[0].files, undefined);
  await s.cleanup();
});

test('★ 用户引用某句话：quote 单独交出去，正文里只有他这次说的话', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([
    {
      message_type: 1,
      from_user_id: 'u1',
      context_token: 'tk-1',
      item_list: [{
        type: 1,
        text_item: { text: '再发一次' },
        ref_msg: {
          title: '昨天那个 PPT',
          message_item: { type: 1, text_item: { text: '@家里那台 昨天那个 PPT 发我' } },
        },
      }],
    },
    {
      message_type: 1,
      from_user_id: 'u1',
      context_token: 'tk-2',
      item_list: [{ type: 1, text_item: { text: '没有引用的一条' } }],
    },
  ]);

  await waitFor(() => got.length === 2, { label: '收到两条' });
  assert.equal(got[0].text, '再发一次', '正文只有他这次说的话');
  assert.equal(got[0].quote, '@家里那台 昨天那个 PPT 发我', '引用单独一个字段');
  assert.equal(got[1].quote, undefined, '没有引用就不给这个字段');
});

test('★ 只有引用、没有说话：引用本身就是内容 —— 交上去，且不许说"读不了"', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'tk-1',
    item_list: [{
      type: 1,
      text_item: { text: '' },
      ref_msg: { message_item: { type: 1, text_item: { text: '昨天那个 PPT' } } },
    }],
  }]);

  await waitFor(() => got.length === 1, { label: '收到消息' });
  assert.equal(got[0].text, undefined, '他这次一个字都没打');
  assert.equal(got[0].quote, '昨天那个 PPT', '但他指着的那句是内容，要交上去');
  // 一个字都不该往回发：既没有"读不了"的回执，也没有别的
  assert.deepEqual(s.ilink.sent, [], '这不是"读不了"—— 别乱回话');
});

test('★ 关掉 media 时"引用 + 一张图"：图没取到要说一声，但引用照样交上去（不能一起丢）', async () => {
  const s = setup({ mediaEnabled: false });
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'tk-1',
    item_list: [
      { type: 1, text_item: { text: '' }, ref_msg: { message_item: { type: 1, text_item: { text: '这张图' } } } },
      { type: 2, image_item: { url: 'https://x/y', aeskey: '00' } },
    ],
  }]);

  await waitFor(() => got.length === 1, { label: '收到消息' });
  assert.equal(got[0].quote, '这张图', '引用不能跟着附件一起丢');
  assert.equal(got[0].files, undefined);
  await waitFor(() => s.ilink.sent.length === 1, { label: '回执' });
  assert.match(s.ilink.sent[0].text, /没能取到/, '图确实没拿到，得说一声（不然他以为图发出去了）');
});

test('真·读不了：没正文、没附件、也没引用 —— 才如实说"没有我能读的内容"', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'tk-1',
    item_list: [{ type: 1, text_item: { text: '' } }],
  }]);

  await waitFor(() => s.ilink.sent.length === 1, { label: '回执' });
  assert.match(s.ilink.sent[0].text, /没有我能读的内容/);
  assert.equal(got.length, 0, '这种才不该交给核心层');
});

test('机器人自己发的消息会被忽略（message_type !== USER）', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([
    { message_type: 2, from_user_id: 'bot', item_list: [{ type: 1, text_item: { text: '我是自己' } }] },
    { message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '人说的' } }] },
  ]);

  await waitFor(() => got.length >= 1, { label: '收到消息' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1, '只该有那一条人发的');
  assert.equal(got[0].text, '人说的');
  await s.cleanup();
});

test('语音转写：服务端已经给好 text，照文本处理', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    item_list: [{ type: 3, voice_item: { text: '语音转出来的字' } }],
  }]);

  await waitFor(() => got.length === 1, { label: '收到语音' });
  assert.equal(got[0].text, '语音转出来的字');
  await s.cleanup();
});

test('游标被持久化，重启不会把老消息再收一遍', async () => {
  const s = setup();
  const ch = await s.load();
  await ch.start();
  s.ilink.push([{ message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: 'x' } }] }]);
  await waitFor(() => s.store.readCursor(), { label: '游标落盘' });
  assert.equal(s.store.readCursor(), 'buf-1');
  await ch.stop();

  // 重新起：第一次 getUpdates 应该带上上次的游标
  const ch2 = s.ctx.channel;
  await ch2.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(s.ilink.cursorSeen.includes('buf-1'), `重启后应带游标续收，实际见过：${JSON.stringify(s.ilink.cursorSeen)}`);
  await s.cleanup();
});

test('★ "在回哪句"由通道渲染：微信没有引用字段，就顶一行 ↩（内核不再管这件事）', async () => {
  const s = setup();
  await s.load();

  await s.ctx.channel.sendText('u1', '干活干完了', { contextToken: 'tk', quote: '把报表整理一下' });
  assert.equal(s.ilink.sent[0].text, '↩ 把报表整理一下\n干活干完了');
  assert.equal(s.ilink.sent[0].opts.contextToken, 'tk', '会话还是要带上');

  // 长原话截 30 个字（和以前内核里的行为一模一样）
  await s.ctx.channel.sendText('u1', '好的', { quote: '很长的'.repeat(20) });
  const line = s.ilink.sent[1].text.split('\n')[0];
  assert.equal(line.length, 2 + 30 + 1, '↩ + 30 个字 + 省略号');
});

test('没有 quote 就一个字都不加（进度提示、配文、报错都不是"在回答某句话"）', async () => {
  const s = setup();
  await s.load();

  await s.ctx.channel.sendText('u1', '还在处理…（已 30s）', { contextToken: 'tk' });
  assert.equal(s.ilink.sent[0].text, '还在处理…（已 30s）');

  // 连空字符串都不算：不能因为"传了个空 quote"就冒出一个空的 ↩
  await s.ctx.channel.sendText('u1', '好了', { contextToken: 'tk', quote: '   ' });
  assert.equal(s.ilink.sent[1].text, '好了');
});

test('allowFrom 非空时是粗筛：名单外的静默丢弃', async () => {
  const s = setup({ allowFrom: ['u1'] });
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([
    { message_type: 1, from_user_id: 'stranger', item_list: [{ type: 1, text_item: { text: '放我进去' } }] },
    { message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '自己人' } }] },
  ]);

  await waitFor(() => got.length >= 1, { label: '收到消息' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.length, 1);
  assert.equal(got[0].fromId, 'u1');
  await s.cleanup();
});

test('读不了的消息：通道自己回一句说明，不交给核心层', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  // 有媒体项但没有下载凭据 → 属于"读不了"里的凭证缺失那一种
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    context_token: 'tk',
    item_list: [{ type: 2, image_item: {} }],
  }]);

  await waitFor(() => s.ilink.sent.length === 1, { label: '回执发出' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got.length, 0, '不该当成对话回合交出去');
  assert.match(s.ilink.sent[0].text, /读不了/);
  assert.equal(s.ilink.sent[0].opts.contextToken, 'tk', '回执也要带 contextToken');
  await s.cleanup();
});

test('收信失败会退避重试，不会把循环打死', async () => {
  const s = setup();
  const ch = await s.load();
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.failNext = new Error('网络抽了一下');   // 第一轮失败
  await waitFor(() => s.ilink.polls >= 1, { label: '第一次失败' });
  s.ilink.push([{ message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '还在吗' } }] }]);
  await waitFor(() => got.length === 1, { timeoutMs: 5000, label: '失败后恢复' });
  assert.equal(got[0].text, '还在吗');
  await s.cleanup();
});

// ───────────────────────── 附件 ─────────────────────────

test('收到图片：下载 → 解密 → 落进收件箱 → 交出**本机路径**', async () => {
  const key = Buffer.from('0123456789abcdef', 'utf8');   // 16 字节
  const plain = Buffer.from('这是一张图的内容');
  const cipher = encrypt(plain, key);

  const s = setup({}, {});
  const ch = await s.load();
  // 换掉 CDN 下载用的 fetch：直接回密文
  ch.config.cdnBaseUrl = 'https://cdn.test';
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    item_list: [{
      type: 2,
      image_item: {
        // 图片这条路的 key 是 hex 字符串，优先级高于 media.aes_key
        aeskey: key.toString('hex'),
        media: { encrypt_query_param: 'EQP', aes_key: '', full_url: '' },
      },
    }],
  }]);

  // 用真的 fetchMedia，但把 fetchImpl 换成假的（走 CDN 那条路）
  ch.fetchInbound = async function (sel) {
    const { fetchMedia, saveInbound, originalNameOf, describeItem } = await import('../src/media.mjs');
    const buf = await fetchMedia(sel, {
      cdnBaseUrl: 'https://cdn.test',
      fetchImpl: fakeFetch(() => okResponse(cipher)),
    });
    return saveInbound(buf, { dir: this.store.paths.inbox, fileName: originalNameOf(sel), kind: sel.kind });
  };

  await waitFor(() => got.length === 1, { label: '收到图片' });
  const m = got[0];
  assert.equal(m.files?.length, 1, '应当带一个附件');
  const f = m.files[0];
  assert.ok(existsSync(f.path), `附件必须已经落在本机：${f.path}`);
  assert.equal(f.kind, 'image');
  assert.equal(f.size, plain.length);
  assert.ok(f.path.includes('/state/inbox/'), `应当落在收件箱：${f.path}`);
  await s.cleanup();
});

test('附件下载失败：文字照常交出去，并且如实说附件没拿到', async () => {
  const s = setup();
  const ch = await s.load();
  ch.fetchInbound = async () => { throw new Error('凭据过期了'); };
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([{
    message_type: 1,
    from_user_id: 'u1',
    item_list: [
      { type: 1, text_item: { text: '这张图你看下' } },
      { type: 2, image_item: { aeskey: 'aa'.repeat(16), media: { encrypt_query_param: 'EQP' } } },
    ],
  }]);

  await waitFor(() => got.length === 1, { label: '收到消息' });
  assert.match(got[0].text, /这张图你看下/, '原文字要保留');
  assert.match(got[0].text, /凭据过期了/, '失败原因要如实说出来');
  assert.equal(got[0].files, undefined, '没拿到就不该给一个假路径');
  await s.cleanup();
});

test('mediaEnabled=false 时完全不碰附件，纯文字也不受影响', async () => {
  const s = setup({ mediaEnabled: false });
  const ch = await s.load();
  let fetched = 0;
  ch.fetchInbound = async () => { fetched += 1; return null; };
  const got = [];
  ch.onMessage((m) => got.push(m));

  await ch.start();
  s.ilink.push([
    { message_type: 1, from_user_id: 'u1', item_list: [{ type: 2, image_item: { aeskey: 'aa'.repeat(16), media: { encrypt_query_param: 'E' } } }] },
    { message_type: 1, from_user_id: 'u1', item_list: [{ type: 1, text_item: { text: '纯文字' } }] },
  ]);

  await waitFor(() => got.length === 1, { label: '收到文字' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetched, 0, '关掉之后一次都不该下载');
  assert.equal(got.length, 1, '纯文字照常');
  assert.equal(got[0].text, '纯文字');
  await s.cleanup();
});

// ───────────────────────── 发信 ─────────────────────────

test('sendText 转发给协议层，返回分条数', async () => {
  const s = setup();
  const ch = await s.load();
  const r = await ch.sendText('u1', '你好', { contextToken: 'tk' });
  assert.deepEqual(r, { chunks: 1 });
  assert.deepEqual(s.ilink.sent[0], { kind: 'text', to: 'u1', text: '你好', opts: { contextToken: 'tk', maxChars: 1200 } });
  await s.cleanup();
});

test('sendFile 转发并返回文件名与大小（文件：kind=file）', async () => {
  const s = setup();
  const ch = await s.load();
  const r = await ch.sendFile('u1', '/tmp/报告.pdf', { contextToken: 'tk' });
  assert.deepEqual(r, { fileName: '报告.pdf', size: 7 });
  assert.equal(s.ilink.sent[0].absPath, '/tmp/报告.pdf');
  assert.equal(s.ilink.sent[0].opts.kind, 'file', 'pdf 是文件');
  await s.cleanup();
});

test('★ 发图片：通道按文件名定 kind=image（内核不掺和，跟 Telegram 一条规矩）', async () => {
  const s = setup();
  const ch = await s.load();
  // 图片：该当图片发（对面看到的是图片，不是一个附件）
  for (const n of ['报表.png', 'photo.JPG', '动画.gif', 'x.webp', 'IMG_0001.HEIC']) {
    await ch.sendFile('u1', `/tmp/${n}`, {});
  }
  // 视频：该当视频发（手机拍的 .mov/.mp4 就落在这里）
  for (const n of ['演示.mp4', '录像.MOV']) {
    await ch.sendFile('u1', `/tmp/${n}`, {});
  }
  // 认不出来 / 不是图片视频：照旧当文件发（**当文件一定送得到**，这是安全的默认）
  for (const n of ['报告.pdf', '数据.csv', '没有后缀', '怪东西.avif', '声音.mp3']) {
    await ch.sendFile('u1', `/tmp/${n}`, {});
  }
  assert.deepEqual(s.ilink.sent.map((x) => [x.absPath.split('/').pop(), x.opts.kind]), [
    ['报表.png', 'image'], ['photo.JPG', 'image'], ['动画.gif', 'image'],
    ['x.webp', 'image'], ['IMG_0001.HEIC', 'image'],
    ['演示.mp4', 'video'], ['录像.MOV', 'video'],
    ['报告.pdf', 'file'], ['数据.csv', 'file'], ['没有后缀', 'file'],
    ['怪东西.avif', 'file'], ['声音.mp3', 'file'],
  ]);
  await s.cleanup();
});

test('setTyping：拿票据 → 1 表示正在输入、2 表示取消，票据会缓存', async () => {
  const s = setup();
  const ch = await s.load();
  await ch.setTyping('u1', true, { contextToken: 'tk' });
  await ch.setTyping('u1', false, { contextToken: 'tk' });
  assert.deepEqual(s.ilink.typed, [
    { ticket: 'TICKET', status: 1 },
    { ticket: 'TICKET', status: 2 },
  ]);
  assert.equal(s.ilink.ticketsAsked, 1, '同一个 contextToken 的票据只该取一次');
  await s.cleanup();
});

test('setTyping 是 best-effort：拿不到票据也不许抛错', async () => {
  const s = setup();
  const ch = await s.load();
  s.ilink.typingTicket = async () => { throw new Error('取票据失败'); };
  await assert.doesNotReject(() => ch.setTyping('u1', true, { contextToken: 'tk' }));
  await s.cleanup();
});

test('typing=false 时一次都不调协议层', async () => {
  const s = setup({ typing: false });
  const ch = await s.load();
  await ch.setTyping('u1', true, { contextToken: 'tk' });
  assert.equal(s.ilink.ticketsAsked, 0);
  assert.equal(s.ilink.typed.length, 0);
  await s.cleanup();
});

// ───────────────────────── 收尾 ─────────────────────────

test('context 卸载 → 通道自动停止（收尾走 ctx.effect）', async () => {
  const s = setup();
  const ch = await s.load();
  await ch.start();
  await waitFor(() => s.ilink.polls > 0, { label: '开始轮询' });

  await s.ctx.fiber.dispose();
  assert.equal(s.ctx.channel, undefined, '服务位要消失');
  assert.equal(ch.started, false, 'effect 里的 stop 要被执行');
  await rmSync(s.home, { recursive: true, force: true });
});

// ───────────────────────── 自检 check() ─────────────────────────

test('check：登录过就报登录态，还带上是什么时候扫的码', async () => {
  const t = setup();
  const ch = await t.load();
  const c = ch.check();
  const login = c.find((x) => x.name === '微信登录态');
  assert.equal(login.ok, true);
  assert.match(login.detail, /登录态存过/, '它只说得出「存过」—— 说成「已登录」就是假绿');
  assert.equal(c.every((x) => x.ok), true, JSON.stringify(c, null, 2));
});

test('check：旧版写的 `confirmedAt` 也认（拿真数据验的时候发现的）', async () => {
  // cordis 版的 Store 写 `savedAt`，早期单体版写 `confirmedAt`。
  // 只认 savedAt 的话，老账号迁移过来会一直显示"时间未知"。
  const home = mkdtempSync(join(tmpdir(), 'wab-old-'));
  const store = new Store(home);
  writeFileSync(store.paths.token, JSON.stringify({
    botToken: 'tok', confirmedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  }));
  const ctx = new Context();
  await ctx.plugin(WechatChannel, { home });
  try {
    const login = ctx.channel.check().find((x) => x.name === '微信登录态');
    assert.equal(login.ok, true);
    assert.match(login.detail, /登录态存过/, '它只说得出「存过」—— 说成「已登录」就是假绿');
    assert.equal(login.detail.includes('时间未知'), false, '认出了 confirmedAt，就不该说时间未知');
    assert.match(login.detail, /2026/);
  } finally {
    await ctx.fiber.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});

test('check：没登录时要说清**找的是哪个文件**（"我明明登录过啊"的唯一线索）', async () => {
  const t = setup({}, { loggedIn: false });
  const ch = await t.load();
  const login = ch.check().find((x) => x.name === '微信登录态');
  assert.match(login.detail, /token\.json/, '数据根目录指错一层时，就靠这句看出来');
});

test('check：没登录过 → 不合格，并告诉用户"扫码就行"（不是让他去读文档）', async () => {
  const t = setup({}, { loggedIn: false });
  const ch = await t.load();
  const login = ch.check().find((x) => x.name === '微信登录态');
  assert.equal(login.ok, false);
  assert.match(login.detail, /还没登录/);
  assert.match(login.fix, /二维码|扫一下/);
});

test('check：报告数据目录在哪 —— 用户最常问"东西都放哪儿了"', async () => {
  const t = setup();
  const ch = await t.load();
  const dir = ch.check().find((x) => x.name === '数据目录');
  assert.equal(dir.ok, true);
  assert.match(dir.detail, new RegExp(escapeRe(t.home)));
});

test('目录只读时：插件装不上，但错误**是人话**（原生 EACCES 用户看不懂）', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root 会绕过权限位，这一条在 root 下没有意义');
  const home = mkdtempSync(join(tmpdir(), 'wab-ro-'));
  chmodSync(home, 0o500);
  const ctx = new Context();
  try {
    // Store 构造时就炸 —— 所以这里不能用 assert.rejects（ctx.plugin 返回 Fiber）
    let msg = '';
    try { await ctx.plugin(WechatChannel, { home }); } catch (e) { msg = e.message; }
    assert.match(msg, /数据目录用不了/, '要把原生错误翻译掉');
    assert.equal(msg.includes('EACCES'), false, '别把 errno 甩给用户');
    assert.equal(msg.includes('mkdir'), false, '原生错误的原文只该进日志，不该给用户看');
    assert.match(msg, /指到别处|建出来/, '要给出路');
    assert.match(msg, /放微信登录态/, '要说清这个目录是干什么的，否则用户不知道该建在哪');
  } finally {
    await ctx.fiber.dispose();
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test('check：跑起来之后目录被改成只读 → 自检要能发现', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root 会绕过权限位');
  const t2 = setup();
  const ch = await t2.load();
  chmodSync(t2.home, 0o500);
  try {
    const dir = ch.check().find((x) => x.name === '数据目录');
    assert.equal(dir.ok, false);
    assert.match(dir.detail, /写不进去/);
    assert.match(dir.fix, /权限/);
  } finally { chmodSync(t2.home, 0o700); }
});

test('check 绝不连网（自检可能被反复跑，不能有副作用）', async () => {
  const ilink = new FakeIlink();
  const t = setup({}, { ilink });
  const ch = await t.load();
  const before = ilink.polls;
  ch.check();
  assert.equal(ilink.polls, before, 'check 不该调 getUpdates');
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─────────── ★ 微信通道自己的自检 ───────────
//
// 这个类只管**收信 + 发信**（跑 agent 是核心层的事，那边有自己的 check），
// 所以它只报自己能确定的两件：数据目录能不能用、登录态**存过没有**。
// 谁在问：CLI 的 `butler doctor`，以及主人在微信里回的那句「自检」。

const makeChannel = (home) => new WechatChannel(new Context(), { home });

test('还没登录：报红，而且说清找的是哪个文件（"我明明登录过啊"的唯一线索）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-check-'));
  try {
    const items = await makeChannel(home).check();
    const it = items.find((i) => i.name.includes('登录态'));
    assert.ok(it, '登录态这一条必须在 —— doctor 最常碰到的就是"还没扫过码"');
    assert.equal(it.ok, false);
    assert.match(it.detail, /token\.json/, '找不到时得告诉人找的是哪个文件，否则这句话没法排查');
    assert.match(it.fix, /扫/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('★ 存过登录态：只说"存过"，不许说成"现在是好的"；报告里不许出现 token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-check-'));
  try {
    const ch = makeChannel(home);
    const SECRET = 'ilink-bot-token-绝密-9f3a';
    writeFileSync(ch.store.paths.token,
      JSON.stringify({ botToken: SECRET, savedAt: new Date().toISOString() }));
    const items = await ch.check();
    const it = items.find((i) => i.name.includes('登录态'));
    assert.equal(it.ok, true);
    assert.match(it.detail, /存过/);
    assert.match(it.detail, /说明不了现在还有效/,
      'token 文件在 ≠ 现在还有效 —— 说成"已登录"，真掉线时报告还是绿的');
    assert.doesNotMatch(JSON.stringify(items), new RegExp(SECRET),
      '这份报告是要主人整段转发给别人的，里面一个 key 都不许有');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('数据目录写不进去：现在就报红，而不是等它某天炸在别处', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root 不看权限位');
  const home = mkdtempSync(join(tmpdir(), 'wab-check-'));
  try {
    const ch = makeChannel(home);
    chmodSync(home, 0o555);
    const items = ch.check();
    const it = items.find((i) => i.name.includes('数据目录'));
    assert.equal(it.ok, false);
  } finally {
    chmodSync(home, 0o755);
    rmSync(home, { recursive: true, force: true });
  }
});

test('自检自己不许抛 —— 它挂了的话，主人连"哪儿不对"都看不到', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wab-check-'));
  try {
    const ch = makeChannel(home);
    ch.store = { readToken: () => null, paths: {} };     // 结构不对 / 被拿走
    const items = ch.check();
    assert.ok(Array.isArray(items), '契约：check() 返回清单，不抛');
    for (const i of items) {
      assert.equal(typeof i.name, 'string');
      assert.ok(i.name, '每条都要有名字');
      assert.equal(typeof i.ok, 'boolean');
      assert.ok(i.detail, '过了也要写状态 —— 光一个勾没用');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
