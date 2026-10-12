/**
 * 测试用假 agent —— **故意用 TypeScript 写**。
 *
 * 它同时验证两件事：
 *   1. 类型契约成立：一个实现者能正确地 `extends AgentService`
 *      （抽象成员漏了就编译不过）
 *   2. 运行行为成立：编译产物作为 cordis 插件加载后，`ctx.agent` 就位
 */
import z from '@deepseek-ai/schemastery';
import { Context, Service } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import type { AgentRequest, AgentResult } from '@butler/seam-agent';

/** 被 inject 的假依赖，用来验证服务位门控 */
export class MemoryService extends Service {
  readonly notes = new Map<string, string>();
  disposed = false;

  constructor(ctx: Context) {
    super(ctx, 'memory');
    ctx.effect(() => () => { this.disposed = true; }, 'memory.dispose');
  }
}

export interface FakeAgentConfig {
  greeting: string;
  delayMs: number;
  /** 让 run 抛异常，用来验证核心层的兜底 */
  boom: boolean;
}

export class FakeAgent extends AgentService {
  static inject = ['memory'];
  static Config = z.object({
    greeting: z.string().default('你好'),
    delayMs: z.number().default(0),
    boom: z.boolean().default(false),
  });

  readonly id = 'fake';
  override readonly label = '假 agent';
  override readonly cancellable = true;

  /** 每次 run 的入参，测试用来断言"契约字段真的传到了" */
  readonly seen: AgentRequest[] = [];
  runCount = 0;

  constructor(ctx: Context, readonly config: FakeAgentConfig) {
    super(ctx);
    ctx.effect(() => () => { this.runCount = -1; }, 'fakeAgent.stop');
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    this.seen.push(req);
    this.runCount += 1;

    if (this.config.boom) throw new Error('假 agent 故意炸了');
    if (this.config.delayMs) {
      await new Promise((r) => { setTimeout(r, this.config.delayMs); });
    }

    req.onProgress?.('跑了一半');

    return {
      sessionId: req.sessionId ?? 's-1',
      text: `${this.config.greeting}：${req.text}`,
      files: req.files?.length
        ? [{ path: req.files[0]!.path, caption: '你要的文件' }]
        : undefined,
    };
  }
}

export default FakeAgent;
