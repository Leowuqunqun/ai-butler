/**
 * 「要动你的电脑」这件事，在**两个进程之间**怎么传。
 *
 * ── 为什么是文件 ────────────────────────────────────────────────
 *
 * 问问题的是 dsh 子进程里的应答者，答问题的是管家（它才拿着微信登录态）。
 * 两个进程之间能用的桥不多：socket 要握手机制，stdout 是 dsh 自己的事件流
 * （往里塞别的东西会把 NDJSON 搅坏）。文件最土，但它同时满足：
 *
 *   · 两边都能碰到，不需要额外约定；
 *   · 管家重启过也不丢 —— 问题还在，主人还能看到；
 *   · 设计稿里本来就写了 `state/pending/`（未决审批，带超时）。
 *
 * ── 目录布局 ────────────────────────────────────────────────────
 *
 *   <dir>/pending/<id>.json      待批（应答者写，0600）
 *   <dir>/pending/<id>.answer    决定（**谁先结算谁写**，O_EXCL 独占，0600）
 *   <dir>/approvals.jsonl        审计，append-only（谁批的、批了什么、没人吭声）
 *
 * ── 两条不变的规矩 ──────────────────────────────────────────────
 *
 * 1. **超时 = 不许。** 没人答就是不许，绝不"先做了再说"，也绝不无限等
 *    （M0 实测卡死过 3 分钟）。
 * 2. **一条决定只留一行账。** `answer` 文件是"已结算"的唯一凭据，用 O_EXCL
 *    创建：应答者和管家可能同时到点，谁先写谁负责记账，另一个只读。
 *
 * @module @butler/approval-im/mailbox
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ApprovalBy, ApprovalRequest } from '@butler/seam-approval';

/**
 * 答案文件里能出现的 `by`：seam 那三种（主人当场点的 / 到点不许 / 主人以前给的**长期授权**）
 * 再加一个**内部**用的 `withdrawn`（这件事被撤回了，谁也批不了）。
 *
 * 摆在**一处**：以前这个联合在三处各写一遍，加一种就得记着改三遍 —— 而漏改一处
 * 的表现是"编译过不去"，好一点；真正难查的是有人顺手写成字符串字面量。
 */
type AnswerBy = ApprovalBy | 'withdrawn';

/** 落到盘上的决定。`outcome` 用的是 dsh 那套词，好让两边的审计对得上 */
export interface ApprovalAnswer {
  decision: 'allow' | 'deny';
  by: AnswerBy;
  at: string;
}

/** 审计的一行 */
export interface ApprovalAudit {
  id: string;
  agent: string;
  tool: string;
  reason: string;
  /** dsh 的封闭结局词表；`unavailable` 表示"问都没问成" */
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
  by: AnswerBy;
  at: string;
  createdAt: string;
}

/** 结算的结果：`won` 说明是**我**记的账（只有赢家写审计） */
export interface ClaimResult {
  answer: ApprovalAnswer;
  won: boolean;
}

/** 允许答复的等待上限：到点就是不许 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 审批的家在哪儿：待批清单、`.answer`、账本都在这棵树下。
 *
 * ⚠️ **只留这一处算法**。管家那一侧、子进程里的应答者、还有 `butler doctor`
 * 都得算出**同一个**目录 —— 各写一份迟早会漂移，而漂移的表现是
 * "我明明问了、却没人看见"，是最难查的一类。
 */
export function approvalsDir(config: { home?: string; dir?: string } = {}): string {
  const home = config.home || join(homedir(), '.butler');
  return config.dir || join(home, 'state', 'approvals');
}

/** 待批文件摆哪儿 */
export function pendingDir(dir: string): string {
  return join(dir, 'pending');
}

/** 审计文件 */
export function auditFile(dir: string): string {
  return join(dir, 'approvals.jsonl');
}

/** 建目录（0700 —— 里面是"主人点过哪些头"，也是隐私） */
export function ensureDir(dir: string): void {
  mkdirSync(pendingDir(dir), { recursive: true, mode: 0o700 });
}

/** 有没有这个目录 —— 读的时候不该顺手建出来 */
export function dirExists(dir: string): boolean {
  return existsSync(pendingDir(dir));
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 有的文件系统不给改，算了 —— 上面 write 时已经带了 mode */
  }
}

