/**
 * 记忆的形状。
 *
 * ── 为什么分这三类 ──────────────────────────────────────────────
 *
 * 分类不是技术口味，是**产品决定**：三类东西"能不能写"完全不同
 * （见 docs/ARCH-product.md §5.2）：
 *
 *   · preference 偏好 —— 主人明说，或者问了之后他确认
 *   · fact       事实 —— 可以从对话里自动提取
 *   · grant      授权 —— **只在主人明确同意后**才能写
 *
 * `grant` 单独一类，因为它等于"以后这类事不用问我了"：那是**放宽权限**，
 * 跟"我习惯用中文"完全不是一个量级。把它跟偏好混在一起，等于把权限
 * 偷偷藏在"记性"里。
 */

/** 一条记忆是哪一类 */
export type MemoryKind = 'preference' | 'fact' | 'grant';

/**
 * 一条记忆。
 *
 * `key` 是稳定标识（`forget` 用的就是它），`value` 是任意 JSON。
 * 人话里说的"那条"，落地就是这两个东西。
 */
export interface MemoryEntry {
  /** 稳定标识。同一个 key 再 set 就是**覆盖**，不是新增一条 */
  key: string;
  value: unknown;
  kind: MemoryKind;
  /** ISO 时间。**覆盖时保持不变** —— 它回答的是"这条哪年开始记的" */
  createdAt: string;
  updatedAt: string;
  /** 谁写的：`owner`（主人明说）/ 实现方自定义。没有它就没法回答"这条哪来的" */
  source?: string;
  /** 主人自己那句话（有的话）。忘了的时候他不知道 key 是什么，只记得自己说过什么 */
  note?: string;
}

/**
 * 写入时附带的说明。
 *
 * 两个字段都可选：`kind` 缺省是 `preference` —— **主人明说那条是主路径**，
 * 而他会说出来的东西，绝大多数就是偏好。
 */
export interface MemoryMeta {
  kind?: MemoryKind;
  source?: string;
  note?: string;
}

/** `list()` 的筛选条件。都不给就是"全都要" */
export interface MemoryFilter {
  kind?: MemoryKind;
  /** 最多几条。注意它是**新的在前**之后才截断的 */
  limit?: number;
}
