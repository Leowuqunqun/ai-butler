/**
 * 微信 ⇄ DSH 的桥：**认主、排队、把话送进去、把回复送回来**。
 *
 * ── 它跟管家的 `@butler/core` 什么关系 ──────────────────────────
 *
 * 管家（那套命令行产品）的内核也干这五件事，但它是**自己当大脑**：
 * `inject = ['channel','agent']`，拿 `ctx.agent` 跑 agent。
 *
 * 在 DSH 里不能再套一层大脑 —— 那就成了"DSH 里再开一个 DSH"（每次说话起一个
 * 子进程，还看不见 DSH 界面里的上下文）。所以这里只做**适配**：
 *
 *     ctx.channel 收信 ──> 认主/排队 ──> ctx.agents 跑一轮 ──> ctx.channel 回话
 *            ↑ 复用同一份微信协议                      ↑ 用 DSH 自己的会话
 *
 * 认主、排队这些**不是**可有可无的装饰：
 *   - 不认主，任何一个给你发消息的人都能让这台电脑干活；
 *   - 不排队，连发三条消息会在同一个会话上开三个 turn（DSH 的 agent 一轮没跑完
 *     时 `followup` 只是排进 inbox，但那时"哪句话对应哪个回复"就乱了）。
 *
 * @module dsh-plugin/bridge
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { errorTextOf, runTurn, sessionIdFor } from './turn.mjs';

/** 认主成功时说的第一句。人话，且说清"接下来能干什么" */
export const WELCOME =
  '我是这台电脑上的管家（DSH）。你已经认主了 —— 以后你说的每句话，我都在这台电脑上干。\n' +
  '发文件、图片也行，会落到本机再交给我。';

/**
 * 主人记在哪：通道状态目录下的 `owner.json`。
 *
 * 为什么用文件而不是 `ctx.storage`：认主这件事必须**在 DSH 的存储还没起来时**
 * 也能读到（它是权限门，读不到就该拒绝服务，而不是"等一下再问"）。
 * 跟微信登录态（token/游标）放同一个目录，备份/搬家只搬一个目录。
 *
 * @param {string} home 通道状态目录
 */
export function ownerState(home) {
  const file = join(home, 'owner.json');
  return {
    file,
    read() {
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return typeof raw?.owner === 'string' && raw.owner !== '' ? { owner: raw.owner } : null;
      } catch {
        return null;
      }
    },
    write(owner) {
      try {
        mkdirSync(home, { recursive: true });
        writeFileSync(file, `${JSON.stringify({ owner }, null, 2)}\n`);
      } catch {
        // 写不进去也不该让这一轮崩：内存里仍然认这个主人（下次重启会再问一遍）
      }
    },
  };
}

/** 一条微信消息 → 交给 agent 的一段话（附件已经在本机，所以给路径而不是给内容） */
export function buildPrompt(msg) {
  const parts = [];
  if (typeof msg.quote === 'string' && msg.quote.trim() !== '') {
    parts.push(`（对方引用了之前的一条消息：${msg.quote.trim()}）`);
  }
  if (typeof msg.text === 'string' && msg.text.trim() !== '') parts.push(msg.text);

  const files = Array.isArray(msg.files) ? msg.files : [];
  for (const file of files) {
    if (!file?.path) continue;
    const kind = file.kind ?? 'file';
    const name = file.name ? `（原名 ${file.name}）` : '';
    parts.push(`[附件·${kind}] 已下载到本机：${file.path}${name}`);
  }

  if (parts.length === 0) return '（对方发来一条空消息）';
  return parts.join('\n');
}

/** 一条消息该由谁处理 —— 认主那部分的判定，单独拎出来好测 */
export function decide(msg, { owners, claim }, state) {
  const fromId = String(msg.fromId);
  if (owners.includes(fromId)) return { action: 'run', claimed: false };

  if (owners.length > 0) return { action: 'ignore', reason: `不是主人（${fromId}）` };

  if (!claim) return { action: 'ignore', reason: '还没有主人，而且认主被关掉了' };

  state.write(fromId);
  return { action: 'run', claimed: true };
}

export class WechatBridge {
  #queue = new Map();
  #closed = false;
  #pending = new Set();

