/**
 * 测试用假通道 —— **故意用 TypeScript 写**。
 *
 * 它同时验证两件事：
 *   1. 类型契约成立：一个消费者能正确地 `extends ChannelService`
 *      （抽象成员漏了就编译不过）
 *   2. 运行行为成立：编译产物作为 cordis 插件加载后，`ctx.channel` 就位
 */
import z from '@deepseek-ai/schemastery';
import { Context, Service } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';
import type { InboundMessage, LocalFile, SendOpts, SendResult } from '@butler/seam-channel';

/** 被 inject 的假依赖，用来验证服务位门控 */
export class MemoryService extends Service {
  readonly notes = new Map<string, string>();
  disposed = false;

  constructor(ctx: Context) {
    super(ctx, 'memory');
    ctx.effect(() => () => { this.disposed = true; }, 'memory.dispose');
  }
}

export class FakeChannel extends ChannelService {
  static inject = ['memory'];
  static Config = z.object({
    greeting: z.string().default('你好'),
    maxChars: z.number().default(1200),
  });

  readonly id = 'fake';
  readonly sent: { to: string; text: string; opts?: SendOpts }[] = [];
  readonly sentFiles: { to: string; path: string }[] = [];
  readonly typing: { to: string; on: boolean }[] = [];
  started = false;
  startCount = 0;

  constructor(ctx: Context, config: { greeting: string; maxChars: number }) {
    super(ctx);
    this.config = config;
    // 收尾走 effect（cordis 4 没有 dispose 事件）
    ctx.effect(() => () => { this.started = false; }, 'fakeChannel.stop');
  }

  readonly config: { greeting: string; maxChars: number };

  async start(): Promise<void> {
    this.started = true;
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async sendText(to: string, text: string, opts?: SendOpts): Promise<SendResult> {
    this.sent.push({ to, text, opts });
    return { chunks: 1 };
  }

  async sendFile(to: string, path: string): Promise<SendResult> {
    this.sentFiles.push({ to, path });
    return { fileName: path.split('/').pop(), size: 7 };
  }

  override async setTyping(to: string, on: boolean): Promise<void> {
    this.typing.push({ to, on });
  }

  /** 测试用：模拟通道收到一条消息 */
  push(msg: Omit<InboundMessage, 'channel' | 'fromId'>, files?: LocalFile[]): void {
    this.emitMessage({ ...msg, channel: this.id, fromId: 'u1', files });
  }
}

export default FakeChannel;
