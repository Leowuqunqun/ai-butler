/**
 * 本地假模型 —— 一个只会说固定话的 OpenAI 兼容端点。
 *
 * 为什么要它：验收"微信那一轮真的跑通了"必须有一次**真的模型往返**，
 * 但不能花用户的钱、也不能把 API key 摊到测试里。所以这里起一个本机
 * HTTP 服务，把 pi-ai 的 openai-completions 协议糊弄过去。
 *
 *   node fake-model.mjs [端口]
 *
 * 回复固定是 `假模型回复 #<第几次请求>（收到 N 条消息）` —— 探针只断言
 * "这是模型产出的"，不跟具体内容绑死：DSH 会往 user 角色里注入运行时上下文，
 * 所以"最后一条 user 消息"未必是用户说的那句。
 * 那句话到底有没有送到模型，看 stderr 的日志（run.sh 会 grep）。
 *
 * 同时支持流式（`stream: true` → SSE）与非流式，因为不知道 DSH 那边走哪条。
 */

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8123);

/** 把一条 message 的文本部分拼出来 */
function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ');
  }
  return '';
}

/** 每条 user 消息单独截断 —— 整体截断的话，排在后面的那句会被截没 */
function allUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const labels = messages
    .filter((message) => message?.role === 'user')
    .map(textOf)
    .filter((text) => text !== '')
    .map((text) => {
      const flat = text.replace(/\s+/g, ' ').trim();
      return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
    });
  return `${labels.length} 条：${labels.join(' | ')}`;
}

/** 回复形状固定：探针只认这个前缀，不认具体内容 */
let served = 0;
function replyOf(body) {
  served += 1;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  return `假模型回复 #${served}（收到 ${messages.length} 条消息）`;
}

const usage = (body) => ({
  prompt_tokens: JSON.stringify(body?.messages ?? []).length,
  completion_tokens: 8,
  total_tokens: JSON.stringify(body?.messages ?? []).length + 8,
});

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 空体或非 JSON，按空处理 */
    }
    const id = `probe-${Date.now()}`;
    const model = body?.model ?? 'probe-model';
    const text = replyOf(body);
    process.stderr.write(
      `[fake-model] ${req.method} ${req.url} stream=${body?.stream === true} tools=${body?.tools?.length ?? 0}\n` +
        `[fake-model] 这轮收到的用户消息 ${allUserText(body)}\n`,
    );

    if (body?.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }));
      res.write(chunk({ content: text }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [], usage: usage(body) })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: usage(body),
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`[fake-model] 监听 http://127.0.0.1:${PORT}/v1\n`);
});
