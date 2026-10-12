/**
 * `ctx.approval` 的第一个实现 —— **把审批问进对话里**。
 *
 * ── 它管的是"管家这一侧" ────────────────────────────────────────
 *
 * 真正发问的是 dsh 子进程里的应答者（`@butler/approval-im/answerer`）。
 * 这个类管的是另一半：把待批的事念给主人听、把主人的答复落回去。
 *
 *   · `list()`   —— 现在有哪些事在等主人点头（旧的在前）
 *   · `answer()` —— 主人说了"允许"/"不许"，落到那件事上
 *
 * ── 两个顺手做掉、但不做的后果很严重的动作 ──────────────────────
 *
 * 1. `list()` 会**顺手把过期的按"不许"结算掉**（`sweep`）。不结算的话，
 *    那些事会永远挂在待批清单里 —— 而设计里说过期就是不许，
 *    让主人以为"还来得及"是比拒绝更坏的结果。
 * 2. 结算完之后，`<id>.json` 拿掉、`<id>.answer` **留着**：它是"这件事
 *    已经有结论"的唯一凭据。谁先到谁写（O_EXCL），所以同一次审批
 *    只会留一行账。
 *
 * @module @butler/approval-im
 */

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { ApprovalService } from '@butler/seam-approval';
import type { ApprovalBy, ApprovalDecision, ApprovalRequest } from '@butler/seam-approval';

import {
  DEFAULT_TIMEOUT_MS,
  approvalsDir,
  audit,
  claim,
  clearPending,
  findPending,
  pruneAnswers,
  readPending,
  sweep,
} from './mailbox.js';

export interface ImApprovalConfig {
  /** 管家数据目录。空串 = `~/.butler` */
  home: string;
  /** 待批/审计文件放哪儿。空串 = `<home>/state/approvals` */
  dir: string;
  /** 等主人多久。到点就是不许 */
  timeoutMs: number;
}

export class ImApproval extends ApprovalService {
  // 全部给 default、不用 .required() —— 本项目的既定写法（见 ARCH-technical §5）
  static Config = z.object({
    home: z.string().default(''),
    dir: z.string().default(''),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  }).description('把审批问进对话里：主人说行才做，到点没人答就是不行');

  readonly id = 'im';
  /** 文件在哪 —— `doctor` 和排错都要看它 */
  readonly dir: string;
  readonly timeoutMs: number;

  constructor(ctx: Context, config: ImApprovalConfig) {
    super(ctx);
    this.dir = approvalsDir(config);
    this.timeoutMs = config.timeoutMs;
  }

  async list(): Promise<ApprovalRequest[]> {
    sweep(this.dir);            // 过期的先按"不许"结掉，别让主人以为还来得及
    pruneAnswers(this.dir);     // 老凭据别堆到天荒地老（账在 approvals.jsonl 里）
    return readPending(this.dir);
  }

  async answer(id: string, decision: ApprovalDecision, by: ApprovalBy = 'owner'): Promise<boolean> {
    // 先看这件事在不在：不在就别写答案 —— 不然"允许第 9 条"会给一个
    // 不存在的编号留下一行"主人批过"的账
    // **先读请求、再结算**：结算之后它就带上凭据、不在待批清单里了
    const req = findPending(this.dir, id);
    if (!req) return false;
    const { won } = claim(this.dir, id, decision, by);
    if (!won) return false;     // 别人先到（多半是到点结算了）
    audit(this.dir, {
      id,
      agent: req.agent,
      tool: req.tool,
      reason: req.reason,
      outcome: decision === 'allow' ? 'allowed-once' : 'rejected',
      by,
      at: new Date().toISOString(),
      createdAt: req.createdAt,
    });
    clearPending(this.dir, id);
    return true;
  }
}

export default ImApproval;
export type * from './mailbox.js';
export { approvalsDir } from './mailbox.js';
