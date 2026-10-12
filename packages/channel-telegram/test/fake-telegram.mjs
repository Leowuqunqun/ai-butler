/**
 * 一个**真的** Telegram 服务器（假的 Bot API）。
 *
 * ── 为什么不用打桩（stub）──────────────────────────────────────
 *
 * 打桩只能证明"我以为的协议"，起个 HTTP 服务器才证明"我们真的按那个协议发请求"：
 * multipart 的 boundary、`chat_id` 有没有带上、`offset` 推没推对、
 * 长轮询挂住的时候 abort 能不能掐断 —— 这些只有真跑一遍才知道。
 *
 * 它只实现我们真的会用的那几个方法，行为按 Telegram 的文档来：
 *
 *   POST /bot<token>/getMe         → {ok:true, result:{id, username}}
 *   POST /bot<token>/getUpdates    → 挂住（像真的一样），有消息就立刻回
 *   POST /bot<token>/sendMessage   → 记下 chat_id / text / reply_to_message_id
 *   POST /bot<token>/sendDocument  → 记下 multipart 原文
 *   POST /bot<token>/sendPhoto     → 同上
 *   POST /bot<token>/sendChatAction→ {ok:true}
 *   POST /bot<token>/getFile       → {ok:true, result:{file_path}}
 *   GET  /file/bot<token>/<path>   → 文件字节
 *
 * ── 三个开关，用来演真实世界的坏情况 ────────────────────────────
 *
 *   `hang`        getUpdates 永不回（测 stop() 能不能立刻掐断）
 *   `errorCode`   下一次调用回这个错误码（测 401/409/429 的处理）
 *   `token`       服务器认的 token（对的才回，别的回 401）
 *
 * @module test/fake-telegram
 */

import { createServer } from 'node:http';

/** 假服务器认的 token。测试里用这个值建通道 */
export const FAKE_TOKEN = '123456:FAKE-TOKEN-for-tests';

/** 一个附件的内容。测试用它核对"落盘的字节和发出去的一样" */
export const FILE_BODY = Buffer.from('管家的测试文件\nsecond line\n', 'utf8');
export const FILE_PATH = 'documents/file_1/note.txt';

export function startFakeTelegram(opts = {}) {
  const state = {
    token: opts.token ?? FAKE_TOKEN,
    /** 已经收到的 update（我们按 offset 过滤后返回） */
    queue: [],
    /** 收到的每一个请求，测试拿来断言 */
    requests: [],
    /** 长轮询被挂住的那些响应，close() 时要放掉 */
    waiting: [],
    /** 挂起用的定时器，close() 时要清掉（否则用例结束后还会跑） */
    timers: new Set(),
    hang: false,
    errorCode: 0,
    /** getUpdates 被调了几次（测"不会起两个轮询"） */
    polls: 0,
    /** 收到 sendMessage 的正文 */
    sent: [],
    /** 收到 sendDocument / sendPhoto 的原文 */
    uploads: [],
    seq: 1,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, path: url.pathname, body });

      // 文件下载走另一条路径：/file/bot<token>/<file_path>
      if (req.method === 'GET' && url.pathname.startsWith(`/file/bot${state.token}/`)) {
        const want = url.pathname.slice(`/file/bot${state.token}/`.length);
        if (want !== FILE_PATH) return json(res, 404, { ok: false });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': FILE_BODY.length });
        res.end(FILE_BODY);
        return;
      }

      const m = url.pathname.match(/^\/bot(.+)\/([A-Za-z]+)$/);
      if (!m) return json(res, 404, { ok: false, description: 'Not Found' });
      if (m[1] !== state.token) {
        return json(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
      }
      const method = m[2];

      // 一次性错误注入：下一次调用回这个错
      if (state.errorCode) {
        const code = state.errorCode;
        state.errorCode = 0;
        const extra = code === 429 ? { parameters: { retry_after: 1 } } : {};
        return json(res, code === 429 ? 429 : 400, {
          ok: false, error_code: code, description: code === 409 ? 'Conflict: terminated by other getUpdates request' : 'injected', ...extra,
        });
      }

      if (method === 'getMe') {
        return json(res, 200, { ok: true, result: { id: 777, username: 'butler_test_bot', first_name: 'Butler' } });
      }

      if (method === 'getUpdates') {
        state.polls += 1;
        const q = JSON.parse(body.toString('utf8') || '{}');
        // offset: -1 是"只要最新那条"（跳过积压用的）
        if (q.offset === -1) {
          const last = state.queue[state.queue.length - 1];
          return json(res, 200, { ok: true, result: last ? [last] : [] });
        }
        if (state.hang) {
          // 挂住不回：用来证明 stop() 是"掐断请求"而不是"等它超时"
          state.waiting.push(res);
          return;
        }
        const pending = state.queue.filter((u) => u.update_id >= (q.offset ?? 0));
        if (pending.length) return json(res, 200, { ok: true, result: pending });
        // 真的 Telegram 会挂 timeout 秒再回空。这里挂 300ms 就够了 ——
        // 测试不需要真的等 25 秒，但"挂住"这个行为必须在
        if (q.timeout) {
          state.waiting.push(res);
          const t = setTimeout(() => {
            state.timers.delete(t);
            state.waiting = state.waiting.filter((r) => r !== res);
            json(res, 200, { ok: true, result: [] });
          }, 300);
          state.timers.add(t);
          t.unref?.();
          return;
        }
        return json(res, 200, { ok: true, result: [] });
      }

      if (method === 'sendMessage' || method === 'sendChatAction') {
        const q = JSON.parse(body.toString('utf8') || '{}');
        state.sent.push({ ...q, _method: method });
        return json(res, 200, { ok: true, result: { message_id: state.seq++ } });
      }

      if (method === 'sendDocument' || method === 'sendPhoto') {
        // 故意**不解析** multipart：我们想知道的是"真的发出去了一份 multipart"，
        // 断言原文里能看见文件名和文件字节就够了（解析反而会掩盖 boundary 的问题）
        state.uploads.push({ method, raw: body.toString('utf8'), body, contentType: req.headers['content-type'] ?? '' });
        return json(res, 200, { ok: true, result: { message_id: state.seq++ } });
      }

      if (method === 'getFile') {
        return json(res, 200, { ok: true, result: { file_id: 'f1', file_size: FILE_BODY.length, file_path: FILE_PATH } });
      }

      return json(res, 404, { ok: false, error_code: 404, description: `unknown method ${method}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        /** 给通道配置的 baseUrl */
        url: `http://127.0.0.1:${port}`,
        token: state.token,
        state,
        /** 推一条 update 进服务器（像用户发了条消息） */
        push(update) {
          state.queue.push({ update_id: update.update_id ?? state.seq++, ...update });
        },
        /** 让 getUpdates 永远不回（测掐断） */
        hang() {
          state.hang = true;
        },
        /** 下一次调用回这个错误码 */
        failOnce(code) {
          state.errorCode = code;
        },
        async close() {
          for (const t of state.timers) clearTimeout(t);
          state.timers.clear();
          for (const res of state.waiting) {
            try {
              json(res, 200, { ok: true, result: [] });
            } catch {
              // 已经回过了
            }
          }
          state.waiting = [];
          server.closeAllConnections();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

function json(res, code, body) {
  // 连接可能已经被 close() 收走了（挂着的长轮询被放掉、客户端也断了）。
  // 这时候再 writeHead 会抛 ERR_HTTP_HEADERS_SENT —— 一个测试替身的噪音
  // 会让用例红，但红的原因跟被测代码毫无关系。
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  try {
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  } catch {
    // 同上：连接没了就算了
  }
}
