/**
 * 账本（`SessionStore`）：**谁是主人** + 谁 → 上次那个会话。
 *
 * `file` 给了就落盘（重启还认得主人、还能续上会话），不给就纯内存。
 *
 * ⚠️ 为什么单独拎出来测：这是"认主"**唯一**的持久化机制，而在这之前**没有一条用例
 * 直接碰过它** —— 每一处调用方都自己传了 `stateFile`，于是"生成配置的时候忘了传"
 * 这个洞谁也照不到（第 34 轮）：企业租户里 `dmMode` 默认 open，账本不落盘就等于
 * **重启之后谁先说话谁当家**。
 *
 * 另外两条是**给人看的契约**：手册教用户手写 `owner` 来钉死主人 —— 所以"手写的
 * 必须被认"，而且"手写坏了也不许让内核起不来"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SessionStore } from '../lib/sessions.js';

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-sessions-'));
  return {
    file: join(dir, 'state', 'state.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('★★ 给了路径：认主、会话、开场白都活过"重启"，而且主人只认一次', () => {
  const { file, cleanup } = tempFile();
  try {
    const first = new SessionStore(file);
    assert.equal(first.getOwner(), null, '新账本没有主人');
    assert.equal(first.claimOwner('ou_主人'), true);
    first.set('ou_主人', 'sess-1');
    first.markHelloed();

    // 新实例 = 进程重启
    const after = new SessionStore(file);
    assert.equal(after.getOwner(), 'ou_主人', '重启之后主人必须还在 —— 不然谁先说话谁当家');
    assert.equal(after.get('ou_主人'), 'sess-1', '会话也要续上（"把那个文件改一下"不能重启就忘了在说哪个）');
    assert.equal(after.helloed(), true, '开场白说过了就别再说一遍');
    assert.equal(after.claimOwner('ou_别人'), false, '主人只认一次，重启也不许被顶掉');
    assert.equal(after.getOwner(), 'ou_主人');
  } finally { cleanup(); }
});

test('不给路径：纯内存 —— 这就是 core 没配 stateFile 时"认主重启就忘"的下场', () => {
  const first = new SessionStore('');
  assert.equal(first.claimOwner('ou_主人'), true);
  assert.equal(new SessionStore('').getOwner(), null, '纯内存 = 换一个实例就什么都不记得');
});

test('★ 手册教人**手写**的东西必须被认：只有 owner 的文件也读得出来；写坏了也不许起不来', () => {
  const { file, cleanup } = tempFile();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ owner: 'ou_手写的' }), { mode: 0o600 });

    assert.equal(new SessionStore(file).getOwner(), 'ou_手写的', '手册让人写进 owner —— 写了就得算数');
    assert.equal(new SessionStore(file).claimOwner('ou_别人'), false, '已经有主人了，不许再认');

    writeFileSync(file, '{ 这不是 JSON');
    const broken = new SessionStore(file);
    assert.equal(broken.getOwner(), null, '读不动就当"没有历史"，不是错误');
    assert.equal(broken.claimOwner('ou_新的'), true, '文件坏了也还能重新认主');
  } finally { cleanup(); }
});
