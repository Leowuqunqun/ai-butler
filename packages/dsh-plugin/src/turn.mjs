/**
 * 一轮对话：把一条外部消息交给 DSH 的 agent，等它跑完，把正文取回来。
 *
 * ── 这段代码是从哪来的 ──────────────────────────────────────────
 *
 * 它在结构上对着 DSH 自己的 **headless app**（`@deepseek-ai/dsh-headless`）抄的 ——
 * 那是 DSH 里唯一"跑一轮、等它结束、把最终文本拿出来"的权威实现：
 *
 *     agents.create({ sessionId, meta:{cwd}, agentOptions, setup })
 *       → agent.whenIdle() → firstSeq = session.seq
 *       → agent.followup(createUserMessage(...)) → await agent.whenIdle()
 *       → summarize(session, firstSeq)
 *
 * 两个**有意的**不同：
 *
 *   1. headless 用 `session.eventAt(seq)` 回扫日志，而那个 API 在 0.2.0-rc.2 已经
 *      标了 `@deprecated`（agent note: 2026-09-09-deprecate-synchronous-session-event-reads）。
 *      这里改用**没被废弃的那条路**：`ctx.on('session/event', …)` 实时收，
 *      收不到再用 `session.deriveMessages()` 兜底。
 *   2. 这里**不 import 任何 DSH 包**。理由：这个包在两种地方跑 ——
 *      在 DSH 里（依赖由宿主提供），和在仓库的离线测试里（DSH 根本不在）。
 *      所以凡是 DSH 只做"平凡包装"的东西（`createUserMessage` 就是
 *      `{...input, role:'user', id: randomUUID()}` 加一次冻结），
 *      这里自己照着构造一份，并注明出处。少一个 import，就少一条"装不上"的路。
 *
 * @module dsh-plugin/turn
 */

import { createHash, randomUUID } from 'node:crypto';

/**
 * 会话 id：**同一个人永远是同一个会话**。
 *
 * 为什么不是每来一条消息就新建一个：DSH 的会话是有历史的，微信那头的对话
 * 也是连续的（"刚才那个改成蓝色"必须能找到"刚才那个"）。用确定性的 id，
 * 加上 DSH 自己的会话持久化，重启一次也还接得上；顺带这些会话会出现在
 * DSH 的界面里，人可以在电脑上接着改。
 *
 * @param {string} fromId 微信 userId
 * @returns {string} 形如 `wechat-3f2a91c4b7d0e881`
 */
export function sessionIdFor(fromId) {
  const digest = createHash('sha1').update(String(fromId)).digest('hex');
  return `wechat-${digest.slice(0, 16)}`;
}

/**
 * 造一条 user 消息。
 *
 * 等价于 DSH 的 `createUserMessage`（`@deepseek-ai/dsh-llm`）：
 *
 *     return deepFreeze(structuredClone({ ...input, role: 'user', id: brandString(randomUUID()) }))
 *
 * `source.kind` 用 `'wechat'` —— DSH 的 `MessageSourceMap` 是声明可合并的，
 * 插件可以有自己的 kind（`dsh-webhook` 就 merge 了 `'webhook'`）。
 *
 * ⚠️ **值为 `undefined` 的键必须丢掉**：DSH 往会话里写事件前会做一次
 * "无损 JSON 快照"（`snapshotJsonValue`），有 `undefined` 值就整条拒收：
 *
 *     session event "agent/inbox/spliced" carries non-JSON-serializable data
 *
 * 这个坑是**真机探针**抓出来的（`msg.raw?.messageId` 在没有 raw 时就是 undefined），
 * 离线的假 DSH 永远发现不了 —— 所以这里统一在入口清掉，而不是指望每个调用点都记得。
 *
 * @param {string} text
 * @param {Record<string, unknown>} [source]
 */
export function userMessage(text, source = { kind: 'wechat' }) {
  const clean = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) clean[key] = value;
  }
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze(clean),
  });
}

/** 把一条 assistant 消息的 content 里所有文本块拼起来（工具调用块自然被略过） */
export function joinText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 兜底：从会话里推导出来的消息里，倒着找最后一条 assistant 正文。
 *
 * 只在实时事件没收到东西时用（例如订阅比 turn 晚、或者事件被别的路径吞了）。
 * `deriveMessages()` 是没被废弃的 API（不像 `eventAt()`）。
 *
 * @param {any} session
 */
export function lastAssistantText(session) {
  let messages;
  try {
    messages = session?.deriveMessages?.();
  } catch {
    return '';
  }
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text = joinText(message.content);
    if (text.trim() !== '') return text;
  }
  return '';
}

