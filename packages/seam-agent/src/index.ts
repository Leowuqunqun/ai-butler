/**
 * Agent 能力位 —— `ctx.agent`。
 *
 * ── 这个包**只有接口，没有实现** ────────────────────────────────
 *
 * "干活的那颗大脑"是可替换的。想接自己的 agent（DSH、Claude Code、
 * 一个 shell 脚本、自研 HTTP 服务……），你要做的是：
 *
 *   1. 装这个包，`extends AgentService`
 *   2. 实现 `id` 和 `run()`
 *   3. 给它加 `static Config`（自己的配置项，比如二进制路径、超时）
 *   4. `export default` 你的类 —— 它就成了一个 cordis 插件
 *
 * 核心层只认 `ctx.agent`，不认"dsh"。换大脑**不需要改核心层一行代码**。
 *
 * ── 用法（核心层视角）────────────────────────────────────────────
 *
 *     ctx.inject(['channel', 'agent'], (ctx) => {
 *       ctx.channel.onMessage(async (msg) => {
 *         const r = await ctx.agent.run({ text: msg.text ?? '', cwd: '/w', sessionId })
 *         await ctx.channel.sendText(msg.fromId, r.text ?? r.error ?? '（没有输出）')
 *       })
 *     })
 *
 * ── 实现者必须遵守的四条 ─────────────────────────────────────────
 *
 * 1. **一问一答。** 核心层是串行的（上一条没跑完不会跑下一条），
 *    实现不要自己再开长驻循环。
 * 2. **失败必须说。** 返回 `error` 而不是抛异常；抛了核心层也会兜住，
 *    但错误信息里请带上"为什么"，别只说"失败了"。
 * 3. **尊重 `signal`。** 拉子进程的实现要能被打断——agent 一跑几分钟，
 *    用户改主意了不该只能干等超时。
 * 4. **不要自己回消息。** 你只管产出结果，怎么发给用户是核心层的事。
 *
 * @module @butler/seam-agent
 */

import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentRequest, AgentResult, HealthCheck } from './types.js';

export type * from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    agent: AgentService;
  }
}

/**
 * Agent 服务的抽象基类。
 *
 * 继承它、实现抽象方法、`export default`，就是一个可加载的 cordis 插件；
 * 它会把自己注册为 `ctx.agent`。**一个 context 只能有一个 agent 实现**——
 * 加载第二个会抛错（cordis 对重复服务位的标准行为）。
 *
 * > 想同时挂多个大脑、按内容路由？那是**编排层**的事（组合多个实现），
 * > 不是这个服务位的事。一个服务位一个当前生效的实现，选择权在配置。
 */
export abstract class AgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agent');
  }

  /** agent 标识，例如 `'dsh'`。用于日志和流水，不参与逻辑分支 */
  abstract readonly id: string;

  /** 人看的名字。不给就用 `id` */
  readonly label?: string;

  /** 这个实现支不支持取消（`signal`） */
  readonly cancellable: boolean = false;

  /**
   * 跑一轮。
   *
   * 实现**不应当抛异常**；真出了事就返回 `{ error }`。
   * 万一抛了，核心层会兜住并把它变成一句给用户看的错误说明。
   */
  /**
   * 自检（**可选**）。返回的每一条都会原样出现在 `butler doctor` 的输出里。
   *
   * 为什么放在 seam 上，而不是让 doctor 从外面查：**只有实现自己知道该验什么**。
   * 微信通道知道登录态存在哪、dsh 知道它需要哪个二进制、exec 知道 argv[0] 在不在。
   * 让 doctor 去猜，就得把每个实现的配置 schema 抄一份 —— 那是维护灾难，也是层次错误。
   *
   * 几条约定：
   *   - **不抛错**。真出意外就返回一条 `ok: false` 并说明，别让整个自检挂掉。
   *   - **别做重活**。只查前置条件（文件在不在、登录态有没有、目录可不可写），
   *     不要真去连网、不要真跑一次任务。
   *   - **没实现就是没有**，doctor 会跳过 —— 这是可选的，不是必须的。
   */
  check?(): Promise<HealthCheck[]> | HealthCheck[];

  abstract run(req: AgentRequest): Promise<AgentResult>;
}

export default AgentService;
