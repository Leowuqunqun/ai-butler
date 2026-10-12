/**
 * 开场白 —— 扫码成功之后微信里**唯一**会主动出现的那句话。
 *
 * 它是这个人对"装好了没有"的全部答案，所以两件事都要钉死：
 *   ① 四件事一句不少（报平安 / 能抄的例子 / 我会先问 / 被问烦了怎么办）
 *   ② **一个行话都没有**（看这句话的人不知道自己有个终端）
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { welcomeText } from '../lib/welcome.js';

test('开场白短到一屏看得完，而且五件事都在', () => {
  const text = welcomeText();
  assert.ok(text.length < 800, `开场白太长（${text.length} 字）—— 微信里没人会读第二遍`);
  assert.match(text, /我是你的管家/);                       // ① 报平安
  assert.ok((text.match(/·/g) ?? []).length >= 3, '② 至少给三个能直接抄的例子');
  assert.match(text, /先问过你/);                           // ③ 信任的地基
  assert.match(text, /以后这类都行/);                       // ④ 被问烦了怎么办
  assert.match(text, /命令/, '还要告诉他哪儿能看到全部玩法');
  assert.match(text, /自检/, '⑤ 万一它答得不对，先让它自查');
  assert.match(text, /install\.command/,
    '⑥ 而且要说清「连自检都不回」该怎么办 —— 那时候回什么都没人听，只有再装一次能救');
});

test('★ 给小白看的话里不许出现行话', () => {
  const text = welcomeText();
  assert.ok(
    !/ctx\.|\.js|\.json|插件|npm|bash|agent|JSON|shell|terminal/i.test(text),
    '一个不懂技术的人看不懂这些 —— 开场白里一个都不能有',
  );
});
