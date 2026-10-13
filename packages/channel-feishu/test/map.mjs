/**
 * 纯映射：飞书的归一化消息 → 接缝的 `InboundMessage`。
 *
 * 这里没有网络、没有假通道，全是可以直接断言的小函数。
 *
 * @module @butler/channel-feishu/test/map
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeContext, describe, encodeContext, toInbound, toQuoteLine } from '../lib/map.js';
import { normalized } from './fake-lark.mjs';

test('文本消息映射成 InboundMessage（含回话要用的 contextToken）', () => {
  const msg = toInbound(normalized({ content: '帮我看看磁盘' }));
  assert.equal(msg.channel, 'feishu');
  assert.equal(msg.fromId, 'ou_alice');
  assert.equal(msg.text, '帮我看看磁盘');
  assert.deepEqual(JSON.parse(msg.contextToken), { chatId: 'oc_chat', messageId: 'om_1' });
  assert.equal(msg.raw.messageId, 'om_1', '原始归一化消息要留着，排障时全靠它');
});

test('群消息的 @ 已经由官方包换成真名，我们原样透传', () => {
  // 这是不自己解析事件的直接好处：正文进来时 @_user_1 已经不存在了
  const msg = toInbound(normalized({
    chatType: 'group',
    mentionedBot: true,
    content: '@管家 帮我把测试跑一遍',
    mentions: [{ key: '@_user_1', id: { openId: 'ou_bot' }, name: '管家' }],
  }));
  assert.equal(msg.text, '@管家 帮我把测试跑一遍');
});

test('可以换通道标识（一套映射，将来给 Lark 国际版用也不会写成两套）', () => {
  assert.equal(toInbound(normalized(), { channelId: 'lark' }).channel, 'lark');
});

test('contextToken 编解码：坏 token / 空 token 都退化到收件人，而不是抛错', () => {
  const token = encodeContext({ chatId: 'oc_1', messageId: 'om_1', threadId: 'omt_1' });
  assert.deepEqual(decodeContext(token, 'ou_fallback'), {
    chatId: 'oc_1', messageId: 'om_1', threadId: 'omt_1',
  });

  // 主动推送那条路没有 contextToken，必须照走
  assert.deepEqual(decodeContext(undefined, 'ou_fallback'), { chatId: 'ou_fallback' });
  assert.deepEqual(decodeContext('', 'ou_fallback'), { chatId: 'ou_fallback' });
  // 坏 JSON 和"形状不对的 JSON"是两类故障，都得挡住
  assert.deepEqual(decodeContext('{不是 json', 'ou_fallback'), { chatId: 'ou_fallback' });
  assert.deepEqual(decodeContext('{"chatId":""}', 'ou_fallback'), { chatId: 'ou_fallback' });
  assert.deepEqual(decodeContext('{"别的字段":1}', 'ou_fallback'), { chatId: 'ou_fallback' });
});

test('引用：换行压成一行、超长截断', () => {
  assert.equal(toQuoteLine(normalized({ content: ' 第一行 \n 第二行 ' })), '第一行 / 第二行');
  const long = toQuoteLine(normalized({ content: '一'.repeat(80) }), 10);
  assert.equal(long, `${'一'.repeat(10)}…`);
});

test('引用到媒体时说清是什么，而不是留一片空白', () => {
  assert.equal(
    toQuoteLine(normalized({ content: '', rawContentType: 'image', resources: [{ type: 'image', fileKey: 'k' }] })),
    '［图片］',
  );
  assert.equal(
    toQuoteLine(normalized({
      content: '', rawContentType: 'file', resources: [{ type: 'file', fileKey: 'k', fileName: '报告.pdf' }],
    })),
    '［文件］报告.pdf',
  );
  // 认不出的类型也别崩：如实说是什么类型
  assert.equal(describe(normalized({ content: '', rawContentType: 'weird', resources: [] })), '（weird）');
});
