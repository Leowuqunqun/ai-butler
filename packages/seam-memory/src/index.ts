/**
 * 记忆能力位 —— `ctx.memory`。
 *
 * ── 这个包**只有接口，没有实现** ────────────────────────────────
 *
 * 「东西记在哪儿、怎么记」是可替换的。想接自己的存储（SQLite、云端、
 * 加密文件……），你要做的是：
 *
 *   1. 装这个包，`extends MemoryService`
 *   2. 实现 `id`、`get()`、`set()`、`list()`、`forget()`
 *   3. 给它加 `static Config`（自己的配置项，比如文件路径）
 *   4. `export default` 你的类 —— 它就成了一个 cordis 插件
 *
 * ── 为什么值得做成能力位（而不是一个普通服务）───────────────────
 *
 * 因为**已经看得见第二个实现**：起步用 JSON 文件（够简单、肉眼可查），
 * 记忆多了再换 SQLite（见 docs/ARCH-technical.md §存储）。
 * 只有一个实现的时候不该做 seam —— 这条原则写在 ARCH-technical 里，
 * 这里是它等到的第一个"两个"。
 *
 * ── 契约上唯一多出来的是 `id` ───────────────────────────────────
 *
 * 跟 `ctx.channel` / `ctx.agent` / `ctx.link` 保持一致：日志和 doctor
 * 里要能认出"是哪个存储"，`'file'` 还是 `'sqlite'`。
 *
 * ── ⚠️ 存的东西**含隐私** ───────────────────────────────────────
 *
 * "我的工作目录是 ~/work"、"简历都放 Documents/简历/" —— 这类内容
 * 落在盘上就是隐私。实现包至少要做到：
 *
 *   · 目录 `0700`、文件 `0600`
 *   · **别把 value 打进日志**（日志会被贴进 issue）
 *   · 原子写（临时文件 + rename），别让一次断电毁掉全部记忆
 *
 * @module @butler/seam-memory
 */

import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';

import type { MemoryEntry, MemoryFilter, MemoryMeta } from './types.js';

export type * from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService;
  }
}

/**
 * 记忆服务的抽象基类。
 *
 * 落地形态是 `abstract class`（继承 cordis 的 `Service`），不是 `interface`
 * —— 这样实现者漏掉成员是**编译期**报错，而不是等到某次对话才发现
 * "它把我说的忘了"。
 */
export abstract class MemoryService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memory');
  }

  /** 存储标识，例如 `'file'` / `'sqlite'`。用于日志与 doctor，不参与逻辑分支 */
  abstract readonly id: string;

  /**
   * 读一条。
   *
   * **没记住返回 `undefined`，不抛。** "我不记得这件事"是正常状态，
   * 不是错误 —— 让调用方去 try/catch 一件正常事，早晚会有人吞掉真错误。
   */
  abstract get(key: string): Promise<unknown>;

  /** 写一条。同一个 key 再写就是**覆盖**（`createdAt` 保持第一次的） */
  abstract set(key: string, value: unknown, meta?: MemoryMeta): Promise<void>;

  /**
   * 列出来。**新的在前**。
   *
   * 顺序是契约的一部分：用户看到的清单、"忘掉第 2 条"里的那个 2，
   * 都建立在这个顺序上。
   */
  abstract list(filter?: MemoryFilter): Promise<MemoryEntry[]>;

  /**
   * 忘掉一条。
   *
   * **本来就没有也算成功**（幂等）：用户说"忘掉"的时候，收到一句
   * "没有这条"只会让他怀疑是不是没忘掉。
   */
  abstract forget(key: string): Promise<void>;
}
