/**
 * 手写的类型声明 —— 实现是 `plugin.mjs`（JS），这里只给消费方类型。
 *
 * 为什么不上 TypeScript：这个包里还有 2000 行跑得好好的 JS（CLI、协议、
 * 媒体解密），为了新加一个插件就整体迁 TS，会把一次改动变成三次。
 * 所以走"JS 实现 + 手写 .d.ts"：**消费方（核心层）拿到完整类型**，
 * 迁移等单独一轮做。
 *
 * 防漂移：`test/plugin-types.mjs` 会拿这份声明和运行时真实成员对一遍，
 * 声明里多写了什么、少写了什么都会红。
 */

import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
import type { InboundMessage, LocalFile, SendOpts, SendResult } from '@butler/seam-channel';
import { ChannelService } from '@butler/seam-channel';

/**
 * 插件的配置。
 *
 * 每个字段都有默认值，所以**调用方只需要传想改的那几个** ——
 * 这一点体现在构造函数收的是 `Partial<...>`：cordis 的 `ctx.plugin(P, cfg)`
 * 配置类型取自构造函数签名，不是 `static Config`。
 * 补默认值是 schema 在构造前做的，所以实例上的 `config` 是补全后的完整类型。
 */
export interface WechatChannelConfig {
  /** 数据目录：token / 游标 / 收件箱都在它的 state/ 下。空 = 当前工作目录 */
  home: string;
  /** 服务端地址，一般不用改 */
  baseUrl: string;
  /** 粗筛：只服务这些 userId。空数组 = 不筛。**这不是权限门** */
  allowFrom: string[];
  /** 发"正在输入" */
  typing: boolean;
  /** 收到图片/文件时下载并落盘 */
  mediaEnabled: boolean;
  /** CDN 地址，一般不用改 */
  cdnBaseUrl: string;
  /** 单个附件上限 */
  maxMediaBytes: number;
  /** 单条回复的字符上限 */
  replyChars: number;
}

/** 微信通道：实现 `ctx.channel` 的 cordis 插件 */
export declare class WechatChannel extends ChannelService {
  /**
   * 配置的 schema（schemastery）。
   *
   * **这里不能写 `unknown`** —— cordis 的 `Plugin.Base` 要求 `Config` 是
   * `StandardSchemaV1`，写成 `unknown` 会让 `ctx.plugin(WechatChannel, …)`
   * 直接编译不过。这是靠 `test/fixtures/consumer.ts` 那个消费方探针抓出来的。
   */
  static Config: Schema<Partial<WechatChannelConfig>, WechatChannelConfig>;

  readonly config: WechatChannelConfig;
  readonly id: string;

  constructor(ctx: Context, config?: Partial<WechatChannelConfig>);

  /** 造协议客户端。子类重写它就能换成假的，测试用 */
  createIlink(): unknown;

  /** 开始收信。没登录会抛错（提示先跑扫码） */
  start(): Promise<void>;
  /** 停止收信。没 start 过也能安全调用 */
  stop(): Promise<void>;

  /** 归一化一条来信并排队（附件还没下载）。导出只为测试 */
  enqueue(msg: unknown): void;
  /** 取回一个附件并落进收件箱 */
  fetchInbound(sel: unknown): Promise<LocalFile>;

  sendText(to: string, text: string, opts?: SendOpts): Promise<SendResult>;
  sendFile(to: string, path: string, opts?: SendOpts): Promise<SendResult>;
  setTyping(to: string, on: boolean, opts?: SendOpts): Promise<void>;
}

export type { InboundMessage, LocalFile, SendOpts, SendResult };
export default WechatChannel;
