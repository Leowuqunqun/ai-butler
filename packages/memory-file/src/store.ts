/**
 * 记忆文件本身 —— 读、写、坏文件怎么处理。
 *
 * 文件形状（`~/.butler/state/memory.json`）：
 *
 *     { "version": 1,
 *       "entries": { "简历放哪": { "value": "Documents/简历/", "kind": "preference",
 *                                 "createdAt": "…", "updatedAt": "…", "seq": 7 } } }
 *
 * ── 为什么"读不动"要拦下来，而不是当空的 ────────────────────────
 *
 * 当空的话，用户看到的现象是"我记住的东西全没了"，而且没有任何线索 ——
 * 比直接起不来还难查。宁可当场说清楚：**哪个文件、怎么修**。
 *
 * ── 为什么要有 seq ──────────────────────────────────────────────
 *
 * `list()` 的契约是"新的在前"，而"忘掉第 2 条"要靠这个顺序。
 * 只按 `updatedAt` 排的话，同一毫秒内写两条就会并列 —— 顺序不确定，
 * 用户说"忘掉第 2 条"就可能删错一条。`seq` 是每次写都 +1 的单调计数，
 * 顺序因此是确定的（它只在文件里，不给外面看）。
 *
 * 文件含隐私（"我的工作目录是 ~/work"），所以目录 `0700`、文件 `0600`。
 *
 * @module @butler/memory-file/store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { MemoryKind } from '@butler/seam-memory';

/** 文件里的一条 */
export interface StoredEntry {
  value: unknown;
  kind: MemoryKind;
  createdAt: string;
  updatedAt: string;
  /** 单调递增，**新的更大**。顺序靠它，不靠时钟 */
  seq: number;
  source?: string;
  note?: string;
}

/** 整个文件 */
export interface MemoryFile {
  version: number;
  entries: Record<string, StoredEntry>;
  /** 下一个 seq 该给谁 */
  nextSeq: number;
}

export function emptyMemoryFile(): MemoryFile {
  return { version: 1, entries: {}, nextSeq: 1 };
}

const KINDS: readonly MemoryKind[] = ['preference', 'fact', 'grant'];

function isKind(v: unknown): v is MemoryKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * 读。**文件不存在 = 还没记过任何东西**（空，不抛）。
 *
 * ⚠️ 文件**在但读不动**（坏了、形状不对）会抛 —— 见文件头。
 */
export function loadMemoryFile(file: string): MemoryFile {
  if (!file || !existsSync(file)) return emptyMemoryFile();

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`记忆文件读不动：${file}\n${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.trim() === '') return emptyMemoryFile();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `记忆文件不是合法 JSON：${file}\n` +
      '修法二选一：把它删掉（记忆清零，管家重新开始记），或者改名留档再从空的重来。',
    );
  }

  const obj = parsed as { entries?: unknown; nextSeq?: unknown };
  if (typeof obj !== 'object' || obj === null || typeof obj.entries !== 'object' || obj.entries === null) {
    throw new Error(`记忆文件的形状不对（缺 entries）：${file}`);
  }

  const out = emptyMemoryFile();
  let maxSeq = 0;
  for (const [key, value] of Object.entries(obj.entries as Record<string, unknown>)) {
    const e = value as Partial<StoredEntry>;
    if (typeof e !== 'object' || e === null) continue;      // 单条坏了就丢这条，不连累整份
    maxSeq = Math.max(maxSeq, typeof e.seq === 'number' ? e.seq : 0);
    out.entries[key] = {
      value: e.value,
      kind: isKind(e.kind) ? e.kind : 'preference',
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date(0).toISOString(),
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
      seq: typeof e.seq === 'number' ? e.seq : 0,
      ...(typeof e.source === 'string' && e.source ? { source: e.source } : {}),
      ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}),
    };
  }
  out.nextSeq = Math.max(
    typeof obj.nextSeq === 'number' ? obj.nextSeq : 1,
    maxSeq + 1,
  );
  return out;
}

/**
 * 写。目录 `0700`、文件 `0600`、**原子**（临时文件 + rename）。
 *
 * 原子这一条不是洁癖：记忆是**唯一一份**，写一半断电就没了。
 */
export function saveMemoryFile(file: string, mem: MemoryFile): void {
  const dir = dirname(file);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${file}.tmp${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  // 文件本来就在的时候，`mode` 不会改已经存在的权限位，补一下
  try { chmodSync(file, 0o600); } catch { /* Windows 上不支持就算了 */ }
}
