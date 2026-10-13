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
 *   bash packages/channel-feishu/probe/run.sh --save   # 顺便把凭据存进管家目录，`butler run` 直接用
 *   bash packages/channel-feishu/probe/run.sh --dry    # 只看要做什么，不联网、不建应用
 *
 * 已经有凭据（比如开发者后台建的）就放进环境变量，跳过扫码：
 *   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx bash packages/channel-feishu/probe/run.sh
 *
 * @module @butler/channel-feishu/probe
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerApp, createLarkChannel } from '@larksuite/channel';

const DRY = process.argv.includes('--dry');
const SAVE = process.argv.includes('--save');

/**
 * 把凭据写进管家认的那个文件：`<home>/state/secrets.json`，格式 `channels.<通道>.<字段>`。
 *
 * 规矩照抄 `packages/cli/src/secrets.ts` 的：**合并写**（不碰别人的 token）、
 * **先临时文件再 rename**（断电不会留半个 JSON）、**0600**。
 * 这里刻意**不打印凭据本身** —— 要看就去那个文件里看，别把它留在滚动的终端里。
 */
function saveCreds(home, appId, appSecret) {
  const dir = join(home, 'state');
  const file = join(dir, 'secrets.json');
  let all = { version: 1, channels: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.channels) all = parsed;
  } catch {
    // 没有、或者坏了 —— 新建一个（坏了的那份会在下一步被覆盖，这正是我们想要的）
  }
  all.channels = { ...(all.channels ?? {}), feishu: { appId, appSecret } };

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}

if (DRY) {
  console.log('— dry run：下面这些是"真跑时会做的事"，现在什么都没发出去 —');
  console.log('  1. 看环境变量 LARK_APP_ID / LARK_APP_SECRET');
  console.log('     有 → 直接用它；没有 → 走 registerApp 扫码注册（不需要开发者后台、不需要公网 IP）');
  console.log('  2. createLarkChannel({ appId, appSecret, policy: { requireMention: true } })');
  console.log('  3. channel.on("message") —— 打印真实字段，并回一句"收到：…"');
  console.log('  4. channel.connect() —— WebSocket 长连接，连上后打印机器人身份');
  console.log('  5. 等你用手机飞书发一条消息（单聊；群里要 @ 它），收到就回复；Ctrl-C 退出');
  if (SAVE) console.log('  ＋ --save：把凭据写进 ~/.butler/state/secrets.json（0600），`butler run` 直接用它');
  console.log('');
  console.log('  通了就证明五件事：凭据、长连接、事件投递、权限点、回复 —— 全对。');
  process.exit(0);
}

let appId = process.env.LARK_APP_ID ?? '';
/**
 * 连不上 / 注册失败时，打一段**能对症**的东西，而不是一坨堆栈。
 *
 * ⚠️ **绝不打印 `error.context`**：权限类失败的 `context.consoleUrl` 是一条**签了名的
 * 一次性授权链接** —— 官方类型声明里写明"是凭据，别写进日志 / 工单 / 聊天"。
 * 这里只取 `code` 和 `message`，并且把"有一条链接但我不打"说出来（免得你以为没这回事）。
 */
function reportFailure(what, error) {
  console.error(`\n✗ ${what}\n`);
  console.error(`  code    : ${error?.code ?? '（没有 code）'}`);
  console.error(`  message : ${error?.message ?? error}`);
  if (error?.context) {
    console.error('  （错误里还带了一条一次性授权链接 —— 那是凭据，这里不打印）');
  }
  console.error('\n最可能的三件事，按概率排：');
  console.error('  1. 凭据不属于这个应用 —— 扫码注册拿到的凭据只对刚建的那个应用有效');
  console.error('  2. 应用没在「事件与回调」里把订阅方式选成**长连接**；或者选的时候');
  console.error('     本地客户端还没在线（官方原文：保存长连接配置时客户端必须已在线，顺序反了会一直失败）');
  console.error('  3. 应用缺权限：收消息至少要有「接收消息」那类权限，而且**改动要发新版才生效** ——');
  console.error('     直接改配置不生效，很容易被当成"代码没写对"');
  console.error('\n把 code / message 这两行原样贴出来就能对症（细节见 docs/CHANNEL-FEISHU.md 第二、三节）。\n');
}

let appSecret = process.env.LARK_APP_SECRET ?? '';

if (!appId || !appSecret) {
  console.log('没有凭据 → 走扫码注册。手机飞书在手边就行。\n');
  let creds;
  try {
    creds = await registerApp({
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
  } catch (error) {
    reportFailure('扫码注册没成', error);
    process.exit(1);
  }
  appId = creds.client_id;
  appSecret = creds.client_secret;
  console.log('拿到凭据了（不打印内容）。下次想免扫码，把它们放进环境变量：');
  console.log('  export LARK_APP_ID=...  export LARK_APP_SECRET=...\n');
}

if (SAVE) {
  // 管家目录默认是 ~/.butler；容器里那套配置也照这个默认走
  const home = process.argv.find((a) => a.startsWith('--home='))?.slice('--home='.length)
    || process.env.BUTLER_HOME
    || join(homedir(), '.butler');
  const file = saveCreds(home, appId, appSecret);
  console.log(`凭据已存进 ${file}（0600）—— 下次 \`butler run\` 选飞书时会直接用它，不用再扫。`);
  console.log('（不打印凭据本身：要看就去那个文件里看。）\n');
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

try {
  await channel.connect();
} catch (error) {
  reportFailure('连不上飞书的长连接', error);
  process.exit(1);
}

// `connect()` 返回 ≠ 已经连上：官方包的握手是异步的，而且它自己会重连，
// 所以"没连上"很可能表现为**静静地挂着**，而不是抛错。
//
// 这里等的信号是 `botIdentity` —— 官方类型声明里写明它是**连接过程中解析出来的**，
// 所以它出现了就说明飞书真的认了这串凭据（比看某个内部状态字符串更靠得住）。
// 等不到就报一段能对症的话：总比让终端一直转圈强。
const deadline = Date.now() + 20000;
let me = channel.botIdentity;
if (!me) {
  console.log('正在等长连接握手（最多 20 秒）…');
  while (!me && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    me = channel.botIdentity;
  }
}
if (!me) {
  reportFailure(
    '长连接 20 秒内没握上手',
    new Error('没在时限内拿到机器人身份（凭据错 / 订阅方式不是长连接 / 权限没发版，都可能长这样）'),
  );
  process.exit(1);
}
console.log(`长连接已建立。机器人身份：${me.name}（${me.openId}）`);
console.log('现在用手机飞书给它发一条消息（单聊；群聊里记得 @ 它）。Ctrl-C 退出。\n');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n断开、退出。');
    void channel.disconnect().finally(() => process.exit(0));
  });
}
