/**
 * 中枢侧的一次**配对**：用那台电脑屏幕上的一次性配对码，换回它的身份和密钥。
 *
 * ── 为什么凭据走请求头 ──────────────────────────────────────────
 *
 * 节点那边有一条红线：**认证在读第一个字节之前做完**（不做流式鉴权 ——
 * 那样未授权的请求已经能把数据写进来了，只是回不回给你而已）。
 *
 * 可配对的人**手里还没有密钥**。所以这里换个凭据放请求头里：
 * 平时是 `Authorization: Bearer <密钥>`，配对时是 `x-butler-pair: <配对码>`。
 * 节点在读 body 之前就能判断放不放行，红线没破。
 *
 * ── 换回来的密钥，只走局域网 ────────────────────────────────────
 *
 * 配对码是用户从电脑屏幕上抄到微信里发出去的（所以它可能经过腾讯的服务器），
 * 但**密钥不是**：密钥只在这一条局域网链路里从节点流向中枢，
 * 微信那边自始至终没看见过它。这也是"配对码用一次就废"的意义 ——
 * 抄错、被人瞄到，最坏的结果只是那一次配对失败。
 *
 * @module @butler/link-lan/pair
 */

import { PROTOCOL_VERSION } from './protocol.js';
import type { PingResult } from './server.js';

/** 配对成功后节点交出来的东西 */
export interface PairPayload extends PingResult {
  /** 这台机器的密钥。**只在这条链路上传，不进微信** */
  secret: string;
}

export interface PairOptions {
  host: string;
  port?: number;
  /** 用户抄来的那串。格式化上的差异由节点那边抹平 */
  code: string;
  timeoutMs?: number;
}

/**
 * 拿配对码去换身份和密钥。
 *
 * 失败**一律抛人话** —— 而且优先原样转述节点给的那句（它最清楚是
 * "码不对"还是"码过期了"，用户接下来要做的事完全不同）。
 */
export async function pairWithNode(options: PairOptions): Promise<PairPayload> {
  const { host, code, port = 41338, timeoutMs = 5000 } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();

  try {
    const res = await fetch(`http://${host}:${port}/butler/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-butler-pair': code,
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ method: 'link.pair', params: null, protocol: PROTOCOL_VERSION }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(safeError(text) ?? `那台电脑拒绝了这次配对（HTTP ${res.status}）`);
    }

    // 一问一答：读第一帧就够（跟 ping 一样）
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) throw new Error('那台电脑没有把配对结果说完整，再试一次');

    const frame = JSON.parse(line.slice(5).trim()) as { type: string; result?: PairPayload; message?: string };
    if (frame.type === 'error') throw new Error(frame.message ?? '那台电脑没说为什么，配对没成');
    if (frame.type !== 'done' || !frame.result) throw new Error('那台电脑没有把配对结果说完整，再试一次');
    return frame.result;
  } catch (error) {
    // 三层分清楚：超时、够不着、对面给的人话。混成一句的话，
    // 用户不知道该改地址还是该去开那台机器。
    if (ctrl.signal.aborted) {
      throw new Error(`那台电脑（${host}）没有回应。地址对不对？它上面 butler node 还开着吗？`);
    }
    // fetch 的网络层失败是 TypeError；节点回的那句人话不是，原样转述
    if (error instanceof TypeError) {
      throw new Error(`连不上 ${host}:${port}。检查一下地址，以及那台电脑上的 butler node 是不是开着`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 非 2xx 的响应体是 `{"error": "..."}`，取出那句人话 */
function safeError(text: string): string | undefined {
  try {
    const v = JSON.parse(text) as { error?: unknown };
    return typeof v.error === 'string' ? v.error : undefined;
  } catch {
    return undefined;
  }
}
