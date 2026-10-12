/**
 * `verifyModelKey` —— 在 server 上**没法**验的那件事：给出去的那把 key 到底能不能用。
 *
 * 这里一个字节的网络都不走：对方是假 fetch。两类错分得清不清楚，全靠这些用例：
 * **拿定了的错**必须拦住（401/402），**没法确认**的绝不许冤枉 key（429/5xx/连不上/超时）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MODEL_BASE, verifyModelKey } from '../lib/model-key.js';

/** 假的对方：想让它回什么就回什么，并把收到的请求记下来 */
function fakeFetch(status) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response('{}', { status });
  };
  return { fn, seen };
}

test('能用：200 → ok，而且是走"列出模型"这条最便宜的接口', async () => {
  const { fn, seen } = fakeFetch(200);
  const v = await verifyModelKey('sk-abc', { fetch: fn });
  assert.equal(v.ok, true);
  assert.equal(v.blocking, false);
  assert.equal(seen[0].url, `${DEFAULT_MODEL_BASE}/models`);
  assert.equal(seen[0].init.headers.authorization, 'Bearer sk-abc', '得真把这把 key 带上');
});

test('尾巴上的斜杠不会拼出 //models，也不会把 /v1 弄丢', async () => {
  const a = fakeFetch(200);
  await verifyModelKey('sk-abc', { fetch: a.fn, baseUrl: 'https://api.deepseek.com/' });
  assert.equal(a.seen[0].url, 'https://api.deepseek.com/models');

  const b = fakeFetch(200);
  await verifyModelKey('sk-abc', { fetch: b.fn, baseUrl: 'https://proxy.example.com/v1' });
  assert.equal(b.seen[0].url, 'https://proxy.example.com/v1/models');
});

test('★ 401：拿定了，必须拦住不许存 —— 并说清去哪重新复制', async () => {
  const v = await verifyModelKey('sk-bad', { fetch: fakeFetch(401).fn });
  assert.equal(v.ok, false);
  assert.equal(v.blocking, true, '拿定了的错不拦，就等于埋一个哑雷');
  assert.match(v.why, /401/);
  assert.match(v.hint, /platform\.deepseek\.com/, '要给出那一步，不能只说"不对"');
});

test('403 和 402（额度用完）也算拿定了', async () => {
  const forbidden = await verifyModelKey('sk-x', { fetch: fakeFetch(403).fn });
  assert.equal(forbidden.blocking, true);
  const broke = await verifyModelKey('sk-x', { fetch: fakeFetch(402).fn });
  assert.equal(broke.blocking, true);
  assert.match(broke.hint, /充|换一把/);
});

test('★ 429 / 5xx / 连不上：**绝不许说"这把 key 不对"**', async () => {
  for (const status of [429, 500, 502, 503]) {
    const v = await verifyModelKey('sk-maybe', { fetch: fakeFetch(status).fn });
    assert.equal(v.ok, false);
    assert.equal(v.blocking, false, `${status} 不该冤枉一把可能好用的 key`);
    assert.match(v.why, /没法确认/);
  }
  const down = await verifyModelKey('sk-maybe', {
    fetch: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(down.blocking, false, '连不上更不该赖 key');
  assert.match(down.why, /没法确认/);
});

test('太慢就放弃：超时同样只是"没法确认"', async () => {
  const never = (_url, init) => new Promise((_res, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const v = await verifyModelKey('sk-slow', { fetch: never, timeoutMs: 30 });
  assert.equal(v.ok, false);
  assert.equal(v.blocking, false);
  assert.match(v.why, /没法确认/);
});
