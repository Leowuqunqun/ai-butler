/**
 * 通道能力位 —— `ctx.channel`。
 *
 * ── 这个包**只有接口，没有实现** ────────────────────────────────
 *
 * 想接入一个新的 IM（Telegram、飞书、企业微信、Slack……），你要做的是：
 *
 *   1. 装这个包，`extends ChannelService`
 *   2. 实现下面几个 abstract 方法
 *   3. 给它加 `static Config`（要 zod 风格校验就用 @deepseek-ai/schemastery）
 *   4. `export default` 你的类 —— 它就成了一个 cordis 插件
 *
 * 核心层只认 `ctx.channel`，不认"微信"。所以换通道**不需要改核心层一行代码**。
 *
 * ── 用法（核心层视角）────────────────────────────────────────────
 *
 *     // 插件加载时注册消费者；cordis 会在卸载时自动摘掉
 *     ctx.inject(['channel'], (ctx) => {
 *       ctx.channel.onMessage((msg) => { ... })
 *     })
 *
 * ── 实现者必须遵守的三条 ─────────────────────────────────────────
 *
 * 1. **附件要落成本机文件再交出去。** 远端下载/解密/转码都是通道自己的事，
 *    见 `LocalFile` 的注释。核心层拿到 `path` 就该能直接读。
 * 2. **不要在构造函数里开始收信。** 由核心层显式调用 `start()`——
 *    加载插件 ≠ 立刻上线（扫码登录之前就不该轮询）。
 * 3. **`emitMessage` 的调用不能阻塞收信循环。** 核心层处理慢是核心层的事，
 *    通道要保证自己一直在收（本项目微信实现的收/干分离就是这么来的）。
 *
 * @module @butler/seam-channel
 */

import { Context, Service } from '@deepseek-ai/cordis';
import type { HealthCheck, InboundMessage, SendOpts, SendResult } from './types.js';

export type * from './types.js';
export * from './quote.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channel: ChannelService;
  }
}

/**
 * 通道服务的抽象基类。
 *
 * 继承它、实现抽象方法、`export default`，就是一个可加载的 cordis 插件；
 * 它会把自己注册为 `ctx.channel`。**一个 context 只能有一个通道实现**——
 * 加载第二个会抛错（cordis 对重复服务位的标准行为）。
 */
export abstract class ChannelService extends Service {
  /** 消费者列表。由 `onMessage` 增长，随服务实例一起被回收 */
  private readonly handlers: ((msg: InboundMessage) => void)[] = [];

  constructor(ctx: Context) {
    super(ctx, 'channel');
  }

  /** 通道标识，例如 `'wechat'`。用于日志和流水，不参与逻辑分支 */
  abstract readonly id: string;

  /**
   * 开始收信。实现内部怎么收都行（长轮询 / webhook / websocket）。
   * 必须幂等：重复调用不应起两个循环。
   */
  abstract start(): Promise<void>;

  /** 停止收信并释放资源。必须能安全地在没 start 过时调用 */
  abstract stop(): Promise<void>;

  /** 发一条文本。超长文本由实现自行分条 */
  /**
   * 发一段文本。
   *
   * 两件事都归**实现**管，内核不插手：超出上限怎么分条（`opts.maxChars`），
   * 以及"在回哪句"怎么显示（`opts.quote`，微信只能顶一行文本、Telegram 走原生引用）。
   */
  abstract sendText(to: string, text: string, opts?: SendOpts): Promise<SendResult>;

  /** 发一个本机文件 */
  abstract sendFile(to: string, path: string, opts?: SendOpts): Promise<SendResult>;

  /**
   * 自检（**可选**）。返回的每一条都会原样出现在 `butler doctor` 的输出里。
   *
   * 为什么放在 seam 上，而不是让 doctor 从外面查：**只有实现自己知道该验什么**。
   * 微信通道知道登录态存在哪、dsh 知道它需要哪个二进制、exec 知道 argv[0] 在不在。
   * 让 doctor 去猜，就得把每个实现的配置 schema 抄一份 —— 那是维护灾难，也是层次错误。
   *
   * 几条约定：
   *   - **不抛错**。真出意外就返回一条 `ok: false` 并说明，别让整个自检挂掉。
   *   - **别做重活**。只查前置条件（文件在不在、登录态有没有、目录可不可写），
   *     不要真跑一次任务。
   *     **唯一允许的联网是一次"有时限的探活"**（比如 Telegram 问一句 `getMe`：
   *     这串 token 还认不认 —— 免费、不要权限，能查出"昨天还好好的、今天不回
   *     消息"这种光看文件看不出来的事）。但必须**有上限**，而且**连不上不算故障**
   *     （说"这次没查"，仍然 ok: true）：网一断就报红，只会让用户去修一个
   *     不存在的问题。
   *   - **没实现就是没有**，doctor 会跳过 —— 这是可选的，不是必须的。
   */
  check?(): Promise<HealthCheck[]> | HealthCheck[];

  /**
   * "正在输入"。**best-effort**：不支持就静默返回，不许抛错，
   * 更不许因为这个失败影响真正的回复。
   */
  async setTyping(_to: string, _on: boolean, _opts?: SendOpts): Promise<void> {}

  /**
   * 注册消息消费者。基础类已经实现了分发，实现者不需要重写。
   * 同一个 handler 注册两次会被去重（避免热重载时收两遍）。
   */
  onMessage(handler: (msg: InboundMessage) => void): void {
    if (!this.handlers.includes(handler)) this.handlers.push(handler);
  }

  /** 注销消费者（一般不用手动调，context 卸载时会一起走） */
  offMessage(handler: (msg: InboundMessage) => void): void {
    const i = this.handlers.indexOf(handler);
    if (i >= 0) this.handlers.splice(i, 1);
  }

  /**
   * **给实现调用的**：收到一条消息时交给核心层。
   *
   * 单个消费者抛错不会影响其他消费者，也不会把通道的收信循环打断——
   * 消费者的 bug 不该让整条通道掉线。
   */
  protected emitMessage(msg: InboundMessage): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(msg);
      } catch (error) {
        this.ctx.logger?.error('channel %s: 消息消费者抛错: %o', this.id, error);
      }
    }
  }
}

export default ChannelService;
