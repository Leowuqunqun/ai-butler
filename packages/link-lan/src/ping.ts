/**
 * 一次**带超时的握手探活** —— 线上协议里最基础的那一下。
 *
 * 单独抽出来，是因为它有两个使用者，而且必须**一模一样**：
 *
 *   - `LanLink`（局域网）：配了几台就探几台，填 `online`
 *   - `TailscaleLink`（跨网）：尾巴网络里每台候选都探一下，
 *     **只有答得上来的才是管家节点** —— 尾巴网络里有打印机、有 NAS、
 *     有同事的电脑，它们不是"离线的节点"，它们根本不是节点。
 *
 * 两处各抄一份的话，"密钥怎么带、超时怎么算、帧怎么解"很快就会漂开，
 * 而这类漂开只会在某台机器上表现为"莫名其妙连不上"。
 *
 * 返回 `null` 表示**够不着**（关机、不在同网、密钥不对、不是节点……）。
 * 这里刻意不区分原因：探活是给"在不在"用的，具体原因要等真正 `connect()`
 * 时报，那时才有上下文说人话。
 *
 * @module @butler/link-lan/ping
 */

import { PROTOCOL_VERSION } from './protocol.js';
import type { PingResult } from './server.js';

export interface PingOptions {
  secret: string;
  host: string;
  port: number;
  timeoutMs?: number;
}

/** 够得着就返回对方的自我介绍，够不着返回 null */
export async function pingNode(options: PingOptions): Promise<PingResult | null> {
  const { secret, host, port, timeoutMs = 800 } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetch(`http://${host}:${port}/butler/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ method: 'link.ping', params: null, protocol: PROTOCOL_VERSION }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    // ping 是"一问一答"的，直接读 SSE 的第一帧就够
    const text = await res.text();
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return null;
    const frame = JSON.parse(line.slice(5).trim()) as { type: string; result?: PingResult };
    return frame.type === 'done' && frame.result ? frame.result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
