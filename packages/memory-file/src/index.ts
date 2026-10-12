/**
 * `ctx.memory` 的第一个实现 —— **一个 JSON 文件**。
 *
 * 放在 `~/.butler/state/memory.json`：肉眼可查、能直接删、出问题好修。
 * 记忆多到需要索引的时候再换 SQLite（那条路已经在 ARCH-technical 里留好了，
 * 这也是 `ctx.memory` 值得做成能力位的原因）。
 *
 * ── 每次都读文件，不做内存缓存 ──────────────────────────────────
 *
 * 看起来"每次读盘"很笨，但这里是对的：
 *   · 量小（一个人能记住多少条偏好？）
 *   · **别的进程也在看这个文件** —— `butler doctor` 是另一个进程，
 *     管家正跑着的时候它照样要能报"记住 3 条"
 *   · 缓存带来的 bug（两边各记一份、互相覆盖）比多次读盘贵得多
 *
 * @module @butler/memory-file
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import { MemoryService } from '@butler/seam-memory';
import type { MemoryEntry, MemoryFilter, MemoryMeta } from '@butler/seam-memory';

import { loadMemoryFile, saveMemoryFile } from './store.js';

export interface FileMemoryConfig {
  /** 管家数据目录。空串 = `~/.butler` */
  home: string;
  /** 记忆文件。空串 = `<home>/state/memory.json` */
  file: string;
}

export class FileMemory extends MemoryService {
  // 全部给 default、不用 .required() —— 本项目的既定写法（见 ARCH-technical §5）
  static Config = z.object({
    home: z.string().default(''),
    file: z.string().default(''),
  }).description('把记忆存成一个 JSON 文件（肉眼可查、原子写、0600）');

  readonly id = 'file';
  /** 记忆文件在哪 —— `doctor` 和排错都要看它 */
  readonly file: string;

  constructor(ctx: Context, config: FileMemoryConfig) {
    super(ctx);
    const home = config.home || join(homedir(), '.butler');
    this.file = config.file || join(home, 'state', 'memory.json');
  }

  async get(key: string): Promise<unknown> {
    return loadMemoryFile(this.file).entries[key]?.value;
  }

  async set(key: string, value: unknown, meta?: MemoryMeta): Promise<void> {
    const k = key.trim();
    if (!k) throw new Error('记忆的 key 不能是空的 —— 没有 key，之后就没法"忘掉这条"');

    const mem = loadMemoryFile(this.file);
    const was = mem.entries[k];
    const now = new Date().toISOString();
    const source = meta?.source ?? was?.source;
    const note = meta?.note ?? was?.note;

    mem.entries[k] = {
      value,
      // 覆盖时不写明 kind 就沿用原来那类 —— 把一条"授权"悄悄降级成"偏好"是灾难
      kind: meta?.kind ?? was?.kind ?? 'preference',
      createdAt: was?.createdAt ?? now,
      updatedAt: now,
      // 每次写都拿一个新的 seq：**更新过 = 变成最新那条**（"新的在前"就是这么来的）
      seq: mem.nextSeq,
      ...(source === undefined ? {} : { source }),
      ...(note === undefined ? {} : { note }),
    };
    mem.nextSeq += 1;
    saveMemoryFile(this.file, mem);
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    const mem = loadMemoryFile(this.file);
    const entries = Object.entries(mem.entries)
      .sort((a, b) => b[1].seq - a[1].seq)
      .map(([key, e]): MemoryEntry => ({
        key,
        value: e.value,
        kind: e.kind,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        ...(e.source === undefined ? {} : { source: e.source }),
        ...(e.note === undefined ? {} : { note: e.note }),
      }));
    const byKind = filter?.kind === undefined ? entries : entries.filter((e) => e.kind === filter.kind);
    return filter?.limit === undefined ? byKind : byKind.slice(0, filter.limit);
  }

  async forget(key: string): Promise<void> {
    const mem = loadMemoryFile(this.file);
    if (!(key in mem.entries)) return;      // 幂等：本来就没有，连文件都不碰
    delete mem.entries[key];
    saveMemoryFile(this.file, mem);
  }
}

export default FileMemory;
