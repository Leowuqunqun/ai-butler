/**
 * 管家的小账本：**谁是主人** + 谁 → 上次那个会话 id。
 *
 * 会话是**按「人 + 在哪台机器上」分开记的**：同一句"把那个文件改一下"，
 * 在这台电脑上和在家里那台上说的是**两件事**，会话必须各记各的，
 * 串了就会让远端 agent 拿到一个它根本不认识的 session id。
 *
 * 为什么先自己实现、不直接用 `ctx.memory`：那个能力位要到 M2 才建。
 * 按已经定下的原则——**没有实现的能力位不提前建**——这里先用一个
 * 最小实现顶上，接口形状照着将来 `ctx.memory` 的用法设计，
 * 换过去的时候调用方不用改。
 *
 * `file` 给了就落盘（重启还能续上会话、还记得主人），不给就纯内存。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Shape {
  owner: string | null;
  sessions: Record<string, string>;
  /** 认下主人之后，"头一句"说过没有。只影响开场白 —— 读不动就当没说过（再说一遍不伤人） */
  helloed?: boolean;
}

export class SessionStore {
  private readonly data: Shape;
  private readonly file: string | null;

  constructor(file?: string | null) {
    this.file = file || null;
    this.data = { owner: null, sessions: {}, helloed: false };
    if (this.file) this.load();
  }

  /** 主人是谁。没人认领过就是 null */
  getOwner(): string | null {
    return this.data.owner;
  }

  /** 认主。**只认一次**——已经有主人了就返回 false，不能被顶掉 */
  claimOwner(userId: string): boolean {
    if (this.data.owner) return false;
    this.data.owner = userId;
    this.save();
    return true;
  }

  /** 开场白说过没有 */
  helloed(): boolean {
    return this.data.helloed === true;
  }

  /** 记下"说过了"。**只有真发出去了才该调它** —— 不然他会永远等不到那句话 */
  markHelloed(): void {
    this.data.helloed = true;
    this.save();
  }

  /** `scope` 是"在哪台机器上"（设备 id）。本机传空字符串 */
  get(userId: string, scope = ''): string | null {
    return this.data.sessions[scopeKey(userId, scope)] ?? null;
  }

  set(userId: string, sessionId: string | null, scope = ''): void {
    const key = scopeKey(userId, scope);
    if (sessionId) this.data.sessions[key] = sessionId;
    else delete this.data.sessions[key];
    this.save();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Shape>;
      if (typeof raw.owner === 'string' && raw.owner) this.data.owner = raw.owner;
      if (raw.helloed === true) this.data.helloed = true;
      // 只认字符串值：文件被手改坏了也不该让内核起不来
      for (const [k, v] of Object.entries(raw.sessions ?? {})) {
        if (typeof v === 'string' && v) this.data.sessions[k] = v;
      }
    } catch {
      // 文件不存在 / 不是 JSON / 读不动 —— 都当"没有历史"，不是错误
    }
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    } catch {
      // 落盘失败不该影响"这一轮还能不能干活"：会话续不上而已，下次重开会话
    }
  }
}

/**
 * 本机那条**沿用老的键**（就是 userId 本身）—— 已经在跑的管家升级上来，
 * 不能把现有会话丢掉。跨设备的才加一层前缀。
 */
function scopeKey(userId: string, scope: string): string {
  return scope ? `${scope}#${userId}` : userId;
}
