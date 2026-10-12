/**
 * 「以后这类不用问了」—— 主人给的、**长期**的授权。
 *
 * 为什么要有它：管家每天都得问好几遍"能不能动你的电脑"。问到最后主人就不看了 ——
 * 那不叫安全，那叫**审批疲劳**，而疲劳的人会闭着眼回「允许」。
 *
 * 所以给一条**明说、看得见、收得回**的路：
 *
 *   · 只有主人**自己打出那句话**才会记下（形如「以后这类都行 2」）。
 *   · 记下的是**这一类的全部**（按 `agent:tool` 分，例如 `dsh:bash`）——
 *     所以那句话在微信里必须把后果写清楚：这一类以后**所有**命令都不再问。
 *   · 靠它自动放行时，审计里写 `by: 'grant'`，**绝不冒名写成"主人当场点的头"**。
 *     不然出了事，账本会指着主人说"这是你批的"，而他没有。
 *   · 随时「授权」看有哪些、「取消授权 N」收回。
 *
 * **读不动这个文件时，一条都不算数** —— 退回到"每次都问"。
 * 宁可多问一句，不能少问一句。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Grant {
  /** 哪一类：`<agent>:<tool>`，例如 `dsh:bash` */
  kind: string;
  /** 什么时候给的（ISO 8601）—— 收回顾的时候主人要能认出来 */
  at: string;
  /**
   * 到什么时候为止（ISO 8601）。**没有这一项 = 永远**（老记录就是这样，照旧算数）。
   *
   * 为什么要有时限：这一类授权是"整个工具"级别的（`dsh:bash` = 所有命令），
   * 而按命令前缀去细抠是个陷阱 —— 「以后 `ls` 不用问」挡不住 `ls; rm -rf ~`，
   * 那给的是**假的安全感**，比不细抠更危险。真正能安全收窄的只有**时间**：
   * 主人在自己划定的那一段里认下这个风险，过点就自动回到"每次都问"。
   */
  until?: string;
}

/** 给主人看的"还剩多久"（纯函数，不碰时区，测试好钉） */
export function humanLeft(until: string, now: number = Date.now()): string {
  const ms = Date.parse(until) - now;
  if (!Number.isFinite(ms)) return '（期限读不懂）';
  if (ms <= 0) return '已过期';
  if (ms < 60_000) return '不到 1 分钟';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `约 ${min} 分钟`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `约 ${hours} 小时`;
  return `约 ${Math.round(hours / 24)} 天`;
}

/** 还能生效的那几条（没写期限的永远算数）。**过点的不算** —— 退回每次都问 */
export function liveGrants(grants: readonly Grant[], now: number = Date.now()): Grant[] {
  return grants.filter((g) => !g.until || Date.parse(g.until) > now);
}

/** 一次最多给多久。比这更长就别用期限了，直接说"以后这类都行" */
export const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 把主人写在授权后面那句时间读懂。**读不懂就说读不懂**（`ok: false`）——
 * 绝不能"没看懂那就当永远吧"，那是最坏的一种猜法。
 */
export function parseGrantWindow(
  text: string,
  now: number = Date.now(),
): { ok: true; until: string } | { ok: false; why: string } {
  const t = text.trim().replace(/\s+/g, '');
  if (!t) return { ok: false, why: '空的时间' };
  const CN: Record<string, number> = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3 };
  const m = /^(?:(\d+(?:\.\d+)?)|([半一两二三]))(分钟|小时|天)$/.exec(t);
  if (!m) return { ok: false, why: `认不出「${text.trim()}」是多长时间` };
  const n = m[1] !== undefined ? Number(m[1]) : (CN[m[2]!] ?? 0);
  const unit = m[3]!;
  const ms = n * (unit === '分钟' ? 60_000 : unit === '小时' ? 3_600_000 : 86_400_000);
  if (!(ms > 0)) return { ok: false, why: `「${text.trim()}」不是一段正的时间` };
  if (ms > MAX_WINDOW_MS) {
    return { ok: false, why: `「${text.trim()}」太长了（最多 7 天）—— 想一直免问就直接说「以后这类都行」` };
  }
  return { ok: true, until: new Date(now + ms).toISOString() };
}

/** 授权文件放哪：跟管家自己的状态文件放一起（同一个 state 目录） */
export function grantsFileOf(stateFile: string, fallbackDir: string): string {
  return stateFile ? join(dirname(stateFile), 'grants.json') : join(fallbackDir, 'state', 'grants.json');
}

/** 一次请求属于哪一类 */
export function kindOf(req: { agent: string; tool: string }): string {
  return `${req.agent || '?'}:${req.tool || '?'}`;
}

/** 读得动就读（读不动当空）—— 用在"要不要自动放行"这条路上 */
export function readGrants(file: string): Grant[] {
  return readGrantsOr(file).grants;
}

/** 读，并且**如实告诉调用方读没读动** —— 用在「授权」这条路上 */
export function readGrantsOr(file: string): { grants: Grant[]; broken?: string } {
  if (!existsSync(file)) return { grants: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { grants: [], broken: '这份授权记录读不出来（不是合法的 JSON）' };
  }
  const raw = (doc as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(raw)) return { grants: [], broken: '这份授权记录形状不对（没有 grants 这一段）' };
  const grants: Grant[] = [];
  for (const item of raw) {
    const kind = (item as { kind?: unknown } | null)?.kind;
    const at = (item as { at?: unknown } | null)?.at;
    if (typeof kind === 'string' && kind !== '' && typeof at === 'string') {
      const until = (item as { until?: unknown } | null)?.until;
      grants.push(typeof until === 'string' && until !== '' ? { kind, at, until } : { kind, at });
    }
  }
  return { grants };
}

/** 加一条（已经有了就只把时间更新一下）。返回加完之后的全部 */
export function addGrant(file: string, kind: string, at = new Date(), until?: string): Grant[] {
  const { grants } = readGrantsOr(file);
  const next = grants.filter((g) => g.kind !== kind);
  next.push(until ? { kind, at: at.toISOString(), until } : { kind, at: at.toISOString() });
  write(file, next);
  return next;
}

/** 收回第 N 条（编号来自「授权」列出来的那份）。`removed: null` = 没有这一条 */
export function removeGrant(file: string, index: number): { removed: Grant | null; grants: Grant[] } {
  const { grants } = readGrantsOr(file);
  if (index < 1 || index > grants.length) return { removed: null, grants };
  const removed = grants[index - 1]!;
  const next = grants.filter((_, i) => i !== index - 1);
  write(file, next);
  return { removed, grants: next };
}

/**
 * 写：先写临时文件再改名（写一半断电也不会留下一份半截的授权记录），
 * 权限 0600 —— 它虽然不是密钥，但它决定"哪些事不用问主人"，不能给全机看。
 */
function write(file: string, grants: Grant[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ grants }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
