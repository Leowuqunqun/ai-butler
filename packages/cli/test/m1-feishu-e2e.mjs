/**
 * 飞书的**端到端**（M1，单机）：真 `FeishuChannel` + 真 `ButlerCore` + 假大脑。
 *
 * ── 为什么要有这一条 ──────────────────────────────────────────
 *
 * 到这儿为止，飞书的测试分两层，各自都很扎实，但**中间那道缝没人走过**：
 *
 *   `packages/channel-feishu/test/*` —— 适配器把官方消息折成 `ctx.channel` 那一层（假大脑：一个数组）
 *   `packages/core/test/*`            —— 内核拿到消息之后怎么办（假通道：一个手写的 emit）
 *
 * 也就是说，"**真的通道 + 真的内核**拼起来"这件事，和前面那些测试说的都无关 ——
 * 而用户手上的正是这个拼装体。所以这里两边都用真的：
 *
 *   通道 = 真 `FeishuChannel`（官方包换成 `FakeLark` —— 协议不是我们的代码）
 *   内核 = 真 `ButlerCore`（真队列、真会话、真去重、真回话）
 *   大脑 = 假的（这条不验模型，验的是"话有没有送到、回没回到对的地方"）
 *
 * 它盖住验收标准里 M-a 那一句：**收到 → 走到大脑 → 原生引用回一条，且同一条 messageId 只送一次。**
 *
 * 假官方包从 `packages/channel-feishu/test/` 借来（测试之间借 fixture，不是产品依赖）；
 * 拼装手法和那边的 `makeFeishu` 一模一样 —— 覆写 `makeChannel`，不需要测试后门。
 *
 * @module @butler/cli/test/m1-feishu-e2e
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { FeishuChannel } from '@butler/channel-feishu';
import { ButlerCore } from '@butler/core';

import { FakeLark, normalized } from '../../channel-feishu/test/fake-lark.mjs';
import { waitFor } from './fixtures/node-helpers.mjs';

/** 记下大脑被叫过几次、收到了什么 —— 每一条断言都在数它 */
class RecordingAgent extends AgentService {
  id = 'rec';
  seen = [];

  async run(req) {
    this.seen.push(req);
    return { text: `记下了：${req.text}` };
  }
}

/** 起一套"真通道 + 真内核 + 假大脑"。和 `packages/cli/test/m2-e2e.mjs` 的 hub 一个路子。 */
async function hub() {
  const dir = mkdtempSync(join(tmpdir(), 'butler-feishu-e2e-'));
  const fake = new FakeLark();

  class TestFeishu extends FeishuChannel {
    makeChannel() {
      return fake;
    }
  }

  const ctx = new Context();
  await ctx.plugin(TestFeishu, { appId: 'cli_e2e', appSecret: 'secret', home: dir });
  await ctx.plugin(RecordingAgent);
  // 开场白关掉：这里量的是"这一轮回了什么"，多一句自我介绍会搅浑
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ owner: null, sessions: {}, helloed: true }));
  await ctx.plugin(ButlerCore, {
    workspace: dir,
    stateFile: join(dir, 'state.json'),
    progressIntervalMs: 0,
    typing: false,
  });
  await ctx.core.start(); // ← 这一步会真的调 `ctx.channel.start()`：先订阅、再连

  return {
    fake,
    agent: ctx.agent,
    async cleanup() {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('★ 端到端 M-a：一条飞书来信 → 真内核 → 大脑 → **原生引用**回一条', async () => {
  const h = await hub();
  try {
    h.fake.emit(normalized({ messageId: 'om_e2e_1', content: '把下载文件夹清了' }));

    await waitFor(() => h.agent.seen.length === 1, '内核把这条信交给了大脑');
    assert.match(h.agent.seen[0].text, /把下载文件夹清了/, '大脑要看到**原话**');

    await waitFor(() => h.fake.replies.length >= 1, '回话发了出去');
    const reply = h.fake.replies[0];
    assert.deepEqual(
      reply.target,
      { chatId: 'oc_chat', messageId: 'om_e2e_1' },
      '回话要**引用那条来信**（原生引用），不是一个孤零零的新气泡',
    );
    assert.match(reply.input.markdown, /记下了：把下载文件夹清了/);
    assert.equal(h.fake.sent.length, 0, '有来信用引用回，别退化成普通发送');
  } finally {
    await h.cleanup();
  }
});

test('★ 端到端去重：同一条 messageId 重推，大脑只跑一次（飞书是"至少一次"投递）', async () => {
  const h = await hub();
  try {
    const dup = normalized({ messageId: 'om_e2e_dup', content: '删掉临时文件' });
    h.fake.emit(dup);
    h.fake.emit(dup); // 官方文档：即使成功接收仍可能收到重复推送

    await waitFor(() => h.agent.seen.length >= 1, '第一条要送到大脑');
    // 等一会儿：如果去重是假的，第二条会在这段时间里露头
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(h.agent.seen.length, 1, '同一条消息只能算一次 —— 这是"别把删文件跑两遍"的底线');
  } finally {
    await h.cleanup();
  }
});
