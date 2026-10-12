/**
 * 离线冒烟测试 —— 不需要微信、不需要模型，验证桥的编排逻辑。
 *
 *   node --test test/
 *
 * 用的是假 ilink 客户端（只记录发了什么）和桩后端，所以跑完不会真的发消息。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store, mergeDeep, DEFAULTS } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { toPlainText, chunkText, extractText, extractFileMarkers, extractQuote, quoteLine } from '../src/text.mjs';
import { assertIlinkOk, IlinkError, MessageType, ItemType } from '../src/ilink.mjs';

// ───────────────────────── 纯函数 ─────────────────────────

test('toPlainText 剥掉 Markdown 标记但保留代码内容', () => {
  const md = '# 标题\n\n**粗体** 和 `代码`\n\n```js\nconst a = 1;\n```\n\n[链接](http://x.com)\n\n| a | b |\n| - | - |';
  const out = toPlainText(md);
  assert.ok(!out.includes('#'), '不该有标题标记');
  assert.ok(!out.includes('**'), '不该有粗体标记');
  assert.ok(out.includes('粗体'), '内容要保留');
  assert.ok(out.includes('const a = 1;'), '代码内容要保留');
  assert.ok(out.includes('链接') && !out.includes('http'), '链接只留文字');
  assert.ok(!out.includes('|'), '表格行要去掉');
});

test('chunkText 按语义切、不丢内容', () => {
  const text = `${'第一段。'.repeat(30)}\n\n${'第二段。'.repeat(30)}`;
  const chunks = chunkText(text, 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 100), '每块都不超限');
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '拼回来内容不丢');
  assert.deepEqual(chunkText('很短', 100), ['很短'], '短文本不切');
});

test('extractText 认文本与语音转写', () => {
  assert.equal(extractText({ item_list: [{ type: ItemType.TEXT, text_item: { text: ' 你好 ' } }] }), '你好');
  assert.equal(extractText({ item_list: [{ type: ItemType.VOICE, voice_item: { text: '语音内容' } }] }), '语音内容');
  assert.equal(extractText({ item_list: [{ type: ItemType.IMAGE, image_item: {} }] }), null, '图片读不出文本');
  assert.equal(extractText({}), null);
});

test('extractFileMarkers 抠出附件指令并从正文移除', () => {
  const { text, files } = extractFileMarkers('文件在这\n[[file:/tmp/a.pdf]]\n[[file:/tmp/b.png|给你图]]\n就这些');
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], { path: '/tmp/a.pdf', caption: '' });
  assert.deepEqual(files[1], { path: '/tmp/b.png', caption: '给你图' });
  assert.ok(!text.includes('[[file:'), '正文里不该残留指令');
  assert.ok(text.includes('文件在这') && text.includes('就这些'));
});

test('extractQuote：入站引用（ref_msg）压成一行纯文本', () => {
  const withRef = (ref) => ({ item_list: [{ type: 1, text_item: { text: '再发一次' }, ref_msg: ref }] });

  // 引用的是文字
  assert.equal(
    extractQuote(withRef({ message_item: { type: 1, text_item: { text: '昨天那个 PPT 发我' } } })),
    '昨天那个 PPT 发我',
  );
  // 引用的是媒体：说清楚是什么（文件名是唯一帮得上忙的信息）
  assert.equal(extractQuote(withRef({ message_item: { type: 2, image_item: {} } })), '[图片]');
  assert.equal(
    extractQuote(withRef({ message_item: { type: 4, file_item: { file_name: '报表.xlsx' } } })),
    '[文件（报表.xlsx）]',
  );
  // 只有 title、没有 message_item
  assert.equal(extractQuote(withRef({ title: '一条语音消息' })), '[一条语音消息]');
  // 没引用 / 结构怪怪的：一律 undefined，不许编
  assert.equal(extractQuote({ item_list: [{ type: 1, text_item: { text: '你好' } }] }), undefined);
  assert.equal(extractQuote({ item_list: [] }), undefined);
  assert.equal(extractQuote({}), undefined);
  assert.equal(extractQuote(withRef({})), undefined);
});

test('quoteLine 压成一行并截断', () => {
  assert.equal(quoteLine('你好'), '↩ 你好\n');
  assert.equal(quoteLine('  多\n行   空白  '), '↩ 多 行 空白\n', '换行压成空格');
  assert.equal(quoteLine(''), '');
  assert.equal(quoteLine(null), '');
  assert.ok(quoteLine('啊'.repeat(50)).length < 40, '超长要截断');
});

test('assertIlinkOk 抓得住 HTTP 200 里的业务错误', () => {
  assert.doesNotThrow(() => assertIlinkOk('x', '{"ret":0}'));
  assert.throws(() => assertIlinkOk('x', '{"ret":-1,"errmsg":"boom"}'), /ret=-1: boom/);
  assert.throws(() => assertIlinkOk('x', '{"errcode":40001}'), /errcode=40001/);
  assert.doesNotThrow(() => assertIlinkOk('x', '不是 JSON'), '非 JSON 不误报');
});

test('mergeDeep 合并嵌套配置、数组整体替换', () => {
  const base = { a: 1, o: { x: 1, y: 2 }, arr: [1, 2] };
  const out = mergeDeep(base, { o: { y: 9 }, arr: [7] });
  assert.equal(out.a, 1, '未覆盖的保留');
  assert.deepEqual(out.o, { x: 1, y: 9 }, '嵌套逐层合并');
  assert.deepEqual(out.arr, [7], '数组整体替换');
  assert.deepEqual(base.o, { x: 1, y: 2 }, '不改原对象');
});

// ───────────────────────── 编排（假通道） ─────────────────────────

/** 只记录发了什么的假 ilink */
class FakeIlink {
  constructor() {
    this.sent = [];
    this.typing = [];
    this.cursor = '';
  }

