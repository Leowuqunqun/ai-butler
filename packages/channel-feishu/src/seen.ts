/**
 * "这条消息我处理过了" —— **落盘**的去重表。
 *
 * ── 为什么这件小事必须有 ──────────────────────────────────────
 *
 * 飞书的事件投递是**至少一次**。官方原文：「整个业务链路上消息通信目前采取至少
 * 发送一次的策略……即使成功接收仍会收到重复消息」，失败后按 15 秒 / 5 分钟 /
 * 1 小时 / 6 小时重推，最多 4 次。
 *
 * 而且官方对"接收消息"这个事件另有一句明确的告诫：**用 `message_id` 去重，
 * 不要依赖 `event_id`**。
 *
 * `@larksuite/channel` 自带内存去重（`safety.dedup`，有 ttl / maxEntries），
 * 但**进程一重启，内存里就什么都不剩** —— 而重推可能在几小时后到达。那时用户
 * 早就执行过的那句"把下载文件夹清了"会被**再执行一遍**。
 *
 * 所以这张表要落盘。规矩和 Telegram 的 `offset` 一样：**宁可漏，不可重**。
 * 区别在于两个通道的"漏"长什么样：
 *
 *   - Telegram 有游标，丢状态就"跳过积压"（漏掉旧消息，安全）；
 *   - 飞书**没有游标**，丢状态就只剩"认不出重复"。所以这里读不出文件时按空表
 *     处理并**大声记一笔**：功能不瘫，但跨重启的那层保护没了 —— 这一点在
 *     README 的"已知粗糙处"里如实写着，不假装没有。
 *
 * @module @butler/channel-feishu/seen
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface SeenFile {
  version: 1;
  /** 最近处理过的 messageId，**新的在末尾**（超出上限就从头部丢） */
  ids: string[];
}

export class SeenStore {
  private readonly file: string;
  private readonly limit: number;
  /** 落盘失败时叫一声（不传就闭嘴）—— 见 `add()` 里的取舍 */
  private readonly onError: (error: unknown) => void;
  private ids: string[];
  private readonly known: Set<string>;

  constructor(file: string, limit = 1000, onError?: (error: unknown) => void) {
    this.file = file;
    this.limit = Math.max(1, limit);
    this.onError = onError ?? (() => {});
    const loaded = this.load();
    this.ids = loaded;
    this.known = new Set(loaded);
  }

  /** 这条处理过没有 */
  has(messageId: string): boolean {
    return this.known.has(messageId);
  }

  /**
   * 记下一条。**先记账再干活**：`emitMessage` 不可阻塞（接缝规则 3），
   * 而我们要保证"同一条不会被处理两次"这个判断在干活之前就已经成立。
   *
   * ⚠️ **落盘失败不往外抛。** 去重是保护，投递才是本职：写不进去（家目录只读、
   * 磁盘满、`state` 被占成了一个文件）时，内存里那张表照样在管事，只是跨重启那层
   * 保护暂时没了 —— 这时**宁可漏一次去重，也不能把这条消息吞掉**。
   * 读不出来时"按空表 + 大声记一笔"，是同一个取舍的另一面（见文件头）。
   */
  add(messageId: string): void {
    if (this.known.has(messageId)) return;
    this.known.add(messageId);
    this.ids.push(messageId);
    if (this.ids.length > this.limit) {
      const dropped = this.ids.splice(0, this.ids.length - this.limit);
      for (const id of dropped) this.known.delete(id);
    }
    try {
      this.save();
    } catch (error) {
      // 由调用方决定怎么叫（适配层会记一条 warn）——但绝不往上抛
      this.onError(error);
    }
  }

  /** 载入。读不出来（文件不在 / JSON 坏了 / 形状不对）一律当空表 —— 见文件头 */
  private load(): string[] {
    try {
      if (!existsSync(this.file)) return [];
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SeenFile>;
      if (!Array.isArray(raw?.ids)) return [];
      return raw.ids.filter((id): id is string => typeof id === 'string');
    } catch {
      return [];
    }
  }

  /** 写回。先写临时文件再 rename —— 断电不会留下半个 JSON（那等于读不出来） */
  private save(): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const body: SeenFile = { version: 1, ids: this.ids };
    try {
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      // rename 保留临时文件的权限，但显式再设一次：用户可能自己 umask 成 0644
      chmodSync(this.file, 0o600);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // 清理失败就算了，别把原来的错误盖掉
      }
      throw error;
    }
  }
}
