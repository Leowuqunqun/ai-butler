/**
 * 局域网链路的线协议。
 *
 * 这一层是**纯函数**：把服务端帧编码成 SSE、把收到的字节增量解析成帧。
 * 抽出来单独放，是因为它是整个实现里最容易出错、也最容易测的部分 ——
 * 一个 SSE 分片切在半个 JSON 中间，解析器必须能兜住（网络就是这么切的）。
 *
 * ── 为什么是 SSE，不是 WebSocket ────────────────────────────────
 *
 * 一次远程调用就是「一问 + 一串进度 + 一个结果」，方向很单一。
 * SSE 是 `node:http` 自带的（就是一个普通响应流），**零依赖**；
 * WebSocket 服务端在 Node 里需要第三方库（客户端内置了，服务端没有）。
 * 这个项目的原则是能不加依赖就不加。
 *
 * @module @butler/link-lan
 */

/** 协议版本。握手时要对得上 —— 版本不同的两端不该硬凑 */
export const PROTOCOL_VERSION = 'butler-lan/1';

/** 一次调用的请求体 */
export interface RpcRequest {
  /** 方法名，点分，例如 `'agent.run'`。语义由中枢和节点约定 */
  method: string;
  /** 方法自己的参数，原样透传 */
  params: unknown;
  /** 协议版本，服务端会校验 */
  protocol: string;
}

/** 服务端回流的一帧 */
export type ServerFrame =
  | { type: 'progress'; line: string }
  | { type: 'done'; result: unknown }
  | { type: 'error'; message: string; code?: string };

/** 把一帧编码成 SSE 文本 */
export function encodeFrame(frame: ServerFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}

/**
 * 增量帧解析器。
 *
 * 用法：每次拿到一块数据就 `push(chunk)`，它返回这次能拼出来的完整帧，
 * 剩下半截留在内部，等下一块数据补齐。
 *
 * ⚠️ **不能只按 `\n\n` 切了就当帧用** —— 一块 TCP 数据完全可能停在
 * `data: {"type":"prog` 中间。按"切到哪算哪"的写法在本地测永远是对的
 * （本地通常一次就发完），上了真实网络就开始报"Unexpected end of JSON input"。
 */
export function createFrameParser() {
  let buffer = '';

  return {
    /** 喂一块数据，返回这次拼出来的帧 */
    push(chunk: string): ServerFrame[] {
      buffer += chunk;

      const frames: ServerFrame[] = [];
      let sep = buffer.indexOf('\n\n');
      while (sep >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;      // SSE 允许 event:/id:/注释行，一律忽略
          const payload = line.slice(5).trim();
          if (!payload) continue;
          frames.push(JSON.parse(payload) as ServerFrame);
        }
        sep = buffer.indexOf('\n\n');
      }
      return frames;
    },

    /** 流断了但缓冲区还有半截 —— 说明对面没把话说完 */
    leftover(): string {
      return buffer;
    },
  };
}

/** 判断一个不知道是什么的东西像不像一帧（服务端用，守住自己的输出） */
export function isServerFrame(v: unknown): v is ServerFrame {
  if (typeof v !== 'object' || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'progress' || t === 'done' || t === 'error';
}
