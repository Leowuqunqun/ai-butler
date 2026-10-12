/**
 * 「这句话是发给谁的」的纯函数测试 —— 不碰网络、不起容器。
 *
 *   node --test test/route.mjs
 *
 * 这一层值得单独钉死，因为它是**用户唯一要学的那点语法**：
 * 切错一个字符，用户就会觉得"它没听懂我说话"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAddress, describeDevices } from '@butler/core';

const A = ['家里那台', '公司电脑'];

test('没有 @ 就不是在叫人 —— 这是"默认本机"的地基', () => {
  assert.equal(parseAddress('把桌面理一理'), null);
  assert.equal(parseAddress('家里那台好像坏了'), null, '话里提到名字 ≠ 命令它');
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress('   '), null);
});

test('光一个 @ 不算在叫人（可能是用户手滑）', () => {
  assert.equal(parseAddress('@'), null);
  assert.equal(parseAddress('@   '), null);
});

test('@名字 + 空格 + 正文', () => {
  assert.deepEqual(parseAddress('@家里那台 把桌面理一理', A),
    { name: '家里那台', known: true, text: ' 把桌面理一理' });
});

test('中文不加空格也切得开（靠已知别名做最长匹配）', () => {
  assert.equal(parseAddress('@家里那台把桌面理一理', A).text, '把桌面理一理');
  assert.equal(parseAddress('@家里那台：把桌面理一理', A).text, '：把桌面理一理');
});

test('别名互为前缀时取最长的那个', () => {
  const aliases = ['家里', '家里那台'];
  assert.equal(parseAddress('@家里那台 干活', aliases).name, '家里那台');
  assert.equal(parseAddress('@家里 干活', aliases).name, '家里');
});

test('不认识的 @ 也是"在叫人"，只是 known=false —— 要能报出名字', () => {
  const got = parseAddress('@同事的电脑 帮我看看', A);
  assert.equal(got.known, false);
  assert.equal(got.name, '同事的电脑', '名字要切干净，尾巴上的标点不能带上');
  assert.equal(got.text, ' 帮我看看');
});

test('预检模式（不给别名）：切不出名字也照样能认出来', () => {
  const quick = parseAddress('@同事的电脑 帮我看看', []);
  assert.notEqual(quick, null, '这就是"值不值得去问一遍设备列表"的判据');
  assert.equal(quick.known, false);
});

test('扫所有行 —— 用户写多行时，@ 不一定在第一行', () => {
  const got = parseAddress('帮我看下这个\n@家里那台 再发一次', A);
  assert.equal(got.name, '家里那台');
  assert.equal(got.text, '帮我看下这个\n 再发一次');
});

test('★ 引用**不在**正文里（它在 InboundMessage.quote）—— 这里只处理"他这次说的话"', () => {
  // 以前引用是并进正文的一行 `↩ …`，所以那时"扫所有行"要靠它来正当化。
  // 现在引用走独立字段，本该只有多行正文这一个理由 —— 这条钉住这个前提：
  assert.equal(parseAddress('再发一次', A), null, '只引用不说话，不算在叫人');
  assert.equal(parseAddress('昨天那个 PPT\n再发一次', A), null, '引用里出现别的东西也不认');
});

test('@ 单独占一行也认', () => {
  const got = parseAddress('@家里那台\n把桌面理一理', A);
  assert.equal(got.name, '家里那台');
  assert.equal(got.text.trim(), '把桌面理一理');
});

test('只说 @ 不说干什么 —— 正文切完是空的（内核据此回"你想让它做什么"）', () => {
  assert.equal(parseAddress('@家里那台', A).text, '');
  assert.equal(parseAddress('@家里那台   ', A).text.trim(), '');
});

test('缩进的 @ 也认（微信里手打常带缩进）', () => {
  assert.equal(parseAddress('   @家里那台 干活', A).name, '家里那台');
});

test('describeDevices 说人话', () => {
  assert.equal(describeDevices([{ alias: '家里那台', online: true }, { alias: '公司电脑', online: false }]),
    '家里那台、公司电脑（不在线）');
  assert.match(describeDevices([]), /一台都还没有/);
  assert.match(describeDevices([{ alias: '', online: true }]), /没起名/);
});
