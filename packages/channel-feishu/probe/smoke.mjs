#!/usr/bin/env node
/**
 * 真机冒烟：证明「扫码 → 长连接 → 收一条 → 回一条」这条路真的通。
 *
 * ── 为什么先跑这个，而不是直接跑 butler ──────────────────────────
 *
 * 这条路要验的是**平台侧**：凭据对不对、事件投递到不到、权限点开没开、能不能回。
 * 先把平台跑通，再谈适配层 —— 反过来的话，出问题时分不清是我们的映射写错了，
 * 还是飞书那边的权限没开。而且它不碰任何管家状态：不用装、不用配置、跑完就走。
 *
 * 它**故意只用官方包**，不 import 我们这个包的代码 —— 这样它就是一把干净的尺子：
 * 它要是通了而管家不通，问题一定在我们这边。
 *
 * 用法：
 *   bash packages/channel-feishu/probe/run.sh          # 没凭据就扫码注册
 *   bash packages/channel-feishu/probe/run.sh --dry    # 只看要做什么，不联网、不建应用
 *
 * 已经有凭据（比如开发者后台建的）就放进环境变量，跳过扫码：
 *   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx bash packages/channel-feishu/probe/run.sh
 *
 * @module @butler/channel-feishu/probe
 */

import { registerApp, createLarkChannel } from '@larksuite/channel';

const DRY = process.argv.includes('--dry');

if (DRY) {
  console.log('— dry run：下面这些是"真跑时会做的事"，现在什么都没发出去 —');
  console.log('  1. 看环境变量 LARK_APP_ID / LARK_APP_SECRET');
  console.log('     有 → 直接用它；没有 → 走 registerApp 扫码注册（不需要开发者后台、不需要公网 IP）');
  console.log('  2. createLarkChannel({ appId, appSecret, policy: { requireMention: true } })');
  console.log('  3. channel.on("message") —— 打印真实字段，并回一句"收到：…"');
  console.log('  4. channel.connect() —— WebSocket 长连接，连上后打印机器人身份');
  console.log('  5. 等你用手机飞书发一条消息（单聊；群里要 @ 它），收到就回复；Ctrl-C 退出');
  console.log('');
  console.log('  通了就证明五件事：凭据、长连接、事件投递、权限点、回复 —— 全对。');
  process.exit(0);
}

let appId = process.env.LARK_APP_ID ?? '';
let appSecret = process.env.LARK_APP_SECRET ?? '';

if (!appId || !appSecret) {
  console.log('没有凭据 → 走扫码注册。手机飞书在手边就行。\n');
  const creds = await registerApp({
    onQRCodeReady: async ({ url, expireIn }) => {
      console.log('用手机飞书扫这个二维码（或把下面的链接发到手机上点开）：\n');
      // 有 qrcode 就画在终端里；没有就直接给链接 —— 不因为少一个可选依赖就走不下去
      try {
        const { toString } = await import('qrcode');
        console.log(await toString(url, { type: 'terminal', small: true }));
      } catch {
        console.log('（没装 qrcode，直接打开链接）');
      }
      console.log(`  ${url}`);
      if (expireIn) console.log(`  ${expireIn} 秒内有效`);
      console.log('');
    },
    onStatusChange: (s) => console.log(`  扫码状态：${s.status}`),
  });
  appId = creds.client_id;
  appSecret = creds.client_secret;
  console.log('拿到凭据了（不打印内容）。下次想免扫码，把它们放进环境变量：');
  console.log('  export LARK_APP_ID=...  export LARK_APP_SECRET=...\n');
}

const channel = createLarkChannel({
  appId,
  appSecret,
  // 群里要 @ 它才理（跟管家那条路的习惯一致）；单聊不受影响
  policy: { requireMention: true },
});

channel.on('message', async (msg) => {
  // 打印**真实字段**，不打印注释里猜的那些 —— 这一步的产出之一就是"官方包到底给什么"
  console.log('收到一条消息：');
  console.log(JSON.stringify({
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    chatMode: msg.chatMode,
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderIsBot: msg.senderIsBot,
    content: msg.content,
    rawContentType: msg.rawContentType,
    mentionedBot: msg.mentionedBot,
    replyToMessageId: msg.replyToMessageId,
    resources: msg.resources,
  }, null, 2));

  try {
    const res = await channel.reply(msg, { markdown: `收到：${msg.content}` });
    console.log(`已回复（${res.messageId}）\n`);
  } catch (error) {
    console.error(`回复失败：${error?.message ?? error}\n`);
  }
});

await channel.connect();
const me = channel.botIdentity;
console.log(`长连接已建立。机器人身份：${me ? `${me.name}（${me.openId}）` : '未知'}`);
console.log('现在用手机飞书给它发一条消息（单聊；群聊里记得 @ 它）。Ctrl-C 退出。\n');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n断开、退出。');
    void channel.disconnect().finally(() => process.exit(0));
  });
}
