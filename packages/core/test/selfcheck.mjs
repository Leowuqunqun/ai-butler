/**
 * 自检 —— 主人在微信里问「你还活着吗」时看到的那份报告。
 *
 * 这里钉的核心只有一条方向：**不许报假的绿**。
 *
 * 这一层最容易犯的错，是把"没查成"当成"没问题"：某个插件抛了异常就悄悄跳过，
 * 报告于是**看起来更干净**。可主人正是拿这份报告判断"要不要找人帮忙" ——
 * 所以插件抛了、返回的不是清单、压根没提供自检，都得如实说出来。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSelfCheck, formatSelfCheck, formatSelfCheckBroke, selfCheckVerdict } from '@butler/core';

const ok = (name, extra = {}) => ({ name, ok: true, ...extra });

test('全过：结论是一句人话，而且是"能收能答"这种动作', async () => {
  const r = await collectSelfCheck([
    { label: '内核', instance: { check: () => [ok('工作目录', { detail: '/tmp/工作' })] } },
  ]);
  assert.equal(r.items.length, 1);
  const text = formatSelfCheck(r);
  assert.match(text, /AI 管家自检/);
  assert.match(text, /都正常/);
  assert.match(text, /内核 · 工作目录：\/tmp\/工作/, '过了的也要写状态，光一个勾没用');
});

test('★ 某一层的 check 抛了：显成没过，而且**绝不是"都正常"**', async () => {
  const r = await collectSelfCheck([
    { label: '干活的大脑', instance: { check: () => { throw new Error('dsh 的补丁读不动'); } } },
  ]);
  assert.equal(r.items.length, 1, '抛了也必须留下一条 —— 静默跳过等于替它掩饰');
  assert.equal(r.items[0].ok, false);
  assert.match(r.items[0].name, /自检本身出错了/);
  assert.match(String(r.items[0].detail), /dsh 的补丁读不动/, '原文要照抄给主人，那是插件的 bug');
  const text = formatSelfCheck(r);
  assert.doesNotMatch(text, /都正常/);
  assert.match(text, /有 1 项没过/);
});

test('★ 返回的不是一份清单：也算没过（"没测出来"），绝不静默跳过', async () => {
  const r = await collectSelfCheck([{ label: '够到别的电脑', instance: { check: () => '我瞎写的' } }]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].ok, false);
  assert.match(r.items[0].name, /没测出来/);
  assert.match(String(r.items[0].detail), /string/);
  assert.doesNotMatch(formatSelfCheck(r), /都正常/);
});

test('同步抛和异步抛都收得住 —— 一个坏插件不能让主人什么都看不到', async () => {
  const r = await collectSelfCheck([
    { label: '同步炸', instance: { check: () => { throw new Error('同步炸了'); } } },
    { label: '异步炸', instance: { check: async () => { throw new Error('异步炸了'); } } },
  ]);
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.where), ['同步炸', '异步炸']);
  assert.ok(r.items.every((i) => !i.ok && i.fix), '两条都要带"怎么办"');
  assert.match(formatSelfCheck(r), /有 2 项没过/);
});

test('只有没过的那几条带"怎么办" —— 报告才短到有人看', async () => {
  const r = await collectSelfCheck([{
    label: '干活的大脑',
    instance: {
      check: () => [
        ok('dsh patch 文件', { detail: '/Users/x/.butler/dsh.patch.yml' }),
        { name: 'dsh 可执行文件', ok: false, detail: '找不到 dsh', fix: '先装上 dsh' },
      ],
    },
  }]);
  const text = formatSelfCheck(r);
  assert.equal(text.split('→').length - 1, 1, '只有一个箭头，就是那条没过的');
  assert.match(text, /→ 先装上 dsh/);
});

test('★ 没有 check() 的位：如实写"不在岗"和后果，不假装查过', async () => {
  const r = await collectSelfCheck([
    { label: '内核', instance: { check: () => [ok('工作目录', { detail: '/tmp' })] } },
    { label: '记忆', instance: undefined, missing: '没有它，我记不住你说过的事' },
  ]);
  assert.equal(r.items.length, 1, '没上岗的位不该伪造出一条检查');
  assert.deepEqual(r.onDuty, [
    { label: '内核', present: true },
    { label: '记忆', present: false, missing: '没有它，我记不住你说过的事' },
  ]);
  const text = formatSelfCheck(r);
  assert.match(text, /【在岗】/);
  assert.match(text, /记忆 ✗/);
  assert.match(text, /没有它，我记不住你说过的事/);
  assert.match(text, /都正常/, '可选的能力位没上来，不影响结论');
});

test('check() 里的 this 还留着 —— 有些实现要用自己的配置', async () => {
  const service = {
    base: '/Users/x/.butler',
    check() { return [ok('数据目录', { detail: this.base })]; },
  };
  const r = await collectSelfCheck([{ label: '内核', instance: service }]);
  assert.match(String(r.items[0].detail), /\/Users\/x\/\.butler/, '丢了这个 this 就成了 TypeError');
});

test('报告顺序跟传入顺序一致 —— 每次问都长一样', async () => {
  const r = await collectSelfCheck([
    { label: '甲', instance: { check: () => [ok('一')] } },
    { label: '乙', instance: { check: () => [ok('二')] } },
    { label: '丙', instance: { check: () => [ok('三')] } },
  ]);
  assert.deepEqual(r.items.map((i) => i.name), ['一', '二', '三']);
});

test('★ 一项都没查成：不许说"都正常"，要说清这份报告说明不了什么', async () => {
  const r = await collectSelfCheck([]);
  const text = formatSelfCheck(r);
  assert.equal(r.items.length, 0);
  assert.doesNotMatch(text, /都正常/);
  assert.match(text, /什么都没查到/);
  assert.match(text, /说明不了/);
  assert.notEqual(selfCheckVerdict(0, 0), selfCheckVerdict(0, 3),
    '"一项都没查"和"都正常"必须是两句不同的话');
});

test('★ 自检整个没跑起来时的话术：**不许出现"都正常"**', () => {
  const text = formatSelfCheckBroke('盘读不动了');
  assert.match(text, /盘读不动了/);
  assert.doesNotMatch(text, /都正常/);
  assert.match(text, /什么结论都不能给你/);
});
