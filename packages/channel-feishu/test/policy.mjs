/**
 * 我们传给官方包的 `policy`，官方到底接住了什么。
 *
 * 这个文件**故意用真的 `@larksuite/channel`**（别的用例都假在接口上）：它钉的是
 * "我们传下去的参数名和形状" ↔ "官方接住了什么"这一层。哪天官方改了字段名，
 * 这里会先红 —— 而在真机上红，代价是用户坐在那儿等一条永远不来的回复。
 *
 * 构造不联网：`createLarkChannel()` 只是把对象搭起来，`connect()` 才真的连。
 *
 * 两件查过官方实现、写在这里免得下次再查一遍的事：
 *
 * - **`requireMention` 只管群聊**。闸门先按 `chatType` 分流（`evaluate()` 里
 *   `chatType === "group" ? evaluateGroup : evaluateDm`），那句
 *   `if ((cfg.requireMention ?? true) && !msg.mentionedBot) return "no_mention"`
 *   只写在 `evaluateGroup` 里。所以**单聊不用 @ 它**。
 * - **`dmMode` 默认 `'open'`**（实现里是 `dmMode ?? "open"`）。这个默认值不在类型
 *   声明里 —— 想收紧成白名单，就得先把 `dmMode` / `dmAllowlist` 透出来（现在没做，
 *   见 README 的"它不做什么"）。
 *
 * @module @butler/channel-feishu/test/policy
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';

import { FeishuChannel } from '../lib/index.js';

/** 这里不走 makeFeishu：那个子类会把 `makeChannel` 覆写掉，而我们要看的就是真造出来的那个 */
const real = (config) => new FeishuChannel(new Context(), {
  appId: 'cli_test_only',
  appSecret: 'not-a-real-secret',
  home: mkdtempSync(join(tmpdir(), 'butler-feishu-policy-')),
  ...config,
});

test('requireMention 原样传下去；白名单为空时**不传**这个字段', () => {
  const policy = real({ requireMention: true, allowChats: [] }).lark.getPolicy();
  assert.equal(policy.requireMention, true);
  assert.ok(!('groupAllowlist' in policy), '空数组不传：传了虽然也不拦，但看起来像"配过白名单"');
});

test('白名单非空时传 groupAllowlist（原样，不替用户猜）', () => {
  const policy = real({ requireMention: false, allowChats: ['oc_group_a'] }).lark.getPolicy();
  assert.deepEqual(policy.groupAllowlist, ['oc_group_a']);
  assert.equal(policy.requireMention, false);

  // 官方类型声明里写明了这个坑：这个字段要的是**群 id**（`oc_…`），
  // 填应用 id（`cli_…`）"不是群 id，所以静默地什么都匹配不上"（官方会打一条 warn）。
  // 我们只负责原样转达用户的配置，不替他判断 —— 所以这里不断言内容，只断言原样。
});
