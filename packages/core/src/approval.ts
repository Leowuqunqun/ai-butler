/**
 * 审批的**呈现层** —— 主人看到的每一句话都在这里。
 *
 * 跟 `memory.ts` 同一个理由：编号只有一处来源。主人看到的「2」，
 * 和 `允许 2` 要批的那一件，必须是同一件 —— 审批上错一位的代价是
 * "允许了一次本来没打算允许的操作"，比记忆里删错一条严重得多。
 *
 * ⚠️ 纯文本，不带 markdown：微信里 `**` 只会原样显示。
 *
 * @module @butler/core/approval
 */

import type { ApprovalRequest } from '@butler/seam-approval';
import { humanLeft, type Grant } from './grants.js';

/** 一次最多念几件。多了就让主人先把在手的那几件处理掉 */
export const APPROVAL_SHOWN_MAX = 10;

/** 主人看得懂的理由：本地化文案优先，最后总有句兜底 —— 不能给他一个空白的判断依据 */
export function approvalReason(req: ApprovalRequest): string {
  return req.displayReason || req.reason || '（它没说理由）';
}

/** 一行的样子：`1. 删除 ~/下载/旧项目（bash）` */
export function approvalLine(index: number, req: ApprovalRequest): string {
  return `${index}. ${approvalReason(req)}（${req.tool}）`;
}

/** 还剩多久。用最早那件的期限 —— 主人只需要知道"我大概有多少时间" */
export function approvalLeftSeconds(list: ApprovalRequest[], now = Date.now()): number | null {
  if (list.length === 0) return null;
  const soonest = Math.min(...list.map((r) => Date.parse(r.expiresAt)));
  return Math.max(0, Math.round((soonest - now) / 1000));
}

/**
 * 推给主人的那条消息。
 *
 * 三件事缺一不可：**要干什么**、**怎么答**、**不答会怎样**。
 * 少了最后一条，主人会以为它可以一直挂着 —— 而它不会：到点就是不许。
 */
export function formatApprovalAsk(list: ApprovalRequest[], now = Date.now()): string {
  const left = approvalLeftSeconds(list, now);
  const head = left === null
    ? '【有件事要动你的电脑，等你一句话】'
    : `【有件事要动你的电脑，等你一句话（${left} 秒内）】`;
  return [
    head,
    '',
    ...list.slice(0, APPROVAL_SHOWN_MAX).map((r, i) => approvalLine(i + 1, r)),
    ...(list.length > APPROVAL_SHOWN_MAX ? [`… 还有 ${list.length - APPROVAL_SHOWN_MAX} 件`] : []),
    '',
    list.length === 1 ? '回「允许」或「不许」就行。' : '回「允许 1」「不许 2」这样，指明是哪一件。',
    '想以后别再问这一类：回「以后这类都行 1」——这一类以后**所有**命令都不再问你（包括删东西）。',
    '（只想这一阵子别问：回「以后这类都行 1，一小时」——到点我自己恢复，不用你记着来收。）',
    '到点我不等到答复，就当不许 —— 不会先做了再说。',
  ].join('\n');
}

/** 「待批」的回答 */
export function formatPending(list: ApprovalRequest[], now = Date.now()): string {
  if (list.length === 0) return '现在没有等你点头的事。';
  return formatApprovalAsk(list, now);
}

/** 没接审批那层 */
export function formatNoApproval(): string {
  return '现在还没接审批 —— 配置里少了 ctx.approval 那一块（把 approval-im 这个插件装上就有了）。';
}

/** 照片对不上号：说清现在一共几件 */
export function formatNoSuchPending(index: number, total: number): string {
  if (total === 0) return `没有第 ${index} 条 —— 现在一件都没有在等你点头。`;
  return `没有第 ${index} 条 —— 现在一共有 ${total} 件在等。`;
}

/** 那件在主人看到之后已经没了（过期结算 / 别人处理了） */
export function formatAlreadyGone(index: number): string {
  return `第 ${index} 条已经不在了 —— 它要么已经超时（超时就是不许），要么刚被处理过。`;
}

