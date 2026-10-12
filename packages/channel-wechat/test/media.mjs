/**
 * 入站媒体的离线测试 —— 不需要微信、不需要网络。
 *
 * 重点覆盖两个"真实流量里会踩、但本地不测就发现不了"的点：
 *   · aes_key 的**两种编码**（图片 vs 文件）
 *   · 图片的 key 有**两个来源**，且 image_item.aeskey 优先
 * 外加路径穿越防护（用户发来的文件名是不可信输入）。
 *
 *   node --test test/media.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CDN_BASE, aesKeyOf, buildCdnDownloadUrl, decryptAesEcb, defaultPromptFor,
  describeItem, fetchMedia, filesHint, guessMime, originalNameOf, parseAesKey,
  pickMediaItem, sanitizeName, saveInbound,
} from '../src/media.mjs';
import { Bridge } from '../src/bridge.mjs';
import { DEFAULTS, Store, mergeDeep } from '../src/store.mjs';
import { ItemType } from '../src/ilink.mjs';

// ───────────────────────── 测试工具 ─────────────────────────

/** AES-128-ECB 加密，用来造"微信 CDN 上的密文" */
const encrypt = (plain, key) => {
  const c = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
};

/** 假 CDN：返回事先准备好的密文，并记录请求过的 URL */
function fakeFetch(body, { status = 200, statusText = '' } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      arrayBuffer: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

const imageItem = ({ aeskeyHex, aesKeyBase64, eqp = 'EQP-IMG', fullUrl } = {}) => ({
  type: ItemType.IMAGE,
  image_item: {
    ...(aeskeyHex ? { aeskey: aeskeyHex } : {}),
    media: {
      encrypt_query_param: eqp,
      ...(aesKeyBase64 ? { aes_key: aesKeyBase64 } : {}),
      ...(fullUrl ? { full_url: fullUrl } : {}),
    },
  },
});

const fileItem = ({ aesKeyBase64, eqp = 'EQP-FILE', fileName = '报表.xlsx' } = {}) => ({
  type: ItemType.FILE,
  file_item: {
    file_name: fileName,
    media: { encrypt_query_param: eqp, ...(aesKeyBase64 ? { aes_key: aesKeyBase64 } : {}) },
  },
});

/** 只记录发了什么的假通道 */
class FakeIlink {
  constructor() { this.sent = []; }
  async typingTicket() { return null; }
  async setTyping() {}
  async sendText(to, text, opts = {}) { this.sent.push({ kind: 'text', to, text, contextToken: opts.contextToken }); return 1; }
  async sendFile(to, path) { this.sent.push({ kind: 'file', to, path }); return { fileName: path.split('/').pop(), size: 1 }; }
  texts() { return this.sent.filter((s) => s.kind === 'text').map((s) => s.text); }
}

function makeBridge({ backend, config = {}, fetchImpl } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wab-media-'));
  const store = new Store(root);
  const cfg = mergeDeep(DEFAULTS, {
    allowFrom: ['u1'], workspace: root, progressIntervalMs: 0, ...config,
  });
  store.saveConfig(cfg);
  const ilink = new FakeIlink();
  const seen = [];
  const bridge = new Bridge({
    root,
    store,
    config: cfg,
    ilink,
    fetchImpl,
    backend: backend ?? {
      name: 'stub',
      run: async ({ text, files }) => { seen.push({ text, files }); return { sessionId: 's1', text: '好' }; },
    },
    log: () => {},
  });
  return {
    bridge, ilink, store, root, seen,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ───────────────────────── aes_key 的两种编码 ─────────────────────────

test('parseAesKey：base64(16 字节) 与 base64(32 字符 hex) 都认', () => {
  const raw = Buffer.from('0123456789abcdef'); // 16 字节

  // 编码 A：图片 —— 直接 base64 那 16 个字节
  const a = parseAesKey(raw.toString('base64'));
  assert.equal(a.length, 16);
  assert.deepEqual(a, raw, '编码 A 应还原出原始 16 字节');

  // 编码 B：文件/语音/视频 —— base64 的是"32 字符的 hex 串"
  const b = parseAesKey(Buffer.from(raw.toString('hex')).toString('base64'));
  assert.equal(b.length, 16);
  assert.deepEqual(b, raw, '编码 B 也要还原出同一把 key');

  // 两种编码虽然不同，但必须解出同一把 key —— 这正是最容易搞错的地方
  assert.deepEqual(a, b, '两种编码必须等价');
});

test('parseAesKey：两种编码都对不上就报错，不静默给错 key', () => {
  assert.throws(() => parseAesKey(''), /aes_key/);
  assert.throws(() => parseAesKey(Buffer.from('太短').toString('base64')), /aes_key/);
  // 32 字节但不是 hex 字符 → 不认，避免拿错 key 去解密出乱码
  assert.throws(() => parseAesKey(Buffer.from('z'.repeat(32)).toString('base64')), /aes_key/);
});

test('decryptAesEcb：加解密往返一致', () => {
  const key = randomBytes(16);
  const plain = Buffer.from('这是一张图片的二进制内容'.repeat(20));
  const back = decryptAesEcb(encrypt(plain, key), key);
  assert.deepEqual(back, plain);
});

// ───────────────────────── 挑哪一项 + 用哪把钥匙 ─────────────────────────

test('pickMediaItem：优先级 图片 > 视频 > 文件，语音跳过', () => {
  const img = imageItem({ aeskeyHex: '00'.repeat(16) });
  const vid = { type: ItemType.VIDEO, video_item: { media: { encrypt_query_param: 'v' } } };
  const file = fileItem({ aesKeyBase64: 'x' });
  const voice = { type: ItemType.VOICE, voice_item: { media: { encrypt_query_param: 'a' } } };

  assert.equal(pickMediaItem([file, vid, img])?.kind, 'image', '有图先取图');
  assert.equal(pickMediaItem([file, vid])?.kind, 'video', '没图取视频');
  assert.equal(pickMediaItem([file])?.kind, 'file');
  assert.equal(pickMediaItem([voice]), null, '语音不下载（服务端已给转写）');
  assert.equal(pickMediaItem([]), null);
  assert.equal(pickMediaItem(undefined), null);
});

test('pickMediaItem：没有下载凭据的项不算数', () => {
  assert.equal(pickMediaItem([{ type: ItemType.IMAGE, image_item: { media: {} } }]), null);
  assert.equal(pickMediaItem([{ type: ItemType.IMAGE, image_item: {} }]), null);
  // 有 full_url 也算凭据
  assert.equal(pickMediaItem([imageItem({ fullUrl: 'https://x/y' })])?.kind, 'image');
});

test('aesKeyOf：图片用 image_item.aeskey（hex），且优先于 media.aes_key', () => {
  const key = Buffer.from('0123456789abcdef');
  const wrong = Buffer.from('ffffffffffffffff');

  // 两个来源同时存在 → 必须选 image_item.aeskey
  const sel = pickMediaItem([imageItem({
    aeskeyHex: key.toString('hex'),
    aesKeyBase64: wrong.toString('base64'),
  })]);
  assert.deepEqual(parseAesKey(aesKeyOf(sel)), key, '要优先用 image_item.aeskey');

  // 只有 media.aes_key 时退回去用它
  const sel2 = pickMediaItem([imageItem({ aesKeyBase64: key.toString('base64') })]);
  assert.deepEqual(parseAesKey(aesKeyOf(sel2)), key, '没有 aeskey 就用 media.aes_key');

  // 文件走 media.aes_key 的 hex 编码
  const sel3 = pickMediaItem([fileItem({ aesKeyBase64: Buffer.from(key.toString('hex')).toString('base64') })]);
  assert.deepEqual(parseAesKey(aesKeyOf(sel3)), key);

  // 完全没 key → null（表示明文）
  assert.equal(aesKeyOf(pickMediaItem([imageItem({})])), null);
});

// ───────────────────────── 下载 + 解密 ─────────────────────────

test('buildCdnDownloadUrl：参数要 URL 编码', () => {
  const u = buildCdnDownloadUrl('a+b/c=d e');
  assert.ok(u.startsWith(`${DEFAULT_CDN_BASE}/download?encrypted_query_param=`));
  assert.ok(!u.includes(' '), '空格必须编码');
  assert.ok(u.includes('a%2Bb%2Fc%3Dd%20e'), `实际：${u}`);
});

test('fetchMedia：下密文、解密、拿到明文（图片 hex 编码那条路）', async () => {
  const key = randomBytes(16);
  const plain = Buffer.from('假装这是 PNG 的字节'.repeat(10));
  const fetchImpl = fakeFetch(encrypt(plain, key));

  const sel = pickMediaItem([imageItem({ aeskeyHex: key.toString('hex') })]);
  const out = await fetchMedia(sel, { fetchImpl });

  assert.deepEqual(out, plain, '解出来必须是原文');
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].includes('encrypted_query_param=EQP-IMG'), '要用 encrypt_query_param 拼地址');
});

test('fetchMedia：文件走 base64(hex) 编码，同样能解出来', async () => {
  const key = randomBytes(16);
  const plain = Buffer.from('xlsx 的字节');
  const fetchImpl = fakeFetch(encrypt(plain, key));

  const sel = pickMediaItem([fileItem({ aesKeyBase64: Buffer.from(key.toString('hex')).toString('base64') })]);
  assert.deepEqual(await fetchMedia(sel, { fetchImpl }), plain);
});

test('fetchMedia：服务端给了 full_url 就优先用它', async () => {
  const key = randomBytes(16);
  const fetchImpl = fakeFetch(encrypt(Buffer.from('hi'), key));
  const sel = pickMediaItem([imageItem({
    aeskeyHex: key.toString('hex'),
    eqp: 'IGNORED',
    fullUrl: 'https://cdn.example.com/download?encrypted_query_param=FROM-FULL-URL',
  })]);
  await fetchMedia(sel, { fetchImpl, cdnBaseUrl: 'https://should-not-use' });
  assert.equal(fetchImpl.calls[0], 'https://cdn.example.com/download?encrypted_query_param=FROM-FULL-URL');
});

test('fetchMedia：没有 aes_key 时当明文处理', async () => {
  const fetchImpl = fakeFetch(Buffer.from('明文内容'));
  const sel = pickMediaItem([imageItem({})]);
  assert.deepEqual(await fetchMedia(sel, { fetchImpl }), Buffer.from('明文内容'));
});

test('fetchMedia：HTTP 错误与超大文件都要抛，不能把垃圾存下来', async () => {
  const sel = pickMediaItem([imageItem({})]);
  await assert.rejects(
    () => fetchMedia(sel, { fetchImpl: fakeFetch(Buffer.alloc(0), { status: 403, statusText: 'Forbidden' }) }),
    /HTTP 403/,
  );
  await assert.rejects(
    () => fetchMedia(sel, { fetchImpl: fakeFetch(Buffer.alloc(2048)), maxBytes: 1024 }),
    /文件太大/,
  );
});

// ───────────────────────── 落盘安全 ─────────────────────────

test('sanitizeName：挡住路径穿越与奇怪字符', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd', '不能带出目录');
  assert.equal(sanitizeName('/abs/path/a.png'), 'a.png');
  assert.equal(sanitizeName('C:\\Windows\\evil.exe'), 'evil.exe', '反斜杠也要处理');
  assert.equal(sanitizeName('..'), '', '只有点 → 空');
  assert.equal(sanitizeName('a b*c?.txt'), 'a_b_c_.txt', '危险字符换成下划线');
  assert.equal(sanitizeName('中文名 报表.xlsx'), '中文名_报表.xlsx', '中文要保留');
  assert.ok(sanitizeName(`${'长'.repeat(400)}.txt`).length <= 120, '要截断');
});