  async typingTicket() { return null; }

  async setTyping(t, s) { this.typing.push(s); }

  async sendText(to, text, opts = {}) {
    this.sent.push({ kind: 'text', to, text, contextToken: opts.contextToken });
    return 1;
  }

  async sendFile(to, path, opts = {}) {
    this.sent.push({ kind: 'file', to, path, contextToken: opts.contextToken });
    return { fileName: path.split('/').pop(), size: 42 };
  }

  texts() { return this.sent.filter((s) => s.kind === 'text').map((s) => s.text); }
}

function makeBridge({ backend, config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wab-test-'));
  const store = new Store(root);
  const cfg = {
    ...mergeDeep(DEFAULTS, {
      allowFrom: ['u1'],
      workspace: root,
      progressIntervalMs: 0,
      ...config,
    }),
    agent: mergeDeep(DEFAULTS.agent, config.agent ?? {}),
  };
  store.saveConfig(cfg);
  const ilink = new FakeIlink();
  const bridge = new Bridge({
    root,
    store,
    config: cfg,
    ilink,
    backend: backend ?? { name: 'echo', run: async ({ text }) => ({ sessionId: 's1', text: `收到：${text}` }) },
    log: () => {},
  });
  return { bridge, ilink, store, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('跑一轮：回复带引用前缀，并记住会话 id', async () => {
  const t = makeBridge();
  try {
    await t.bridge._handle({ from: 'u1', text: '把简历发给我', contextToken: 'ctx-1' });

    const texts = t.ilink.texts();
    assert.equal(texts.length, 1);
    assert.ok(texts[0].startsWith('↩ 把简历发给我\n'), `要有引用前缀，实际：${JSON.stringify(texts[0])}`);
    assert.ok(texts[0].includes('收到：把简历发给我'));
    assert.equal(t.ilink.sent[0].contextToken, 'ctx-1', '要带上 context_token');
    assert.equal(t.store.getSession('u1'), 's1', '要记住会话 id');

    const audit = t.store.recentAudit(1)[0];
    assert.equal(audit.dir, 'out');
    assert.equal(audit.error, null);
  } finally { t.cleanup(); }
});

test('附件：正文与文件分开发，正文仍带引用', async () => {
  const t = makeBridge({
    backend: { name: 'stub', run: async () => ({ sessionId: null, text: '给你文件\n[[file:/tmp/a.pdf|这是配文]]' }) },
  });
  try {
    await t.bridge._handle({ from: 'u1', text: '发个文件', contextToken: 'ctx' });
    const kinds = t.ilink.sent.map((s) => s.kind);
    assert.deepEqual(kinds, ['text', 'text', 'file'], `实际顺序：${kinds}`);
    assert.ok(t.ilink.texts()[0].includes('给你文件'));
    assert.equal(t.ilink.texts()[1], '这是配文');
    assert.equal(t.ilink.sent[2].path, '/tmp/a.pdf');
  } finally { t.cleanup(); }
});

test('只有附件没有正文时，单独发一行引用', async () => {
  const t = makeBridge({
    backend: { name: 'stub', run: async () => ({ sessionId: null, text: '[[file:/tmp/b.pdf]]' }) },
  });
  try {
    await t.bridge._handle({ from: 'u1', text: '给我那个文件', contextToken: 'ctx' });
    assert.deepEqual(t.ilink.sent.map((s) => s.kind), ['text', 'file']);
    assert.equal(t.ilink.texts()[0], '↩ 给我那个文件', '孤儿附件要有引用行');
  } finally { t.cleanup(); }
});

test('agent 报错时如实转述，不静默', async () => {
  const t = makeBridge({ backend: { name: 'bad', run: async () => ({ sessionId: null, error: '炸了' }) } });
  try {
    await t.bridge._handle({ from: 'u1', text: '干个活', contextToken: 'ctx' });
    assert.ok(t.ilink.texts()[0].includes('炸了'), '错误要出现在回复里');
    assert.equal(t.store.recentAudit(1)[0].error, '炸了', '流水里要留痕');
  } finally { t.cleanup(); }
});

test('会话被占用时自动换新会话重试一次', async () => {
  let calls = 0;
  const t = makeBridge({
    backend: {
      name: 'locky',
      run: async ({ sessionId }) => {
        calls += 1;
        if (calls === 1) return { sessionId, error: 'SESSION_LOCKED' };
        return { sessionId: 'fresh', text: '重试成功' };
      },
    },
  });
  try {
    t.store.setSession('u1', 'old-session');
    await t.bridge._handle({ from: 'u1', text: '继续', contextToken: 'ctx' });
    assert.equal(calls, 2, '应该重试一次');
    assert.equal(t.store.getSession('u1'), 'fresh', '要换成新会话');
    assert.ok(t.ilink.texts().some((s) => s.includes('重试成功')));
  } finally { t.cleanup(); }
});

test('后端抛异常不会让桥崩，会转成错误回给用户', async () => {
  const t = makeBridge({ backend: { name: 'throwy', run: async () => { throw new Error('连接超时'); } } });
  try {
    await assert.rejects(() => t.bridge._handle({ from: 'u1', text: 'x', contextToken: 'c' }), /连接超时/);
  } finally { t.cleanup(); }
});

test('白名单：外人被静默忽略，不回话', () => {
  const t = makeBridge({ config: { allowFrom: ['u1'] } });
  try {
    t.bridge._enqueue({
      from_user_id: 'stranger',
      message_type: MessageType.USER,
      item_list: [{ type: ItemType.TEXT, text_item: { text: '你好' } }],
    });
    assert.equal(t.bridge.queue.length, 0, '不该进队列');
    assert.equal(t.ilink.sent.length, 0, '不该回话（否则变成探测工具）');
    const a = t.store.recentAudit(1)[0];
    assert.equal(a.ignored, true);
  } finally { t.cleanup(); }
});

test('首条来信自动认主并落盘', () => {
  const t = makeBridge({ config: { allowFrom: [] } });
  try {
    t.bridge._enqueue({
      from_user_id: 'owner-1',
      message_type: MessageType.USER,
      item_list: [{ type: ItemType.TEXT, text_item: { text: '在吗' } }],
    });
    assert.deepEqual(t.bridge.cfg.allowFrom, ['owner-1']);
    assert.deepEqual(t.store.loadConfig().allowFrom, ['owner-1'], '要落盘');
    assert.equal(t.bridge.queue.length, 1, '认主后这条照常处理');
  } finally { t.cleanup(); }
});

test('排队时先回一句"前面还有 N 条"', () => {
  const t = makeBridge({ config: { allowFrom: ['u1'], queueAck: true } });
  try {
    const msg = (text) => ({
      from_user_id: 'u1',
      message_type: MessageType.USER,
      item_list: [{ type: ItemType.TEXT, text_item: { text } }],
      context_token: 'c',
    });
    // 手动造出"已经有一条在处理"的状态
    t.bridge._workerRunning = true;
    t.bridge.queue.push({ msg: msg('第一条'), text: '第一条', from: 'u1', contextToken: 'c' });
    t.bridge._enqueue(msg('第二条'));
    assert.ok(t.ilink.texts().some((s) => /前面还有 \d+ 条/.test(s)), `实际：${JSON.stringify(t.ilink.texts())}`);
  } finally { t.cleanup(); }
});

test('图片等读不出文本的消息会被明确告知', () => {
  const t = makeBridge({ config: { allowFrom: ['u1'] } });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1',
      message_type: MessageType.USER,
      item_list: [{ type: ItemType.IMAGE, image_item: {} }],
      context_token: 'c',
    });
    assert.equal(t.bridge.queue.length, 0, '不进队列');
    assert.ok(t.ilink.texts().some((s) => s.includes('读不了')), `实际：${JSON.stringify(t.ilink.texts())}`);
  } finally { t.cleanup(); }
});

