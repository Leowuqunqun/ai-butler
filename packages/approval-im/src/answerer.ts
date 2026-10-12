/**
 * dsh 那一侧的应答者 —— **挂进 dsh 子进程里的一个插件**。
 *
 * ── 它是什么 ────────────────────────────────────────────────────
 *
 * dsh 在做敏感操作之前，会把问题挂到 `approval/request` 这个瀑布式事件上
 * （`@deepseek-ai/dsh-user-approval` 的服务只负责分发，**应答者是可组合的**）。
 * headless 里默认没有任何应答者，所以以前的补丁只能把策略钉成 `never`
 * —— 那是"一律拒绝"：安全，但管家什么也干不了。
 *
 * 这个插件就是那个缺失的应答者：收到问题 → 写到管家看得见的地方 →
 * 等主人回话 → 把 dsh 的四种结局之一交回去。
 *
 * ── 四种结局，一个都不能含糊 ────────────────────────────────────
 *
 *   allowed-once   主人说了"允许"（**只此一次**，不做通配授权）
 *   rejected       主人说了"不许"，**或者到点没人答**（超时 = 不许）
 *   cancelled      问题被撤回了（agent 那侧中止了这次调用）
 *   unavailable    我们连问题都没记下来（盘不可写等）→ 让 dsh **按拒绝处理**
 *
 * `unavailable` 是关键的一条：记不下来就是问都没问成，绝不能"那就当允许吧"。
 *
 * ── ⚠️ 这份形状是照抄 dsh 的，但**故意不依赖 dsh 包** ─────────────
 *
 * 应答者跑在 dsh 的容器里，当然要对得上它的形状；但把 `@deepseek-ai/dsh-*`
 * 拉进依赖，等于让"通道/审批"这一侧跟着 dsh 的发布节奏走 —— 那是**另一侧**
 * 的实现细节。所以这里自己声明形状（`approval/request` 事件 + 四个结局词），
 * 用测试钉住；dsh 换了形状，测试会先红。
 *
 * @module @butler/approval-im/answerer
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';

import {
  DEFAULT_TIMEOUT_MS,
  approvalsDir,
  audit,
  claim,
  clearPending,
  makeRequest,
  postRequest,
  readAnswer,
} from './mailbox.js';

/**
 * dsh 挂上来的那个问题。字段名照抄 `@deepseek-ai/dsh-user-approval`
 * 的 `ApprovalRequestEvent`（只声明我们真用到的部分）。
 */
export interface ApprovalRequestEvent {
  /** dsh 的 agent。我们只用它的身份字符串记账 */
  readonly agent?: { id?: string; session?: { id?: string } };
  /** 想动的是哪个工具 */
  readonly toolName: string;
  /** dsh 那侧的工具调用编号 */
  readonly callId?: unknown;
  /** 为什么要动 —— 给主人看的理由 */
  readonly reason?: string;
  /** 本地化展示文案（不改写 `reason`） */
  readonly displayReason?: { en?: string; [locale: string]: string | undefined };
  /** 中止信号：agent 不想要这个决定了 */
  readonly signal?: AbortSignal;
}

/** dsh 的封闭结局词表 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 问应答者要一个决定。**返回一个结局 = 认领这次请求**，`next()` = 交给下一个。
     * 这个插件是部署里的**最终应答者**，所以从不 `next()`。
     */
    'approval/request'(
      req: ApprovalRequestEvent,
      next: () => ApprovalOutcome | Promise<ApprovalOutcome>,
    ): ApprovalOutcome | Promise<ApprovalOutcome>;
  }
}

export interface AnswererConfig {
  /** 管家数据目录。空串 = `~/.butler` */
  home: string;
  /** 待批文件在哪（要和管家那一侧**同一个目录**）。空串 = `<home>/state/approvals` */
  dir: string;
  /** 等主人多久 */
  timeoutMs: number;
  /** 多久看一眼有没有答复 */
  pollMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 主人看得懂的理由：优先本地化文案，最后总有句兜底 —— 不能给他一个空白的判断依据 */
export function ownerReason(req: ApprovalRequestEvent): string {
  const localized = req.displayReason?.zh ?? req.displayReason?.['zh-CN'] ?? req.displayReason?.en;
  return localized || req.reason || '（它没说理由）';
}

/** dsh 的 agent 身份，只用来记账 */
export function agentName(req: ApprovalRequestEvent): string {
  return req.agent?.session?.id ?? req.agent?.id ?? 'dsh';
}

export class ImApprovalAnswerer {
  // 全部给 default —— 漏填也不能让"审批"这一环静默失效
  static Config = z.object({
    home: z.string().default(''),
    dir: z.string().default(''),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    pollMs: z.number().default(500),
  }).description('把 dsh 的审批问题交给主人（写进待批目录），超时按不许');

  readonly dir: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  /** 想用假时钟测超时的时候用得上 */
  readonly now: () => number;

  constructor(ctx: Context, config: AnswererConfig) {
    this.dir = approvalsDir(config);
    this.timeoutMs = config.timeoutMs;
    this.pollMs = config.pollMs;
    this.now = () => Date.now();
    ctx.on('approval/request', (req) => this.handle(req));
  }

  private async handle(req: ApprovalRequestEvent): Promise<ApprovalOutcome> {
    const request = makeRequest({
      agent: agentName(req),
      tool: req.toolName,
      reason: req.reason ?? '',
      displayReason: ownerReason(req),
      ...(req.callId === undefined ? {} : { callId: String(req.callId) }),
      timeoutMs: this.timeoutMs,
      now: this.now(),
    });

    // ① 先挂出去。**挂不出去就别问** —— 问都没问成，只能按拒绝处理
    try {
      postRequest(this.dir, request);
    } catch {
      return 'unavailable';
    }

    // ② 等主人。三件事哪个先到就听哪个：答复、中止、到点
    const deadline = this.now() + this.timeoutMs;
    while (this.now() < deadline) {
      if (req.signal?.aborted) return this.settleAs('withdrawn', 'cancelled', request);
      const answer = readAnswer(this.dir, request.id);
      if (answer) {
        clearPending(this.dir, request.id);
        if (answer.by === 'withdrawn') return 'cancelled';
        return answer.decision === 'allow' ? 'allowed-once' : 'rejected';
      }
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }

    // ③ 到点了：**超时 = 不许**（而且是记了账的不许）
    return this.settleAs('timeout', 'rejected', request);
  }

  /** 自己结算（超时/撤回）：谁先写谁记账，别人写过了就读他的 */
  private settleAs(
    by: 'timeout' | 'withdrawn',
    outcome: 'rejected' | 'cancelled',
    request: { id: string; agent: string; tool: string; reason: string; createdAt: string },
  ): ApprovalOutcome {
    const { won } = claim(this.dir, request.id, 'deny', by);
    if (won) {
      audit(this.dir, {
        id: request.id,
        agent: request.agent,
        tool: request.tool,
        reason: request.reason,
        outcome,
        by,
        at: new Date(this.now()).toISOString(),
        createdAt: request.createdAt,
      });
    }
    clearPending(this.dir, request.id);
    return outcome;
  }
}

export default ImApprovalAnswerer;
