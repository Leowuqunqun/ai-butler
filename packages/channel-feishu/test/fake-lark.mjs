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
 * 类型声明来（`on/connect/disconnect/send/reply/fetchMessage/botIdentity`）。
 *
 * @module @butler/channel-feishu/test/fake-lark
 */

import { Context } from '@deepseek-ai/cordis';
import { FeishuChannel } from '../lib/index.js';

export class FakeLark {
  sent = [];
  replies = [];
  connected = false;
  identity = { openId: 'ou_fake_bot', name: '管家的测试身份' };
  fetched = new Map();
  handlers = new Map();

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
    this.connected = true;
  }

  async disconnect() {
    this.connected = false;
  }

  async send(to, input) {
    this.sent.push({ to, input });
    return { messageId: `om_sent_${this.sent.length}` };
  }

  async reply(target, input) {
    this.replies.push({ target, input });
    return { messageId: `om_reply_${this.replies.length}`, chunkIds: ['om_c1'] };
  }

  async fetchMessage(messageId) {
    return this.fetched.get(messageId);
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
