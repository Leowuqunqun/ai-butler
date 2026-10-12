import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_KEY_REF,
  credentialsFileOf,
  keyRefOf,
  keyState,
  refsOf,
  renderKeyRef,
  saveKeyRef,
} from '../lib/credentials.js';

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), 'butler-cred-')), '.credentials.yaml');
}

const THE_REF = 'DEEPSEEK_API_KEY';

// ───────────────────────── 引用名认不认得出来 ─────────────────────────

test('补丁里的 apiKeyEnv 就是我们要写的引用名', () => {
  assert.equal(keyRefOf("  - id: llm-deepseek\n    config:\n      apiKeyEnv: MY_KEY\n"), 'MY_KEY');
  assert.equal(keyRefOf("apiKeyEnv: 'QUOTED_KEY'\n"), 'QUOTED_KEY');
  assert.equal(keyRefOf('apiKeyEnv: "DQ_KEY"\n'), 'DQ_KEY');
});

test('补丁里没有 apiKeyEnv：退回默认引用名，而不是写一个空名字', () => {
  assert.equal(keyRefOf('# 什么都没有\n'), DEFAULT_KEY_REF);
  // 只认第一处：模板里模型通道在最前面
  assert.equal(keyRefOf('apiKeyEnv: FIRST\napiKeyEnv: SECOND\n'), 'FIRST');
});

test('认得出 refs 段里的引用名', () => {
  const text = 'version: 1\nrefs:\n  A_KEY: x\n  B_KEY: y\nrecords:\n  deepseek-official:\n    env:\n      C_KEY: z\n';
  assert.deepEqual([...refsOf(text)].sort(), ['A_KEY', 'B_KEY']);
});

test('★ records 里的 env 名字**不算**我们存过 key（否则会跳过引导页）', () => {
  const text = 'version: 1\nrefs:\n  OTHER: x\nrecords:\n  deepseek-official:\n    env:\n      DEEPSEEK_API_KEY: sk-x\n';
  assert.equal(refsOf(text).has(THE_REF), false);
});

test('老布局（没有 version/refs，整份就是一层名字）也认', () => {
  assert.equal(refsOf('SOME_KEY: sk-a\n').has('SOME_KEY'), true);
});

// ───────────────────────── 写进去（纯文本处理）─────────────────────────

test('空文件：写出一份 DSH 认的最小文档', () => {
  assert.equal(
    renderKeyRef('', 'MY_KEY', 'sk-abc'),
    'version: 1\nrefs:\n  MY_KEY: "sk-abc"\n',
  );
});

test('已有文档：插进 refs 段，**别的一行都不动**', () => {
  const before = 'version: 1\nrefs:\n  A_KEY: aaa\nrecords:\n  deepseek-official: {}\n';
  const after = renderKeyRef(before, 'B_KEY', 'bbb');
  assert.equal(after, 'version: 1\nrefs:\n  B_KEY: "bbb"\n  A_KEY: aaa\nrecords:\n  deepseek-official: {}\n');
  assert.match(after, /records:\n {2}deepseek-official: \{\}\n$/, 'records 原样保留');
});

test('值的引号/冒号/井号都不会把 YAML 弄坏', () => {
  const after = renderKeyRef('version: 1\nrefs:\n  A: x\n', 'MY_KEY', 'sk-a"b: c # d');
  assert.equal(after, 'version: 1\nrefs:\n  MY_KEY: "sk-a\\"b: c # d"\n  A: x\n');
});

test('已经有这个引用名：就地改值，不插重复的 key', () => {
  const after = renderKeyRef('version: 1\nrefs:\n  MY_KEY: old\n  B: y\n', 'MY_KEY', 'new');
  assert.equal(after, 'version: 1\nrefs:\n  MY_KEY: "new"\n  B: y\n');
});

test('有 version 但没有 refs 段：补一段出来', () => {
  assert.equal(
    renderKeyRef('version: 1\nrecords:\n  x: {}\n', 'MY_KEY', 'sk-1'),
    'version: 1\nrecords:\n  x: {}\nrefs:\n  MY_KEY: "sk-1"\n',
  );
});

test('老布局（一层名字）：加一行就够，DSH 自己会升级它', () => {
  assert.equal(renderKeyRef('A_KEY: a\n', 'MY_KEY', 'sk-1'), 'A_KEY: a\nMY_KEY: "sk-1"\n');
});

test('refs 写成了一行：**不猜**，报错并给出要手加的那一行', () => {
  assert.throws(
    () => renderKeyRef('version: 1\nrefs: {A: a}\n', 'MY_KEY', 'sk-1'),
    /refs 写成了一行[\s\S]*MY_KEY: "sk-1"/,
  );
});

test('空 key / 带换行的 key 都要拦住 —— 那多半是没复制完整', () => {
  assert.throws(() => renderKeyRef('', 'K', '   '), /空的/);
  assert.throws(() => renderKeyRef('', 'K', 'sk-a\nsk-b'), /换行/);
});

// ───────────────────────── 落盘：权限、原子、状态 ─────────────────────────

test('落盘：0600，而且父目录是 0700（DSH 会因为权限太松拒绝启动）', () => {
  const file = tempFile();
  saveKeyRef(file, 'MY_KEY', 'sk-abc');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
  assert.equal(readFileSync(file, 'utf8'), 'version: 1\nrefs:\n  MY_KEY: "sk-abc"\n');
});

test('落盘不会留临时文件，也不会把别的引用名抹掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-cred-'));
  const file = join(dir, '.credentials.yaml');
  saveKeyRef(file, 'A_KEY', 'a');
  saveKeyRef(file, 'B_KEY', 'b');

  const text = readFileSync(file, 'utf8');
  assert.match(text, /A_KEY: "a"/, '第二个 key 不能把第一个挤掉');
  assert.match(text, /B_KEY: "b"/);
  assert.deepEqual(readdirSync(dir), ['.credentials.yaml'], '不许留 .tmp 之类的半成品');
  assert.equal(statSync(file).mode & 0o777, 0o600, '第二次写之后权限还是 0600');
});

test('写不下去就报错 —— 但也不留半份文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-cred-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');       // 父路径是个文件：mkdir 必然失败
  assert.throws(() => saveKeyRef(join(blocker, '.credentials.yaml'), 'K', 'v'));
  assert.deepEqual(readdirSync(dir), ['blocker'], '失败时不许留临时文件');
});

test('keyState：启动环境赢（写了也不生效，所以不该去写）', () => {
  const file = tempFile();
  saveKeyRef(file, 'MY_KEY', 'sk-stored');
  assert.equal(keyState(file, 'MY_KEY', {}), 'stored');
  assert.equal(keyState(file, 'MY_KEY', { MY_KEY: 'sk-env' }), 'env');
  assert.equal(keyState(file, 'NOPE', {}), 'missing');
  assert.equal(keyState(join(file, '..', 'nope.yaml'), 'MY_KEY', {}), 'missing');
});

test('凭据文件默认就在管家私有的 DSH_HOME 里', () => {
  assert.equal(credentialsFileOf('/home/me/.butler/dsh-home'), '/home/me/.butler/dsh-home/.credentials.yaml');
});
