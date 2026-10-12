/**
 * 局域网链路的**中枢侧**的一条会话。
 *
 * 一次 `request()` 就是一次 HTTP POST，响应是 SSE 流：
 * 先来几帧进度，最后一帧是结果或错误。
 *
 * @module @butler/link-lan
 */

import { PROTOCOL_VERSION, createFrameParser } from './protocol.js';
import type { ServerFrame } from './protocol.js';
import type { LinkEvent, LinkRequestOpts, LinkSession } from '@butler/seam-link';

export interface LanSessionOptions {
  /**
   * **空闲**超时（毫秒），不是总时长。
   *
   * 这个区别很重要：远程跑一次 agent 可能就是几分钟，
   * 按总时长掐会把正常的长任务误杀。所以只看"多久没动静了"——
   * 只要对面还在报进度，就说明它活着。
   */
  idleTimeoutMs?: number;
}

export class LanSession implements LinkSession {
  readonly deviceId: string;

  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly idleTimeoutMs: number;
  private readonly closeHandlers: ((reason?: string) => void)[] = [];
  private readonly inflight = new Set<AbortController>();
  private closed = false;
  private closeReason: string | undefined;

  constructor(deviceId: string, baseUrl: string, secret: string, options: LanSessionOptions = {}) {
    this.deviceId = deviceId;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.secret = secret;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async request(method: string, params: unknown, opts: LinkRequestOpts = {}): Promise<unknown> {
    if (this.closed) throw new Error(`和 ${this.deviceId} 的链路已经断了${this.closeReason ? `（${this.closeReason}）` : ''}`);

    const callId = `${method}#${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const ctrl = new AbortController();
    this.inflight.add(ctrl);

    // 调用方的 signal 和我们自己的取消要能一起生效。
    // 这里**不用 `AbortSignal.any`**：它要 Node ≥ 20.3，本项目保 20.0。手工接一下就好。
    const onCallerAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

    let idle: NodeJS.Timeout | undefined;
    const armIdle = () => {
      if (idle) clearTimeout(idle);
      if (this.idleTimeoutMs <= 0) return;
      idle = setTimeout(() => ctrl.abort(new Error(`${this.deviceId} 超过 ${Math.round(this.idleTimeoutMs / 1000)} 秒没有动静`)), this.idleTimeoutMs);
      idle.unref?.();
    };

    try {
      armIdle();
      const res = await fetch(`${this.baseUrl}/butler/call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.secret}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({ method, params, protocol: PROTOCOL_VERSION } satisfies {
          method: string; params: unknown; protocol: string;
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        // 非 2xx 的响应体是一句人话（见 server.ts），原样带出去
        const text = await res.text().catch(() => '');
        const why = safeError(text) ?? `HTTP ${res.status}`;
        if (res.status === 401) throw new Error(`${this.deviceId} 拒绝了这次调用：密钥不对`);
        throw new Error(`${this.deviceId} 拒绝了这次调用：${why}`);
      }
      if (!res.body) throw new Error(`${this.deviceId} 没有返回内容`);

      const parser = createFrameParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let settled: { ok: true; result: unknown } | { ok: false; error: Error } | null = null;

      while (settled === null) {
        const { done, value } = await reader.read();
        if (done) {
          // 流结束却没有 done/error 帧 —— 对面没把话说完
          const rest = parser.leftover();
          settled = {
            ok: false,
            error: new Error(`${this.deviceId} 的连接断在半截${rest ? `（还剩 ${rest.length} 字节没解析）` : ''}`),
          };
          break;
        }
        armIdle();
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const e = this.toEvent(callId, frame);
          if (e) opts.onEvent?.(e);
          if (frame.type === 'done') settled = { ok: true, result: frame.result };
          else if (frame.type === 'error') settled = { ok: false, error: withCode(frame.message, frame.code) };
        }
      }

      if (!settled.ok) throw settled.error;
      return settled.result;
    } catch (error) {
      // 被取消 / 网络层挂了 —— 会话就此脱落，通知订阅者（中枢要能马上告诉用户）
      const reason = describe(error, this.deviceId, ctrl.signal.aborted);
      if (ctrl.signal.aborted || isTransportError(error)) this.drop(reason);
      throw error instanceof Error && ctrl.signal.aborted ? new Error(reason) : error;
    } finally {
      if (idle) clearTimeout(idle);
      opts.signal?.removeEventListener('abort', onCallerAbort);
      this.inflight.delete(ctrl);
    }
  }

  onClose(handler: (reason?: string) => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i >= 0) this.closeHandlers.splice(i, 1);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;                       // 幂等
    this.drop('本机关掉了这条链路');
  }

  /** 会话脱落：取消所有在飞的请求，通知订阅者。幂等 */
  private drop(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const ctrl of [...this.inflight]) {
      try { ctrl.abort(new Error(reason)); } catch { /* 已经结束了 */ }
    }
    this.inflight.clear();
    for (const h of [...this.closeHandlers]) {
      try { h(reason); } catch { /* 订阅者的 bug 不该影响别人 */ }
    }
  }

  /** 把线上的一帧翻成中枢看的事件。进度以外的帧由调用处处理 */
  private toEvent(callId: string, frame: ServerFrame): LinkEvent | null {
    if (frame.type === 'progress') return { type: 'progress', callId, line: frame.line };
    if (frame.type === 'done') return { type: 'done', callId, result: frame.result };
    return { type: 'error', callId, message: frame.message, code: frame.code };
  }
}

const withCode = (message: string, code?: string): Error => {
  const e = new Error(message) as Error & { code?: string };
  if (code) e.code = code;
  return e;
};

/** 非 2xx 的响应体是 `{"error": "..."}`，取出那句人话 */
function safeError(text: string): string | undefined {
  try {
    const v = JSON.parse(text) as { error?: unknown };
    return typeof v.error === 'string' ? v.error : undefined;
  } catch {
    return undefined;
  }
}

/** 网络层错误（对面根本没应答）—— 这一类会让会话脱落 */
function isTransportError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
}

function describe(error: unknown, deviceId: string, aborted: boolean): string {
  if (aborted) {
    const reason = (error as { cause?: unknown })?.cause ?? error;
    const msg = reason instanceof Error ? reason.message : String(reason);
    return /没动静/.test(msg) ? msg : `${deviceId} 没应答（可能关机了，或者不在同一个网络里）`;
  }
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === 'ECONNREFUSED') return `${deviceId} 上没人在听这个端口（管家可能没起来）`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `够不着 ${deviceId}（不在同一个网络里？）`;
  return `${deviceId} 的连接断了`;
}
