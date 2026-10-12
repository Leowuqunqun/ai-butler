/**
 * 审批这件事的数据形状。
 *
 * 这些形状是**从实现里长出来的**（`@butler/approval-im`），不是先画好
 * 再逼实现满足 —— 见 ARCH-technical §"审批：为什么到现在才定接口"。
 */

/** 一次"要动你的电脑"的请求 —— 它就是主人会在微信里看到的那件事 */
export interface ApprovalRequest {
  /** 这件事的编号。`answer(id, …)` 靠它认人 */
  id: string;
  /** 哪个 agent 在问（`'dsh'` / `'exec'`） */
  agent: string;
  /** 想干什么（工具名，例如 `bash`） */
  tool: string;
  /** 为什么要干 —— 给主人看的理由。**这是唯一能让主人做判断的东西** */
  reason: string;
  /** 可选的本地化展示文案（不改写日志里的 `reason`） */
  displayReason?: string;
  /** agent 侧的调用编号，用于把决定对回它自己那次工具调用 */
  callId?: string;
  /** 什么时候问的（ISO 8601） */
  createdAt: string;
  /** 等到什么时候算默认不许（ISO 8601）。**超时 = 不许**，不是"再等等" */
  expiresAt: string;
}

/** 决定只有两种。没有"部分允许"，也没有"先做了再说" */
export type ApprovalDecision = 'allow' | 'deny';

/**
 * 这个决定是谁下的 —— 审计里要能分清"主人当场点的头"、"他以前给过的长期授权"、
 * 和"没人吭声"。
 *
 * `'grant'` 这一项非有不可：主人说过「以后这类都行」之后，是我们**替他**放行的。
 * 账本上要是写成 `'owner'`，出了事它会指着主人说"这是你批的" —— 而他没有。
 */
export type ApprovalBy = 'owner' | 'timeout' | 'grant';