  /**
   * @param {object} deps
   * @param {any} deps.channel    微信通道（`ctx.channel`，实现见 wechat-agent-bridge）
   * @param {any} deps.agents     DSH 的 `ctx.agents`
   * @param {any} [deps.sessions] DSH 的 `ctx.sessions`
   * @param {any} [deps.model]    DSH 的 `ctx.agentDefaultModel`
   * @param {(handler: Function) => Function} [deps.onEvent] 订阅 `session/event`
   * @param {Function} [deps.installSelection]
   * @param {string} deps.cwd     会话的工作目录
   * @param {object} [deps.config]
   * @param {object} [deps.state] 主人状态（默认按 home 落文件）
   * @param {Function} [deps.runner] 跑一轮（默认 `runTurn`；测试里换假的）
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({
    channel,
    agents,
    sessions,
    model,
    onEvent,
    installSelection,
    cwd,
    config = {},
    state,
    runner = runTurn,
    log = () => {},
  }) {
    this.channel = channel;
    this.config = config;
    this.cwd = cwd;
    this.log = log;
    this.state = state;
    this.runner = runner;
    this.turnDeps = { agents, sessions, model, onEvent, installSelection, log };
  }

  /**
   * 收到一条消息。**不 await** —— 通道的收信循环是长轮询，
   * 在这里等一轮 agent 会把收信卡住（管家那边踩过这个坑）。
   */
  onMessage(msg) {
    if (this.#closed) return Promise.resolve();
    const fromId = String(msg.fromId);
    const previous = this.#queue.get(fromId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(msg))
      .catch((error) => this.log(`处理消息出错: ${error?.message ?? error}`));
    this.#queue.set(fromId, next);
    this.#pending.add(next);
    const done = () => {
      this.#pending.delete(next);
      if (this.#queue.get(fromId) === next) this.#queue.delete(fromId);
    };
    next.then(done, done);
    return next;
  }

  /** 一条消息的完整处理：认主 → 正在输入 → 跑一轮 → 回话 */
  async handle(msg) {
    const fromId = String(msg.fromId);
    const configured = Array.isArray(this.config.owner) ? this.config.owner.map(String) : [];
    const owners = configured.length > 0 ? configured : this.state?.read()?.owner ? [this.state.read().owner] : [];

    const verdict = decide(msg, { owners, claim: this.config.claim !== false }, this.state ?? { write() {} });
    if (verdict.action === 'ignore') {
      this.log(`忽略一条消息：${verdict.reason}`);
      return;
    }

    if (verdict.claimed) {
      this.log(`认主：${fromId}`);
      await this.#send(msg, WELCOME);
    }

    await this.#setTyping(msg, true);
    try {
      const prompt = buildPrompt(msg);
      const result = await this.runner(this.turnDeps, {
        sessionId: sessionIdFor(fromId),
        text: prompt,
        cwd: this.cwd,
        // 出处：消息来自微信，带上谁发的、哪条，便于会话日志里分辨
        source: { kind: 'wechat', from: fromId, messageId: msg.raw?.messageId },
      });

      const body = this.#bodyOf(result);
      await this.#send(msg, body);
    } catch (error) {
      // 一轮挂了不该让通道停摆，也不该让人对着手机干等 —— 说清楚发生了什么
      this.log(`这一轮失败: ${error?.stack ?? error}`);
      await this.#send(msg, `我这边出错了：${error?.message ?? error}`);
    } finally {
      await this.#setTyping(msg, false);
    }
  }

  /** 回复的正文：优先 agent 的文本，没有就报 turn 的错误，再没有就说实话 */
  #bodyOf(result) {
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (text !== '') return text;
    const failure = errorTextOf(result?.reason);
    if (failure !== '') return `这轮没跑完：${failure}`;
    return '这轮没有产出文本（可能是只调了工具）。';
  }

  async #send(msg, text) {
    try {
      await this.channel.sendText(msg.fromId, text, {
        contextToken: msg.contextToken,
        quote: this.config.quoteReply === false ? undefined : msg.quote,
      });
    } catch (error) {
      // 发不出去只能记下来：网络、登录态过期都归这一类，重试在这里没有意义
      this.log(`发消息失败: ${error?.message ?? error}`);
    }
  }

  async #setTyping(msg, on) {
    if (this.config.typing === false) return;
    try {
      await this.channel.setTyping?.(msg.fromId, on, { contextToken: msg.contextToken });
    } catch {
      // "正在输入"是尽力而为，失败了绝不能影响真正的回复
    }
  }

  /** 卸载：不再收新的，等在跑的那几轮结束（有上限，别把关闭卡死） */
  async dispose() {
    this.#closed = true;
    const pending = [...this.#pending];
    if (pending.length === 0) return;
    this.log(`等在跑的 ${pending.length} 轮结束…`);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        timer.unref?.();
      }),
    ]);
  }
}
