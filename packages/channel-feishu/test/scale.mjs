/**
 * **手册第六节那张"估算 vs 现实"表，还准不准。**
 *
 * 那张表是**数值承诺**：它说 `packages/channel-feishu` 的 src 现在有多少行、多少个文件，
 * 测试有多少行、多少个用例。第 72 轮一量，发现它**早就过期了**：
 *
 *   写的是      901 行 / 6 个文件      1016 行 / 52 个用例
 *   实际是     1157 行 / 5 个文件      1952 行 / 80 个用例
 *
 * 而**没有任何东西会提醒** —— 它不是链接、不是命令，出处体检（`check:docs`）也不管散文里的数。
 * 这类过期最阴：表还在那儿、看着还很认真，**但它在说谎**。
 *
 * 所以这里给能**精确量**的两样各配一条：
 *
 * - **行数**：涨出**两成半**就红。不要求逐字相等 —— 行数每次改代码都在动，
 *   钉死会让这个测试变成天天红的噪音。给出一个**写明的容差**，才算"既不谎报、也不添乱"。
 * - **文件数**：**精确**比对。它不会自己变，而且当初就写错了（写 6，实际 5）。
 *
 * ⚠️ **为什么不管用例数**：那个数**从源码文本里数不出来**。第 72 轮试过 ——
 *    `grep -c '^test('` 数出 79，而真跑一遍是 **80**：差的那条是**在循环里注册**的
 *    （表驱动），源码里没有第二处 `test(` 可数。要拿到真数只能**跑一遍**，
 *    而这个文件本身就在测试里，跑测试等于递归。⇒ 用例数留着、注明"跑一遍数的"，
 *    **不设守卫** —— 一个量不准的断言比没有断言更坏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const DOC = join(REPO, 'docs', 'CHANNEL-FEISHU.md');
const SRC = join(REPO, 'packages', 'channel-feishu', 'src');
const TEST = join(REPO, 'packages', 'channel-feishu', 'test');

/** 容差：两成半。写明在文档里，也写明在这儿 —— 两边说的是同一个数。 */
const TOLERANCE = 0.25;

/**
 * ⚠️ **把自己排除掉**：这个文件也是一个 `.mjs`，也在 `test/` 里 —— 不排除的话，
 * 它**数的是包含它自己的那个数**，于是它每改一行，被它守的那个数就跟着动。
 * 那是一种自指：守卫一动，守卫的对象也动，谁也没法判断"到底是真实增长还是守卫自己在长"。
 * 排除之后，这个数才对得上手册里写的那个（第 72 轮核过：2045 − 93 = **1952**，与文档逐字相同）。
 */
const SELF = 'scale.mjs';

function linesOf(dir, ext) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(ext) && f !== SELF)
    .sort();
  let total = 0;
  for (const f of files) {
    total += readFileSync(join(dir, f), 'utf8').split('\n').length - 1;
  }
  return { files: files.length, lines: total };
}

/** 从手册那张表里把「N 行 / M 个文件」这种数读出来。读不到就**大声**失败。 */
function claimed(doc, rowAnchor, kind) {
  const row = doc.split('\n').find((l) => l.startsWith(rowAnchor));
  assert.ok(row, `手册第六节里找不到以 ${JSON.stringify(rowAnchor)} 开头的那一行 —— ` +
    '是不是表被改写/删掉了？这个测试的锚点得跟着改。');
  const m = kind === 'files'
    ? row.match(/\*\*([\d,]+) 行 \/ ([\d,]+) 个文件\*\*/)
    : row.match(/\*\*([\d,]+) 行 \/ ([\d,]+) 个用例\*\*/);
  assert.ok(m, `那一行里读不出「N 行 / M 个${kind === 'files' ? '文件' : '用例'}」：${row.slice(0, 90)}`);
  return { lines: Number(m[1].replace(/,/g, '')), count: Number(m[2].replace(/,/g, '')) };
}

function within(actual, claimedValue, what) {
  const drift = Math.abs(actual - claimedValue) / claimedValue;
  assert.ok(
    drift <= TOLERANCE,
    `手册第六节说${what}是 ${claimedValue}，实际 ${actual}（差 ${(drift * 100).toFixed(1)}%，` +
      `容差 ${(TOLERANCE * 100).toFixed(0)}%）。那张表是**数值承诺**，不是修辞 ——` +
      '回来重量一遍再改数，或者（如果是有意改动）把这轮的偏差写进第十一节。',
  );
}

const doc = readFileSync(DOC, 'utf8');

test('★ 手册第六节说 src 有多少行 / 多少文件 —— 行数在容差内，文件数精确', () => {
  const real = linesOf(SRC, '.ts');
  const claim = claimed(doc, '| `packages/channel-feishu` 的 src |', 'files');
  within(real.lines, claim.lines, 'src 的行数');
  assert.equal(
    real.files,
    claim.count,
    `手册说 src 有 ${claim.count} 个 .ts 文件，实际 ${real.files} 个。` +
      '文件数不会自己变，所以这条**精确**比对 —— 当初就写错过一次（写 6，实际 5）。',
  );
});

test('★ 手册第六节说离线测试有多少行 —— 在容差内（用例数只查"写没写"）', () => {
  const real = linesOf(TEST, '.mjs');
  const claim = claimed(doc, '| 它的离线测试 |', 'cases');
  within(real.lines, claim.lines, '离线测试的行数');
  // ⚠️ 用例数**不比**（文本数不出来，见文件头那条注释）—— 只要求它还在，别被删成空的
  assert.ok(claim.count > 0, '离线测试的用例数被写成 0 了 —— 要么真没了，要么表被改坏了');
});
