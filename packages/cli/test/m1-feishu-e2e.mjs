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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 起一套"真通道 + 真内核 + 假大脑"。和 `packages/cli/test/m2-e2e.mjs` 的 hub 一个路子。
 *
 * 传 `home` 进来就**借用**它（跨重启那条要复用同一个管家目录）；不传就自己建一个、
 * 并负责收拾干净。
 */
async function hub(home) {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'butler-feishu-e2e-'));
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
    dir,
    fake,
    agent: ctx.agent,
    async cleanup() {
      await ctx.fiber.dispose();
      // 借来的 home 不删（跨重启那条还要用它再起一次）
      if (!home) rmSync(dir, { recursive: true, force: true });
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

test('★ 端到端 M-a（跨重启）：换个内核、同一个管家目录，重推的那条仍然不算数', async () => {
  const home = mkdtempSync(join(tmpdir(), 'butler-feishu-restart-'));
  const msg = normalized({ messageId: 'om_restart', content: '把日志清了' });

  try {
    // 第一次：正常收下、正常办
    const first = await hub(home);
    try {
      first.fake.emit(msg);
      await waitFor(() => first.agent.seen.length === 1, '第一次要送到大脑');
    } finally {
      await first.cleanup();
    }

    // 「重启」：同一个管家目录，全新的容器和内核 —— 去重表只能从盘上认出这条
    const second = await hub(home);
    try {
      second.fake.emit(msg);
      // 给"如果没有去重就会跑"留出时间；跑过就一定会被看见
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        second.agent.seen.length,
        0,
        '跨重启重推同一句话不该再办一次 —— 飞书会重推，而这条命令是"清日志"',
      );
    } finally {
      await second.cleanup();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('★ 端到端 M-b：一张图经真内核交到大脑手上时，已经是**本机可读的真实文件**', async () => {
  const h = await hub();
  try {
    h.fake.downloadContentType = 'image/png';
    h.fake.downloadBytes = Buffer.from('假装这是一张图');
    h.fake.emit(normalized({
      messageId: 'om_e2e_img',
      content: undefined, // 纯附件、没打字
      resources: [{ type: 'image', fileKey: 'img_1', fileName: '截图.png' }],
    }));

    await waitFor(() => h.agent.seen.length === 1, '带图的消息也要走到大脑');
    const req = h.agent.seen[0];
    assert.equal(req.files?.length, 1);

    const f = req.files[0];
    assert.ok(existsSync(f.path), `大脑拿到的路径必须已经可读：${f.path}`);
    assert.equal(readFileSync(f.path, 'utf8'), '假装这是一张图', '内容要对得上，不能只是个空壳路径');
    assert.equal(f.kind, 'image');
    assert.equal(f.name, '截图.png');

    // 纯附件消息没有正文，内核会自己补一句提示 —— 里面必须带上"在本机哪里"
    assert.match(req.text, /image\/png/, '提示里要有 mime 之类，大脑才知道这是什么、去哪读');
    assert.match(req.text, /截图\.png/);
  } finally {
    await h.cleanup();
  }
});