/** 当前默认模型选择，转成 `agents.create/resume` 要的 `agentOptions` */
function agentOptionsOf(model, log) {
  try {
    const selection = model?.currentSelection?.();
    if (selection?.provider === undefined || selection?.model === undefined) return undefined;
    return { provider: selection.provider, model: selection.model };
  } catch (error) {
    log?.(`取默认模型失败（交给 DSH 自己决定）: ${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * 找到这个会话的 agent：**活的直接用 → 冷会话载入 → 都没有才新建**。
 *
 * 这三步跟 serenity-hooks（本机已装的一个真第三方 DSH 插件）和 DSH 自己的
 * headless 是同一套顺序。为什么不能一步到位 `create`：
 *   - 会话正在跑（人在 DSH 界面里也开着它）时，再 create 一个同 id 的会撞车；
 *   - 有持久化时，`resume` 能把上次的上下文接回来 —— 这才是"接着聊"。
 *
 * @returns {Promise<{ agent: any, how: 'live'|'resume'|'create' }>}
 */
export async function resolveAgent(deps, { sessionId, cwd, setup }) {
  const { agents, model, log } = deps;
  const agentOptions = agentOptionsOf(model, log);

  const live = agents?.get?.(sessionId);
  if (live) return { agent: live, how: 'live' };

  if (agents?.resume) {
    try {
      const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      return { agent, how: 'resume' };
    } catch (error) {
      // 没有这份会话是**正常**的（第一次说话），不当错误打
      log?.(`没有可载入的会话（${error?.code ?? error?.message ?? error}），新建一个`);
    }
  }

  const created = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
  return { agent: created.agent, how: 'create' };
}

/**
 * 跑一轮，返回正文与结束原因。
 *
 * @param {object} deps
 * @param {any} deps.agents       DSH 的 `ctx.agents`
 * @param {any} [deps.sessions]   DSH 的 `ctx.sessions`（只用来 flush，没有也行）
 * @param {any} [deps.model]      DSH 的 `ctx.agentDefaultModel`
 * @param {(handler: Function) => Function} [deps.onEvent] 订阅 `session/event`，返回取消订阅
 * @param {Function} [deps.installSelection] DSH 的 `installModelSelection`（有就装上）
 * @param {(msg: string) => void} [deps.log]
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.text      要交给 agent 的话
 * @param {string} input.cwd       在哪个目录干活
 * @param {Record<string, unknown>} [input.source]
 * @returns {Promise<{ text: string, reason?: any, how: string, sessionId: string }>}
 */
export async function runTurn(deps, { sessionId, text, cwd, source }) {
  const { sessions, onEvent, installSelection, log } = deps;

  // setup：DSH 的 headless 用它把"这一轮用哪个 provider/model"装进会话的
  // system-prompt 组装里（`installModelSelection` 干的就是这件事）。
  // 拿不到这个函数（离线测试、或 DSH 换了 API）就不装 —— 只传 agentOptions。
  const setup = installSelection
    ? (agentCtx) => {
        const selection = deps.model?.currentSelection?.();
        installSelection(agentCtx, { current: selection, assembled: undefined });
      }
    : undefined;

  const { agent, how } = await resolveAgent(deps, { sessionId, cwd, setup });
  log?.(`会话 ${sessionId}（${how}）开始跑一轮`);

  await agent.whenIdle();

  let reply = '';
  let reason;
  const off = onEvent?.((session, event) => {
    if (session !== agent.session) return;
    if (event?.type === 'assistant/message') {
      const joined = joinText(event.data?.message?.content);
      if (joined.trim() !== '') reply = joined;
    }
    if (event?.type === 'turn/end') reason = event.data?.reason;
  });

  try {
    agent.followup(userMessage(text, source));
    await agent.whenIdle();
  } finally {
    // 取消订阅必须在 finally 里：一轮出错也不能让监听器留在 ctx 上
    try {
      off?.();
    } catch {
      /* 已经取消过就算了 */
    }
  }

  if (reply.trim() === '') reply = lastAssistantText(agent.session);

  try {
    await sessions?.flush?.(agent.session);
  } catch (error) {
    log?.(`flush 会话失败（不影响回复）: ${error?.message ?? error}`);
  }

  return { text: reply, reason, how, sessionId };
}

/** turn/end 的 reason 里有没有一个该让用户看见的错误 */
export function errorTextOf(reason) {
  if (reason?.kind !== 'error') return '';
  const code = reason.error?.code ?? 'error';
  const message = reason.error?.message ?? '（没有更多信息）';
  return `${code}: ${message}`;
}
