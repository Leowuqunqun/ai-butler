/**
 * Telegram 的 **offset 落盘**。
 *
 * ── 为什么这件小事要单独一个文件 ─────────────────────────────────
 *
 * `offset` 是 Telegram 长轮询的"我读到哪儿了"。它错了的后果不对称：
 *
 *   - 写丢了（文件没了）→ Telegram 会把**最近 24 小时**的消息重发一遍。
 *     用户早就执行过的"把下载文件夹清了"，会被再执行一遍。这是**危险**的。
 *   - 写重了（offset 太大）→ 漏掉几条消息。用户看到"它没理我"，再发一遍就好了。
 *
 * 所以这里的规矩是：**宁可漏，不可重**。读不出来就当没有（`null`），
 * 由调用方去"跳过积压"，而不是从头重放。
 *
 * @module @butler/channel-telegram/store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class OffsetStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /**
   * 读回上次读到哪儿。
   *
   * 读不出来（文件不在、JSON 坏了、里面是个负数或小数）一律返回 `null` ——
   * 让调用方走"跳过积压"，**绝不**从 0 开始重放。
   */
  read(): number | null {
    try {
      if (!existsSync(this.file)) return null;
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { offset?: unknown };
      const n = raw?.offset;
      return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** 写回。先写临时文件再 rename —— 断电时不会留下半个 JSON（那等于读不出来） */
  write(offset: number): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ offset }, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
      // rename 会保留临时文件的权限，但显式再设一次：用户可能自己 umask 成 0644
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