/** 有几件在等，但主人没说是哪一件 */
export function formatNeedIndex(total: number): string {
  return `现在有 ${total} 件在等你点头，得说是哪一件 —— 比如「允许 2」。`;
}

/** 一件都没有，主人却说"允许" */
export function formatNothingWaiting(): string {
  return '现在没有等你点头的事 —— 我什么都没做。';
}

export function formatAllowed(index: number, req: ApprovalRequest): string {
  return `好，第 ${index} 条我照办了：${approvalReason(req)}`;
}

export function formatDenied(index: number, req: ApprovalRequest): string {
  return `好，第 ${index} 条我不做：${approvalReason(req)}`;
}

/** 读不动（含隐私的文件坏了、盘出问题了）—— 要如实说，不能装作"没人等你" */
export function formatApprovalBroken(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `审批记录读不动：${text}\n（这件事我**没有**替你做主：需要主人点头而我读不到记录时，一律按不许处理。）`;
}

/** 「以后这类都行」批完之后 —— 必须把**后果**和**怎么收回**一起说清楚 */
export function formatGranted(kind: string, until?: string, now: number = Date.now()): string {
  if (!until) {
    return [
      `好。以后「${kind}」这一类**都不再问你**了 ——`,
      '这一类里删东西、改系统那种，也一样不再问。',
      '',
      '想收回来：回「授权」看看给过哪些，再回「取消授权 1」。',
    ].join('\n');
  }
  return [
    `好。接下来${humanLeft(until, now)}里，「${kind}」这一类**都不再问你**了 ——`,
    '这一类里删东西、改系统那种，也一样不再问（就这一段时间）。',
    `过点我照旧问你，不用你记着来收。`,
    '',
    '想提前收回来：回「授权」看看给过哪些，再回「取消授权 1」。',
  ].join('\n');
}

/** 期限那句没读懂 —— **一条都不许记**（没看懂就当永远，是最坏的猜法） */
export function formatGrantWindowUnclear(kind: string, why: string): string {
  return [
    `这件我照办了，但**长期授权没记**：${why}。`,
    `所以「${kind}」这一类以后照旧问你。`,
    '',
    '想给期限就说「以后这类都行 1 一小时」（也认 30 分钟 / 两小时 / 一天 / 3 天，最多 7 天）；',
    '想一直免问就别写时间：回「以后这类都行 1」。',
  ].join('\n');
}

/** 「授权」列出来的那份 */
export function formatGrants(grants: readonly Grant[], now: number = Date.now()): string {
  if (!grants.length) {
    return [
      '你还没给过长期授权 —— 每件事都要你点头才动。',
      '',
      '（想少被打断：下次收到「等你一句话」时，回「以后这类都行 1」。）',
    ].join('\n');
  }
  const live = grants.filter((g) => !g.until || Date.parse(g.until) > now).length;
  return [
    `你给过 ${grants.length} 条长期授权（其中 ${live} 条现在生效 —— 这些事**不问你**就直接办）：`,
    '',
    ...grants.map((g, i) => {
      const tail = g.until ? `，${humanLeft(g.until, now)}` : '';
      return `  ${i + 1}. ${g.kind}　（${g.at.slice(0, 10)} 给的${tail}）`;
    }),
    '',
    '收回：回「取消授权 1」这样，编号就是上面这个。',
  ].join('\n');
}

/** 授权记录读不动：如实说，并且说清这时候会怎样（每次都问） */
export function formatGrantsBroken(why: string): string {
  return [
    `授权记录读不动：${why}`,
    '',
    '所以现在**一条长期授权都不算数** —— 每件事都会照常问你。',
    '（宁可多问你一句，也不能拿一份读不明白的授权去替你放行。）',
  ].join('\n');
}

export function formatRevoked(index: number, grant: Grant, left: number): string {
  return `好，第 ${index} 条收回了：${grant.kind} 以后照常问你。\n（还剩 ${left} 条长期授权。）`;
}

export function formatNoSuchGrant(index: number, total: number): string {
  return total === 0
    ? `没有第 ${index} 条 —— 你还没给过长期授权。`
    : `没有第 ${index} 条 —— 现在一共 ${total} 条（回「授权」看看）。`;
}
