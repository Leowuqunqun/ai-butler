/**
 * DSH 插件：把微信接进来（cordis 函数插件）。
 *
 *     dsh plugin --profile web add <这个包>
 *
 * 挂上之后：微信里说的话 → DSH 的一个会话（在 DSH 里干活）→ 回复回到微信。
 *
 * ── 这个文件负责什么 ────────────────────────────────────────────
 *
 * 只负责**接线**：把微信通道挂进这个 context、把桥接层接到 `ctx.channel` 上、
 * 该开收信就开收信。业务逻辑在 `bridge.mjs`（认主/排队/回复）、
 * 跑一轮的细节在 `turn.mjs`（DSH 会话 API）。分开是为了能离线测 —— 这个文件
 * 里剩下的东西几乎全是"DSH 的名字"。
 *
 * ── 为什么通道是**自己挂**的 ────────────────────────────────────
 *
 * 也可以在本包的 `cordis.patch.yml` 里多写一行 `name: 'wechat-agent-bridge'`，
 * 让 DSH 去解析那个包名。但那样就依赖"profile 的 node_modules 能解析到
 * 我们依赖的包名"（pnpm 的布局、hoist 设置、linker 都会影响这件事）。
 * 自己 `ctx.plugin(...)` 用的是**本包自己的** import，任何布局都成立。
 *
 * @module @butler/dsh-plugin
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';
import WechatChannel from 'wechat-agent-bridge';

import { WechatBridge, ownerState } from './bridge.mjs';

/** cordis 用的插件名（日志与诊断里显示这个） */
export const name = 'butler-wechat';

/**
 * 依赖的宿主服务。**只列 `dsh-base` 里就有的** ——
 * 这样 web profile 和 headless profile 都能挂（`sessionController` /
 * `workspaceRegistry` 那些只有 web 有，这里一个都不用）。
 */
export const inject = ['agents', 'sessions', 'agentDefaultModel'];

export const Config = z.object({
  /** 微信登录态与状态目录。空 = `$DSH_HOME/butler-wechat`（默认 `~/.dsh/butler-wechat`） */
  home: z.string().default(''),
  /** 微信里的活在哪干（会话的工作目录）。空 = DSH 进程的当前目录 */
  cwd: z.string().default(''),
  /** 认主：只服务这些人（微信 userId）。空 = 让第一个说话的人认主，并记住 */
  owner: z.array(z.string()).default([]),
  /** `owner` 为空时，允不允许"第一个说话的人认主"。关掉 = 谁都不服务，直到显式配 owner */
  claim: z.boolean().default(true),
  /** 挂上就开始收信。关掉 = 只挂通道不启动（自测、或者想自己控制启动时机） */
  autostart: z.boolean().default(true),
  /** 发"正在输入"（尽力而为，失败不影响回复） */
  typing: z.boolean().default(true),
  /** 回复时引用原消息 */
  quoteReply: z.boolean().default(true),
  /** 没有登录态时自己起扫码页等着扫（关闭则退回"报错让人去跑 qr 命令"） */
  qrPage: z.boolean().default(true),
  /** 扫码页端口，只监听 127.0.0.1；被占用会往后找 */
  qrPort: z.number().default(8099),
});

/** 默认的状态/登录态目录：跟 DSH 自己的家放一起，备份时一起搬 */
function defaultHome() {
  const base = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(base, 'butler-wechat');
}

export async function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[butler-wechat] ${message}`);
    } catch {
      console.log(`[butler-wechat] ${message}`);
    }
  };

  const home = config.home && config.home !== '' ? config.home : defaultHome();
  const cwd = config.cwd && config.cwd !== '' ? config.cwd : process.cwd();

  // 一个 context 只能有一个通道实现（cordis 对服务位的标准行为）。
  // 先自己判一下，报一句人话，而不是让 cordis 抛一句看不懂的重复服务错误。
  if (ctx.get('channel') !== undefined) {
    throw new Error(
      '这个 profile 里已经有一个通道了（ctx.channel 被占）。一个 context 只能有一个通道实现，' +
        '要么卸掉另一个，要么别再装这一个。',
    );
  }

  // ── 1. 挂微信通道（协议实现只此一份，见 wechat-agent-bridge） ──
  await ctx.plugin(WechatChannel, {
    home,
    qrPage: config.qrPage !== false,
    qrPort: config.qrPort,
  });
  const channel = ctx.get('channel');
  if (channel === undefined) throw new Error('微信通道没挂上：ctx.channel 仍然是空的');

  // ── 2. 尽力拿到 installModelSelection（DSH 用它把 provider/model 装进会话） ──
  // 拿不到就只传 agentOptions：这台机器上的 DSH 换过内部 API 时，插件不该整个起不来。
  let installSelection;
  try {
    ({ installModelSelection: installSelection } = await import('@deepseek-ai/dsh-agent'));
  } catch (error) {
    log(`拿不到 installModelSelection（不影响收信）: ${error?.message ?? error}`);
  }

  // ── 3. 接线 ──
  const bridge = new WechatBridge({
    channel,
    agents: ctx.agents,
    sessions: ctx.sessions,
    model: ctx.agentDefaultModel,
    installSelection,
    cwd,
    config,
    state: ownerState(home),
    log,
    onEvent: (handler) => ctx.on('session/event', handler),
  });

  const onMessage = (msg) => {
    // 故意不 await：收信是长轮询，在这里等一轮 agent 会把收信卡住
    bridge.onMessage(msg);
  };
  channel.onMessage(onMessage);

  ctx.effect(() => () => {
    channel.offMessage(onMessage);
    return bridge.dispose();
  });

  // ── 4. 开始收信 ──
  // 顺序要紧：**先订阅再 start** —— start 之后随时可能来消息
  if (config.autostart !== false) {
    await channel.start();
    ctx.effect(() => () => channel.stop());
    log(`开始收信：会话目录 ${cwd}，状态目录 ${home}`);
  } else {
    log(`通道已挂上，但没有开始收信（autostart=false）：状态目录 ${home}`);
  }
}
