/**
 * 测试用假记忆 —— **故意用 TypeScript 写**。
 *
 * 它同时验证两件事：
 *   1. 类型契约成立：一个实现者能正确地 `extends MemoryService`
 *      （抽象成员漏了就编译不过）
 *   2. 运行行为成立：编译产物作为 cordis 插件加载后，`ctx.memory` 就位
 *
 * 顺带它也是**契约的活文档**：`get` 不抛、`list` 新的在前、`forget` 幂等 ——
 * 这三条都在这里被跑一遍。真实现在 `memory-file`。
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { MemoryService } from '@butler/seam-memory';
import type { MemoryEntry, MemoryFilter, MemoryKind, MemoryMeta } from '@butler/seam-memory';

/** 被 inject 的假依赖，用来验证服务位门控 */
export class OwnerService extends Service {
  disposed = false;

  constructor(ctx: Context) {
    super(ctx, 'owner');
    ctx.effect(() => () => { this.disposed = true; }, 'owner.dispose');
  }
}

interface Row {
  value: unknown;
  kind: MemoryKind;
  createdAt: string;
  updatedAt: string;
  source?: string;
  note?: string;
}

/** 全在内存里的记忆 —— 够用来跑契约 */
export class FakeMemory extends MemoryService {
  readonly id = 'fake';
  readonly rows = new Map<string, Row>();
  /** 让时间可控（`list` 的顺序断言不能靠真实时钟） */
  private tick = 0;

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }

  async get(key: string): Promise<unknown> {
    return this.rows.get(key)?.value;
  }

  async set(key: string, value: unknown, meta?: MemoryMeta): Promise<void> {
    const was = this.rows.get(key);
    this.rows.set(key, {
      value,
      kind: meta?.kind ?? was?.kind ?? 'preference',
      createdAt: was?.createdAt ?? this.now(),
      updatedAt: this.now(),
      ...(meta?.source ?? was?.source ? { source: meta?.source ?? was?.source } : {}),
      ...(meta?.note ?? was?.note ? { note: meta?.note ?? was?.note } : {}),
    });
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    const all = [...this.rows.entries()]
      .map(([key, r]) => ({
        key,
        value: r.value,
        kind: r.kind,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ...(r.source === undefined ? {} : { source: r.source }),
        ...(r.note === undefined ? {} : { note: r.note }),
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const byKind = filter?.kind === undefined ? all : all.filter((e) => e.kind === filter.kind);
    return filter?.limit === undefined ? byKind : byKind.slice(0, filter.limit);
  }

  async forget(key: string): Promise<void> {
    this.rows.delete(key);        // 本来就没有也不报错：幂等
  }
}
