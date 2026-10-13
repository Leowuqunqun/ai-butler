/**
 * 一个**假的 `@larksuite/channel`**。
 *
 * ── 为什么这里用打桩，而 telegram 那边起了个真服务器 ──────────────
 *
 * 那边的理由是"打桩只能证明我以为的协议" —— 对，因为**协议是我们自己实现的**，
 * 必须证明我们真按那个协议发了请求。
 *
 * 飞书这里正相反：协议**不是我们的代码**（长连接、去重、媒体上传都在官方包里，
 * 由他们维护）。我们这层要证明的是**翻译对不对**：
 *   消息有没有送到消费者手里、重复投递有没有被拦住、回复走了原生引用还是普通发送、
 *   被引用的原文有没有带上、机器人自己的消息有没有被丢掉。
 *
 * 这些全部发生在"官方通道的接口"这个边界上，所以边界就该假在这里 ——
 * 假在更外面（起个假飞书服务器）只会测到官方的代码，那是他们的事。
 *
 * 假到什么程度：**只实现我们真的会调用的那几个成员**，行为按官方 README 与
 * 类型声明来（`on/connect/disconnect/send/reply/fetchMessage/downloadResourceToFile/botIdentity`）。
 *
 * @module @butler/channel-feishu/test/fake-lark
 */

import { writeFileSync } from 'node:fs';

import { Context } from '@deepseek-ai/cordis';
import { FeishuChannel } from '../lib/index.js';

export class FakeLark {
  sent = [];
  replies = [];
  /**
   * 让 `reply` / `send` 失败（测"引用回不了怎么办"）。
   *
   * ⚠️ `reply` 会**先记下来再抛**：我们关心的是"试过引用回复、然后退了没有"，
   * 所以"试过"这件事必须留痕。
   */
  failReply = false;
  failSend = false;
  connected = false;
  identity = { openId: 'ou_fake_bot', name: '管家的测试身份' };
  fetched = new Map();
  handlers = new Map();
  /** 下载过什么（顺序、类型、落到哪），测试用来断言适配层怎么调的 */
  downloads = [];
  /** 默认写进去的字节；测试想造"超大文件"就换一个长的 */
  downloadBytes = Buffer.from('假附件的内容');
  /** 服务器给的 content-type（官方包会把它带回来） */
  downloadContentType = 'image/png';
  /** 设了就让下载抛错 —— 用来测"一个附件失败不拖累整条消息" */
  downloadFails = null;
  /** 自检那次 REST 探活（`getAppInfo`）的三种状态：正常 / 被拒 / 永不作答 */
  appInfo = { appName: '管家的测试应用', ownerId: 'ou_owner' };
  appInfoFails = null;
  appInfoHangs = false;
  /** 被拒时挂上来的 context —— 真实错误里那是**签了名的一次性授权链接** */
  appInfoContext = undefined;
  /** 设了就让 `connect()` 抛错（原文照抄实测抓到的 `not_connected` 那句） */
  connectError = null;
  connectErrorCode = 'not_connected';
  /** 连接失败时挂上来的 context —— 同样是凭据，适配层绝不能回显 */
  connectErrorContext = undefined;
  /** 设了就让 `disconnect()` 抛错（第 56 轮补：`stop()` 里那个 warn 从没被执行过） */
  disconnectError = null;
  /** 设了就让 `fetchMessage()` 抛错（第 56 轮补：取被引消息失败那条路） */
  fetchMessageFails = null;

  /** connect() 之前是 undefined —— 和官方包的行为一致 */
  get botIdentity() {
    return this.connected ? this.identity : undefined;
  }

  on(name, fn) {
    const set = this.handlers.get(name) ?? new Set();
    set.add(fn);
    this.handlers.set(name, set);
    return () => set.delete(fn);
  }

  async connect() {
    if (this.connectError) {
      const error = new Error(this.connectError);
      error.code = this.connectErrorCode;
      if (this.connectErrorContext) error.context = this.connectErrorContext;
      throw error;
    }
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
    if (this.disconnectError) throw new Error(this.disconnectError);
  }

  async send(to, input) {
    this.sent.push({ to, input });
    if (this.failSend) throw new Error('send rejected (fake)：发不出去');
    return { messageId: `om_sent_${this.sent.length}` };
  }

  async reply(target, input) {
    this.replies.push({ target, input });
    if (this.failReply) throw new Error('reply rejected (fake)：被引的那句没了');
    return { messageId: `om_reply_${this.replies.length}`, chunkIds: ['om_c1'] };
  }

  async fetchMessage(messageId) {
    if (this.fetchMessageFails) throw new Error(this.fetchMessageFails);
    return this.fetched.get(messageId);
  }

  /** 自检用的那次便宜 REST 调用（不需要先连长连接） */
  async getAppInfo() {
    if (this.appInfoHangs) return new Promise(() => {});
    if (this.appInfoFails) {
      const error = new Error(this.appInfoFails);
      error.code = 'permission_denied';
      if (this.appInfoContext) error.context = this.appInfoContext;
      throw error;
    }
    return this.appInfo;
  }

  /**
   * 官方包的契约：**父目录必须已经存在**（它不替我们建），而且它是 pipe 到磁盘的。
   * 这里照做 —— 适配层哪天忘了 mkdir，这个假实现就会像真的一样抛 ENOENT。
   */
  async downloadResourceToFile(messageId, fileKey, type, destPath) {
    this.downloads.push({ messageId, fileKey, type, destPath });
    if (this.downloadFails) throw new Error(this.downloadFails);
    writeFileSync(destPath, this.downloadBytes);
    return { contentType: this.downloadContentType, bytesWritten: this.downloadBytes.length };
  }

  /** 测试用：像飞书那样把一条消息投进来（官方包归一化之后的形状） */
  emit(msg) {
    for (const fn of this.handlers.get('message') ?? []) fn(msg);
  }

  get subscribed() {
    return (this.handlers.get('message')?.size ?? 0) > 0;
  }
}

/** 一条归一化消息的默认样子，测试里只覆写关心的字段 */
export function normalized(over = {}) {
  return {
    messageId: 'om_1',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_alice',
    content: '你好',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    ...over,
  };
}

/**
 * 造一个"官方通道已被换成 FakeLark"的适配器。
 *
 * `makeChannel` 是 protected —— 覆写它不需要任何测试后门，这正是当初
 * 把它抽成一个方法的原因。
 */
export function makeFeishu(config = {}) {
  const fake = new FakeLark();
  class TestFeishu extends FeishuChannel {
    makeChannel() {
      return fake;
    }
  }
  const channel = new TestFeishu(new Context(), {
    appId: 'cli_fake',
    appSecret: 'secret',
    home: config.home ?? '/tmp/butler-feishu-test',
    ...config,
  });
  return { channel, fake };
}
