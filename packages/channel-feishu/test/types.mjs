/**
 * 官方把各种消息类型渲染成什么，我们有没有原样带上。
 *
 * 这个文件**用真的 `@larksuite/channel`**（`normalize()` 是它导出的纯函数，不联网）——
 * 别的用例都假在接口上，这里要钉的恰恰是"官方给的东西，我们这层会不会弄丢"。
 * 拿真包跑，是因为"官方对各类型到底吐什么"只能从官方实现里读（读过就别再猜）。
 *
 * 为什么专门写这个：飞书里"合并转发的聊天记录""卡片里的字""分享的群名片/联系人""位置"
 * 都是**只有文本、没有附件**的类型。第 18 轮之前，我们那层只让 `text` / `post` 带正文 ——
 * 这些消息会**整条消失**：用户看得见自己发了东西，大脑收到的是一个空提示词
 * （内核那条路是 `route.text = msg.text ?? ''` → `promptFor('')`）。
 *
 * 规则（写在 `src/map.ts` 里）：**附件承载的类型**（图/文件/语音/视频/表情）正文留空，
 * 信息走 `resources`；**其余类型**，官方渲染出来的正文就是这条消息唯一的载体，必须带上。
 *
 * @module @butler/channel-feishu/test/types
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalize } from '@larksuite/channel';

import { toInbound } from '../lib/map.js';

const BOT = { openId: 'ou_bot', name: '管家' };

/** 造一个原始飞书事件（只填 `normalize()` 真正会读的那些字段） */
function rawEvent(messageType, content) {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: 'om_types_1',
      chat_id: 'oc_types_1',
      chat_type: 'p2p',
      message_type: messageType,
      content: JSON.stringify(content),
      create_time: '1700000000000',
    },
  };
}

/**
 * 一张"类型 → 真实 content 形状"的表。content 都是读了官方 converter 之后写的，不是猜的。
 *
 * ⚠️ `merge_forward` 这里**不传** `fetchSubMessages`：官方拿不到子消息时给
 * `<forwarded_messages/>`（它自己的占位契约）。有那个能力时它会把整段聊天记录展开 ——
 * 展开是官方的事，这里要钉的是"这条消息不会被我们丢掉"。
 */
const CASES = [
  ['text', { text: '你好' }],
  ['post', { title: '标题', content: [[{ tag: 'text', text: '正文' }]] }],
  ['image', { image_key: 'img_v3_types' }],
  ['file', { file_key: 'file_v3_types', file_name: '报告.pdf' }],
  ['sticker', { file_key: 'sticker_v3_types' }],
  ['audio', { file_key: 'audio_v3_types' }],
  ['media', { file_key: 'media_v3_types', file_name: '片子.mp4' }],
  ['merge_forward', {}],
  ['interactive', { elements: [[{ tag: 'text', text: '卡片里的字' }]] }],
  ['share_chat', { chat_id: 'oc_shared' }],
  ['share_user', { user_id: 'ou_shared' }],
  ['location', { name: '公司', latitude: '31.2', longitude: '121.5' }],
  ['system', { template: '{user} 加入了群聊', user: '某人' }],
  ['not_a_real_type', { text: '未知类型但带 text' }],
];

/** 附件承载的那几个：正文留空，信息在 resources 上 */
const RESOURCE_BORNE = new Set(['image', 'file', 'audio', 'video', 'media', 'sticker']);

test('★★ 官方的每一种类型，我们都不会把它的内容弄丢', async () => {
  const lost = [];
  for (const [type, content] of CASES) {
    const official = await normalize(rawEvent(type, content), { botIdentity: BOT });
    assert.ok(
      official.content.trim().length > 0,
      `${type}：官方渲染出来是空的 —— 那这条用例就证明不了什么，先去看 converter`,
    );
    assert.equal(official.rawContentType, type, 'rawContentType 要原样是飞书那个类型');

    const inbound = toInbound(official);
    if (RESOURCE_BORNE.has(type)) {
      assert.equal(inbound.text, undefined, `${type}：正文该留空（信息在附件上）`);
      assert.ok(inbound.raw.resources.length > 0, `${type}：要有资源可落盘`);
    } else if (inbound.text !== official.content.trim()) {
      lost.push(`${type}：官方给了 ${JSON.stringify(official.content)}，我们给出去的是 ${JSON.stringify(inbound.text)}`);
    }
  }
  assert.deepEqual(lost, [], `消息被整条丢掉了：\n  ${lost.join('\n  ')}`);
});

test('★ 合并转发的聊天记录：官方给的占位也要带上（丢了就是"空提示词"）', async () => {
  const official = await normalize(rawEvent('merge_forward', {}), { botIdentity: BOT });
  const inbound = toInbound(official);
  assert.match(inbound.text ?? '', /forwarded_messages/, '这条最容易整条消失：转发一段聊天记录给管家');
});

test('★ 富文本（post）拍平之后照旧带正文（第 18 轮之前就唯一带正文的两种之一）', async () => {
  const official = await normalize(
    rawEvent('post', { title: '标题', content: [[{ tag: 'text', text: '正文' }, { tag: 'a', text: '链接', href: 'https://x' }]] }),
    { botIdentity: BOT },
  );
  const inbound = toInbound(official);
  assert.match(inbound.text ?? '', /标题/);
  assert.match(inbound.text ?? '', /正文/);
  assert.match(inbound.text ?? '', /链接/);
});
