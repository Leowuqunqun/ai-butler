/**
 * 测试用假审批 —— **故意用 TypeScript 写**（跟 seam-memory 的假记忆同一个理由）：
 * 类型契约（抽象成员有没有漏）和运行行为一起被验证。
 *
 * 真实现在 `approval-im`（在对话里问主人）。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { ApprovalService } from '@butler/seam-approval';
import type { ApprovalBy, ApprovalDecision, ApprovalRequest } from '@butler/seam-approval';

/** 被 inject 的假依赖，用来验证服务位门控 */
export class OwnerService extends Service {
  disposed = false;

  constructor(ctx: Context) {
    super(ctx, 'owner');
    ctx.effect(() => () => { this.disposed = true; }, 'owner.dispose');
  }
}

/** 契约里"读不动要抛"那一侧：让每个方法都炸 */
export class BrokenApproval extends ApprovalService {
  readonly id = 'broken';

  async list(): Promise<ApprovalRequest[]> {
    throw new Error('审批记录读不动：/tmp/approvals');
  }

  async answer(): Promise<boolean> {
    throw new Error('审批记录读不动：/tmp/approvals');
  }
}

/** 全在内存里的待批清单 —— 够用来跑契约 */
export class FakeApproval extends ApprovalService {
  readonly id = 'fake';
  /** 旧的在先（`list` 的契约） */
  readonly pending: ApprovalRequest[] = [];
  /** 已结算的 `id → 决定`，用来验"同一件事不许批两次" */
  readonly settled = new Map<string, ApprovalDecision>();
  /** 打开它就让每个方法都炸（验"读不动要抛"） */
  broken: Error | null = null;

  private tick = 0;

  private stamp(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }

  /** 造一件事挂上去（应答者干的就是这件事） */
  ask(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
    const req: ApprovalRequest = {
      id: over.id ?? `r${this.pending.length + 1}`,
      agent: over.agent ?? 'dsh',
      tool: over.tool ?? 'bash',
      reason: over.reason ?? '执行一条命令',
      createdAt: over.createdAt ?? this.stamp(),
      expiresAt: over.expiresAt ?? '2026-01-01T00:01:00.000Z',
      ...(over.displayReason === undefined ? {} : { displayReason: over.displayReason }),
      ...(over.callId === undefined ? {} : { callId: over.callId }),
    };
    this.pending.push(req);
    return req;
  }

  private guard(): void {
    if (this.broken) throw this.broken;
  }

  async list(): Promise<ApprovalRequest[]> {
    this.guard();
    return [...this.pending];
  }

  async answer(id: string, decision: ApprovalDecision, by: ApprovalBy = 'owner'): Promise<boolean> {
    this.guard();
    const i = this.pending.findIndex((r) => r.id === id);
    if (i < 0) return false;                  // 没有这件事（或已经结算过）：**不许**当成功
    this.pending.splice(i, 1);
    this.settled.set(id, decision);
    void by;
    return true;
  }
}
