/**
 * 测试用假链路 —— **故意用 TypeScript 写**。
 *
 * 它同时验证两件事：
 *   1. 类型契约成立：一个实现者能正确地 `extends LinkService`
 *      （抽象成员漏了就编译不过）
 *   2. 运行行为成立：编译产物作为 cordis 插件加载后，`ctx.link` 就位
 */
import z from '@deepseek-ai/schemastery';
import { Context, Service } from '@deepseek-ai/cordis';
import { LinkService } from '@butler/seam-link';
import type { DeviceInfo, HealthCheck, LinkRequestOpts, LinkSession } from '@butler/seam-link';

/** 被 inject 的假依赖，用来验证服务位门控 */
export class MemoryService extends Service {
  readonly notes = new Map<string, string>();
  disposed = false;

  constructor(ctx: Context) {
    super(ctx, 'memory');
    ctx.effect(() => () => { this.disposed = true; }, 'memory.dispose');
  }
}

/** 一条假会话：把请求原样记下来，按脚本回流事件 */
export class FakeSession implements LinkSession {
  readonly deviceId: string;
  readonly calls: { method: string; params: unknown }[] = [];
  readonly closeHandlers: ((reason?: string) => void)[] = [];
  closed = 0;
  /** 请求里调了几次 close —— 用来验证幂等 */
  private _closed = false;

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  async request(method: string, params: unknown, opts?: LinkRequestOpts): Promise<unknown> {
    this.calls.push({ method, params });
    // 模拟：先报一行进度，再返回结果
    opts?.onEvent?.({ type: 'progress', callId: `${method}#1`, line: '正在干活' });
    const result = { ok: true, method };
    opts?.onEvent?.({ type: 'done', callId: `${method}#1`, result });
    return result;
  }

  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.closed++;
    for (const h of [...this.closeHandlers]) h('测试主动关的');
  }

  /** 测试用：模拟节点掉线 */
  drop(reason: string): void {
    for (const h of [...this.closeHandlers]) h(reason);
  }
}

export class FakeLink extends LinkService {
  static inject = ['memory'];
  static Config = z.object({
    secret: z.string().default('shared-secret'),
    /** 静态节点表：没有广播的环境（CI、跨网）靠它 */
    peers: z.array(z.object({
      id: z.string(),
      alias: z.string(),
      host: z.string(),
      port: z.number().default(41337),
    })).default([]),
  });

  /** 配置类型手写：schemastery 的 infer 在这个项目里没用（见内核的注释） */
  readonly config: {
    secret: string;
    peers: { id: string; alias: string; host: string; port: number }[];
  };

  constructor(ctx: Context, config: {
    secret: string;
    peers: { id: string; alias: string; host: string; port: number }[];
  }) {
    super(ctx);
    this.config = config;
  }

  readonly id = 'fake';
  readonly sessions: FakeSession[] = [];
  discovered: DeviceInfo[] = [];
  checks: HealthCheck[] = [];

  async discover(): Promise<DeviceInfo[]> {
    // 静态节点表 + 一个"看得见但连不上"的设备：验证 online 与 lastSeen 是独立的
    return [
      ...this.config.peers.map((p) => ({
        id: p.id, alias: p.alias, os: 'linux', capabilities: ['agent'],
        lastSeen: Date.now(), online: true, link: this.id,
      })),
      { id: 'node-far', alias: '公司那台', os: 'linux', capabilities: ['agent'],
        lastSeen: null, online: false, link: this.id },
    ];
  }

  async connect(deviceId: string): Promise<LinkSession> {
    if (deviceId === 'node-far') throw new Error(`连不上 ${deviceId}：它现在离线`);
    const s = new FakeSession(deviceId);
    this.sessions.push(s);
    return s;
  }

  override check(): HealthCheck[] {
    return this.checks;
  }
}
