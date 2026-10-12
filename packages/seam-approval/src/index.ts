/**
 * 审批能力位 —— `ctx.approval`。
 *
 * ── 这个包**只有接口，没有实现** ────────────────────────────────
 *
 *   1. 装这个包，`extends ApprovalService`
 *   2. 实现 `id`、`list()`、`answer()`
 *   3. 给它加 `static Config`，`export default` 你的类
 *
 * ── 为什么接口里**没有 `ask()`** ─────────────────────────────────
 *
 * 设计稿上曾经写着一个 `ask(req): Promise<boolean>`。真做的时候发现：
 * **管家进程里今天没有任何人要发问。** 发问的是 DSH 子进程里的应答者
 * （它跑在另一个进程里，走的是文件协议，不是这个服务位）。跟当年
 * `requestApproval` 被删掉是同一个理由：**没有实现用的接口是猜的。**
 *
 * 所以这个能力位只放**管家这一侧真正要做的事**：
 *
 *   · `list()`  —— 现在有哪些事在等主人点头（要在微信里念给他听）
 *   · `answer()` —— 主人回了一句话，把它落到那件事上
 *
 * 等真出现进程内的发问者（比如哪天要管家自己去删一堆文件），`ask()`
 * 再作为**第二个方法**加进来，形状由那个真需求决定。
 *
 * ── 一条不许变的规矩：**超时 = 不许** ───────────────────────────
 *
 * 没人应答时绝不"先做了再说"，也绝不无限等（M0 实测卡死过 3 分钟）。
 * 实现包必须做到：问出去的事，到点没有答复就是 `deny`，
 * 并且**落进审计**（谁批的、批了什么、还是没人吭声）。
 *
 * ── 还有一条：**读不动要抛，别装作没事** ────────────────────────
 *
 * 审批记录读不动的后果是"主人点过的头不见了"。宁可让调用方看到
 * 一个明确的错误（然后如实告诉主人），也不要静默当成空的。
 * 而**安全的那一侧是自动的**：记录读不动 → 事没人批 → 到点 deny。
 *
 * @module @butler/seam-approval
 */

import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import type { ApprovalBy, ApprovalDecision, ApprovalRequest } from './types.js';

export type * from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService;
  }
}

/**
 * 审批服务的抽象基类。
 *
 * 跟 `ctx.memory` 一样是 `abstract class`：实现者漏掉成员要在**编译期**
 * 就报错 —— 审批这条路上漏一个成员，后果是"该问的没问"。
 */
export abstract class ApprovalService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'approval');
  }

  /** 实现标识，例如 `'im'`。用于日志与 doctor，不参与逻辑分支 */
  abstract readonly id: string;

  /**
   * 现在有哪些事在等主人点头。**旧的在前**（先问的先念）。
   *
   * 已经超时的**不该**出现在这里 —— 那些事按"不许"结算掉了，
   * 再念一遍只会让主人以为还来得及。
   */
  abstract list(): Promise<ApprovalRequest[]>;

  /**
   * 把主人的一句话落到某件事上。
   *
   * 返回 `true` = 记下了；`false` = **没有这件事**（或者它已经超时结算了）。
   * 这两种都要能如实告诉主人 —— "我点了允许但其实早就过期了"
   * 是最坏的一种体验。
   */
  abstract answer(id: string, decision: ApprovalDecision, by?: ApprovalBy): Promise<boolean>;
}