/** 应答者：把"有人要动你的电脑"挂出去 */
export function postRequest(dir: string, req: ApprovalRequest): void {
  ensureDir(dir);
  atomicWrite(join(pendingDir(dir), `${req.id}.json`), `${JSON.stringify(req, null, 2)}\n`);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** 已结算的凭据。它存在 = 这件事已经有结论了（哪怕 `pending/*.json` 已经不在了） */
export function readAnswer(dir: string, id: string): ApprovalAnswer | undefined {
  return readJson<ApprovalAnswer>(join(pendingDir(dir), `${id}.answer`));
}

/**
 * 读待批清单，**旧的在前**。
 *
 * 已经结算的、已经过期的都不出现 —— 过期的那批由 `sweep()` 按"不许"结算掉，
 * 这里只是不把它们再念给主人听。
 */
export function readPending(dir: string, now = Date.now()): ApprovalRequest[] {
  if (!dirExists(dir)) return [];
  const out: ApprovalRequest[] = [];
  for (const name of readdirSync(pendingDir(dir))) {
    if (!name.endsWith('.json')) continue;
    const req = readJson<ApprovalRequest>(join(pendingDir(dir), name));
    if (!req?.id) continue;
    if (existsSync(join(pendingDir(dir), `${req.id}.answer`))) continue;   // 已结算
    if (Date.parse(req.expiresAt) <= now) continue;                        // 已过期（交给 sweep 记账）
    out.push(req);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/**
 * 找一件**还没过期**的待批。已过期的当作不存在 —— 它该由 `sweep()` 按
 * "不许"结算掉，这时候再接受一句"允许"等于把一个过期的头算数。
 */
export function findPending(dir: string, id: string, now = Date.now()): ApprovalRequest | undefined {
  const file = join(pendingDir(dir), `${id}.json`);
  if (!existsSync(file)) return undefined;
  if (existsSync(join(pendingDir(dir), `${id}.answer`))) return undefined;   // 已结算
  const req = readJson<ApprovalRequest>(file);
  if (!req?.id) return undefined;
  return Date.parse(req.expiresAt) <= now ? undefined : req;
}

/** 把决定写下来。**O_EXCL**：同一件事只允许一个赢家 */
export function claim(
  dir: string,
  id: string,
  decision: 'allow' | 'deny',
  by: AnswerBy,
): ClaimResult {
  ensureDir(dir);
  const at = new Date().toISOString();
  const file = join(pendingDir(dir), `${id}.answer`);
  const answer: ApprovalAnswer = { decision, by, at };
  try {
    writeFileSync(file, `${JSON.stringify(answer, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { answer, won: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { answer: readAnswer(dir, id) ?? answer, won: false };   // 别人先到，读他的
  }
}

/** 记一行账 */
export function audit(dir: string, entry: ApprovalAudit): void {
  ensureDir(dir);
  const file = auditFile(dir);
  appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 同上 */
  }
}

/** 收尾：把这件的待批文件拿掉。**answer 文件留着** —— 它是"已结算"的凭据 */
export function clearPending(dir: string, id: string): void {
  rmSync(join(pendingDir(dir), `${id}.json`), { force: true });
}

/** 把 `pending/*.json` 读成 (id → 请求)。坏行跳过，不让一行烂数据挡住整批 */
function eachPending(dir: string): ApprovalRequest[] {
  if (!dirExists(dir)) return [];
  const out: ApprovalRequest[] = [];
  for (const name of readdirSync(pendingDir(dir))) {
    if (!name.endsWith('.json')) continue;
    const req = readJson<ApprovalRequest>(join(pendingDir(dir), name));
    if (req?.id) out.push(req);
  }
  return out;
}

/**
 * 把**过期**的按"不许"结算掉，返回结算了几件。
 *
 * 不结算的话它们会永远挂在待批里，而设计里说得很清楚：超时就是不许 ——
 * 让它挂着等于给主人一个"还来得及"的错觉。
 */
export function sweep(dir: string, now = Date.now()): number {
  let settled = 0;
  for (const req of eachPending(dir)) {
    if (existsSync(join(pendingDir(dir), `${req.id}.answer`))) continue;
    if (Date.parse(req.expiresAt) > now) continue;
    const { won } = claim(dir, req.id, 'deny', 'timeout');
    if (won) {
      audit(dir, {
        id: req.id, agent: req.agent, tool: req.tool, reason: req.reason,
        outcome: 'rejected', by: 'timeout', at: new Date().toISOString(), createdAt: req.createdAt,
      });
      settled += 1;
    }
    clearPending(dir, req.id);
  }
  return settled;
}

/** 老 answer 文件别堆到天荒地老（默认留一天；凭据在 audit 里） */
export function pruneAnswers(dir: string, olderThanMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
  if (!dirExists(dir)) return 0;
  let pruned = 0;
  for (const name of readdirSync(pendingDir(dir))) {
    if (!name.endsWith('.answer')) continue;
    const file = join(pendingDir(dir), name);
    try {
      if (now - statSync(file).mtimeMs > olderThanMs) {
        rmSync(file, { force: true });
        pruned += 1;
      }
    } catch {
      /* 别人刚好删了，不算问题 */
    }
  }
  return pruned;
}

/** 造一个请求（编号由我们发；dsh 那边的编号只用于它自己的对账） */
export function makeRequest(over: {
  agent: string; tool: string; reason: string; displayReason?: string; callId?: string;
  timeoutMs: number; now?: number;
}): ApprovalRequest {
  const now = over.now ?? Date.now();
  return {
    id: randomUUID(),
    agent: over.agent,
    tool: over.tool,
    reason: over.reason,
    ...(over.displayReason === undefined ? {} : { displayReason: over.displayReason }),
    ...(over.callId === undefined ? {} : { callId: over.callId }),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + over.timeoutMs).toISOString(),
  };
}