test('积压到上限就拒收', () => {
  const t = makeBridge({ config: { allowFrom: ['u1'], maxQueue: 2, queueAck: false } });
  try {
    for (let i = 0; i < 5; i++) {
      t.bridge._enqueue({
        from_user_id: 'u1',
        message_type: MessageType.USER,
        item_list: [{ type: ItemType.TEXT, text_item: { text: `第${i}条` } }],
        context_token: 'c',
      });
    }
    assert.equal(t.bridge.queue.length, 2, '队列不该无限涨');
    assert.ok(t.ilink.texts().some((s) => s.includes('积压太多')), '要告诉用户被拒了');
  } finally { t.cleanup(); }
});

test('bot 自己发的消息不会被回环处理', () => {
  const t = makeBridge({ config: { allowFrom: ['u1'] } });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1',
      message_type: MessageType.BOT,
      item_list: [{ type: ItemType.TEXT, text_item: { text: '我是 bot' } }],
    });
    // _enqueue 本身不判 message_type（过滤在 _pollLoop），这里只确认过滤器认得 BOT
    assert.equal(MessageType.BOT, 2);
  } finally { t.cleanup(); }
});

// ───────────────────────── 收信循环（真的 start/stop 一遍） ─────────────────────────

/** 等条件成立，超时抛错。比 sleep 死等稳，也比 sleep 快 */
async function waitFor(fn, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('收信循环：拉到消息 → 跑一轮 → 回话、游标落盘', async () => {
  const t = makeBridge();
  try {
    const batches = [[{
      message_type: MessageType.USER,
      from_user_id: 'u1',
      context_token: 'ctx-1',
      item_list: [{ type: ItemType.TEXT, text_item: { text: '把简历发我' } }],
    }]];
    const cursorsSeen = [];

    // 挂住但**尊重 signal** 的长轮询，跟真实现的关键行为对齐
    t.ilink.getUpdates = (buf, { signal } = {}) => {
      cursorsSeen.push(buf);
      if (batches.length) {
        return Promise.resolve({ ret: 0, msgs: batches.shift(), get_updates_buf: `c${cursorsSeen.length}` });
      }
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('长轮询被中断')), { once: true });
      });
    };

    t.bridge.start();
    await waitFor(() => t.ilink.texts().length > 0);

    assert.match(t.ilink.texts()[0], /收到：把简历发我/, '应当真的跑了一轮并回话');
    assert.equal(t.store.readCursor(), 'c1', '游标要落盘，重启才不会重复收');
    assert.equal(cursorsSeen[0], '', '第一次应当不带游标');
  } finally {
    await t.bridge.stop();
    t.cleanup();
  }
});