test('saveInbound：落进收件箱，文件名带时间戳且不越界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-inbox-'));
  try {
    const saved = saveInbound(Buffer.from('abc'), {
      dir, fileName: '../../evil.png', kind: 'image', at: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    assert.equal(saved.size, 3);
    assert.equal(saved.mime, 'image/png');
    assert.equal(saved.name, 'evil.png');
    assert.ok(saved.path.startsWith(dir), '必须落在收件箱里');
    assert.ok(saved.path.includes('2026-01-02'), `文件名要带时间：${saved.path}`);
    assert.deepEqual(readFileSync(saved.path), Buffer.from('abc'), '内容要真写进去');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('saveInbound：没有扩展名/没有原名时兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wab-inbox2-'));
  try {
    const a = saveInbound(Buffer.from('x'), { dir, fileName: '没有扩展名', kind: 'file' });
    assert.ok(a.name.endsWith('.bin'), `实际：${a.name}`);
    const b = saveInbound(Buffer.from('x'), { dir, fileName: undefined, kind: 'image' });
    assert.ok(b.name.startsWith('image-'), `实际：${b.name}`);
    assert.ok(b.name.endsWith('.jpg'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guessMime / describeItem / originalNameOf', () => {
  assert.equal(guessMime('a.PNG'), 'image/png', '大小写不敏感');
  assert.equal(guessMime('a.unknownext'), 'application/octet-stream');
  assert.equal(describeItem(pickMediaItem([fileItem({ fileName: '报表.xlsx' })])), '文件 报表.xlsx');
  assert.equal(describeItem(pickMediaItem([imageItem({})])), '图片');
  assert.equal(originalNameOf(pickMediaItem([imageItem({})])), null);
});

test('filesHint / defaultPromptFor：说清楚而不猜意图', () => {
  assert.equal(filesHint([]), '', '没附件就什么都不加');
  const hint = filesHint([{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 12, kind: 'image' }]);
  assert.ok(hint.includes('/tmp/a.png'), '必须给出本机路径');
  assert.ok(hint.includes('image/png') && hint.includes('12'));
  const p = defaultPromptFor(pickMediaItem([imageItem({})]));
  assert.ok(p.includes('图片') && p.includes('没有附文字'));
});

// ───────────────────────── 与桥的接线 ─────────────────────────

test('store 给出收件箱路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'wab-store-'));
  try {
    const s = new Store(root);
    assert.ok(s.paths.inbox.endsWith(join('state', 'inbox')), `实际：${s.paths.inbox}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('收到图片：下载解密落盘，路径出现在给 agent 的提示里，files 也传下去', async () => {
  const key = randomBytes(16);
  const plain = Buffer.from('PNG-BYTES');
  const t = makeBridge({ fetchImpl: fakeFetch(encrypt(plain, key)) });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1',
      message_type: 1,
      context_token: 'c',
      item_list: [
        { type: ItemType.TEXT, text_item: { text: '看看这张图' } },
        imageItem({ aeskeyHex: key.toString('hex') }),
      ],
    });
    assert.equal(t.bridge.queue.length, 1, '要进队列');
    assert.equal(t.bridge.queue[0].media?.kind, 'image', '队列里带的是"挑好的媒体项"，不是下载结果');

    await t.bridge._handle(t.bridge.queue.shift());

    assert.equal(t.seen.length, 1, 'agent 要被调用一次');
    assert.equal(t.seen[0].files.length, 1, 'files 要传下去');
    const f = t.seen[0].files[0];
    assert.ok(existsSync(f.path), `附件要真落盘：${f.path}`);
    assert.deepEqual(readFileSync(f.path), plain, '落盘的是解密后的明文');
    assert.ok(f.path.includes(join('state', 'inbox')), '要落在收件箱');
    assert.ok(t.seen[0].text.includes('看看这张图'), '用户原话要在');
    assert.ok(t.seen[0].text.includes(f.path), '本机路径要附在提示里');

    assert.ok(t.ilink.texts().some((s) => s.includes('📥') || s.includes('好')), '正常回话');
    const audit = t.store.recentAudit(1)[0];
    assert.equal(audit.dir, 'out');
  } finally { t.cleanup(); }
});

test('只发图片没有文字：照样处理，不报"读不了"', async () => {
  const key = randomBytes(16);
  const t = makeBridge({ fetchImpl: fakeFetch(encrypt(Buffer.from('IMG'), key)) });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1',
      message_type: 1,
      context_token: 'c',
      item_list: [imageItem({ aeskeyHex: key.toString('hex') })],
    });
    assert.equal(t.bridge.queue.length, 1, '纯图片也要进队列');
    assert.ok(!t.ilink.texts().some((s) => s.includes('读不了')), '不该说读不了');

    await t.bridge._handle(t.bridge.queue.shift());
    assert.equal(t.seen.length, 1);
    assert.ok(t.seen[0].text.includes('图片'), '要给一句起步提示');
    assert.ok(t.seen[0].text.includes('没有附文字'));
    assert.ok(t.seen[0].text.includes(t.seen[0].files[0].path));
    // 引用行用附件描述顶上
    assert.ok(t.ilink.texts()[0].startsWith('↩ [图片]'), `实际：${JSON.stringify(t.ilink.texts()[0])}`);
  } finally { t.cleanup(); }
});

test('没凭据的图片：明说读不了，且不进队列', () => {
  const t = makeBridge();
  try {
    t.bridge._enqueue({
      from_user_id: 'u1', message_type: 1, context_token: 'c',
      item_list: [{ type: ItemType.IMAGE, image_item: {} }],
    });
    assert.equal(t.bridge.queue.length, 0);
    assert.ok(t.ilink.texts().some((s) => s.includes('读不了')), `实际：${JSON.stringify(t.ilink.texts())}`);
  } finally { t.cleanup(); }
});

test('下载失败：如实告诉用户，只有附件时不空跑 agent', async () => {
  const t = makeBridge({ fetchImpl: fakeFetch(Buffer.alloc(0), { status: 500, statusText: 'Server Error' }) });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1', message_type: 1, context_token: 'c',
      item_list: [imageItem({ aeskeyHex: '00'.repeat(16) })],
    });
    await t.bridge._handle(t.bridge.queue.shift());
    assert.equal(t.seen.length, 0, '没内容就别调 agent');
    assert.ok(t.ilink.texts().some((s) => s.includes('没取回来')), `实际：${JSON.stringify(t.ilink.texts())}`);
    assert.ok(t.store.recentAudit(5).some((a) => a.mediaError), '流水里要留痕');
  } finally { t.cleanup(); }
});

test('下载失败但有文字：文字照样交给 agent', async () => {
  const t = makeBridge({ fetchImpl: fakeFetch(Buffer.alloc(0), { status: 500 }) });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1', message_type: 1, context_token: 'c',
      item_list: [
        { type: ItemType.TEXT, text_item: { text: '顺便说一句' } },
        imageItem({ aeskeyHex: '00'.repeat(16) }),
      ],
    });
    await t.bridge._handle(t.bridge.queue.shift());
    assert.equal(t.seen.length, 1, '文字部分不能因为附件失败就丢掉');
    assert.ok(t.seen[0].text.includes('顺便说一句'));
    assert.deepEqual(t.seen[0].files, []);
  } finally { t.cleanup(); }
});

test('media.enabled=false 时完全不下载（退回旧行为）', () => {
  const t = makeBridge({ config: { media: { enabled: false } } });
  try {
    t.bridge._enqueue({
      from_user_id: 'u1', message_type: 1, context_token: 'c',
      item_list: [imageItem({ aeskeyHex: '00'.repeat(16) })],
    });
    assert.equal(t.bridge.queue.length, 0, '关掉后图片不进队列');
    assert.ok(t.ilink.texts().some((s) => s.includes('读不了')));
  } finally { t.cleanup(); }
});