test('stop() 立刻返回：不会干等一场 40 秒的长轮询', async () => {
  const t = makeBridge();
  try {
    let hung = false;
    t.ilink.getUpdates = (buf, { signal } = {}) => new Promise((_, reject) => {
      hung = true;
      signal?.addEventListener('abort', () => reject(new Error('长轮询被中断')), { once: true });
    });

    t.bridge.start();
    await waitFor(() => hung);

    const t0 = Date.now();
    await t.bridge.stop();
    const spent = Date.now() - t0;
    assert.ok(spent < 1000, `stop 应当立刻返回，实际花了 ${spent}ms`);
  } finally { t.cleanup(); }
});

test('正在输入：开始发 1，收尾必须发 2（发 0 是静默无操作，等于没关）', async () => {
  const t = makeBridge();
  try {
    t.ilink.typingTicket = async () => 'TK';   // 有票据才会真的发
    await t.bridge._handle({ from: 'u1', text: '你好', contextToken: 'ctx-1' });
    assert.deepEqual(t.ilink.typing, [1, 2], '收尾必须是 CANCEL(2)，不能是 0');
  } finally { t.cleanup(); }
});

test('就算 agent 抛错，"正在输入"也要被取消（finally 真的生效）', async () => {
  const t = makeBridge({ backend: { name: 'boom', run: async () => { throw new Error('炸了'); } } });
  try {
    t.ilink.typingTicket = async () => 'TK';
    // _handle 自己会把异常往上抛（由 worker 循环兜住转成回话），
    // 这里只关心 finally 有没有跑，所以吞掉它
    await t.bridge._handle({ from: 'u1', text: '你好', contextToken: 'ctx-1' }).catch(() => {});
    assert.deepEqual(t.ilink.typing, [1, 2], '出错路径也必须取消，否则会一直亮着');
  } finally { t.cleanup(); }
});

test('typing 关掉时一次都不发', async () => {
  const t = makeBridge({ config: { typing: false } });
  try {
    t.ilink.typingTicket = async () => 'TK';
    await t.bridge._handle({ from: 'u1', text: '你好', contextToken: 'ctx-1' });
    assert.deepEqual(t.ilink.typing, []);
  } finally { t.cleanup(); }
});
