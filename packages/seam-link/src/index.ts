/**
 * 链路能力位 —— `ctx.link`。
 *
 * ── 这个包**只有接口，没有实现** ────────────────────────────────
 *
 * 「怎么够到另一台电脑」是可替换的。想接自己的链路（局域网、Tailscale、
 * SSH、自建中继……），你要做的是：
 *
 *   1. 装这个包，`extends LinkService`
 *   2. 实现 `id`、`discover()`、`connect()`
 *   3. 给它加 `static Config`（自己的配置项，比如密钥、静态节点表）
 *   4. `export default` 你的类 —— 它就成了一个 cordis 插件
 *
 * ── 为什么手机遥控电脑**不需要**链路 ─────────────────────────────
 *
 * 手机走微信、电脑长轮询腾讯服务器 —— iLink 本身就是那个现成的公共中继。
 * 所以「在外面遥控家里电脑」零成本、不需要穿透。
 *
 * **只有中枢 → 其他节点才需要链路。** 这就是这个 seam 存在的全部理由：
 * 让管家的主控机器去够到第二台、第三台电脑。
 *
 * ── 用法（中枢视角）─────────────────────────────────────────────
 *
 *     const devices = await ctx.link.discover()
 *     const home = devices.find((d) => d.alias === '家里那台')
 *     if (!home?.online) return `那台电脑现在离线${since(home?.lastSeen)}`
 *     const session = await ctx.link.connect(home.id)
 *     const result = await session.request('agent.run', { text, cwd },
 *       { onEvent: (e) => e.type === 'progress' && say(e.line) })
 *
 * ── 实现者必须遵守的四条 ─────────────────────────────────────────
 *
 * 1. **必须能拒绝未授权的调用方。** 这是一条安全红线，不是可选项：
 *    局域网是**共享介质** —— 咖啡馆的 WiFi 上，任何人都在同一个广播域里。
 *    没有认证的局域网链路 = 把「用自然语言遥控这台电脑」的接口
 *    敞开给同网的每一个人。实现必须在配置里要求一个密钥，
 *    并且**在收到第一个字节之前就校验**。
 *
 * 2. **`discover()` 不许阻塞。** 它回答的是"现在看得见谁"，
 *    不是"等哪台机器上线"。连不上的节点照常出现在结果里，`online: false` 就够了。
 *
 * 3. **失败必须说。** 把失败收成一个 `error` 事件（或让 `request()` 抛），
 *    别返回一个看起来正常、实际是空的结果 —— 用户会以为"它就是没找到"。
 *
 * 4. **尊重 `signal`。** 已经发出去的请求要能撤，撤了之后不要再回调 `onEvent`。
 *
 * @module @butler/seam-link
 */

import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import type { DeviceInfo, HealthCheck, LinkSession, PairTarget } from './types.js';

export type * from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    link: LinkService;
  }
}

/**
 * 链路服务的抽象基类。
 *
 * 继承它、实现抽象方法、`export default`，就是一个可加载的 cordis 插件；
 * 它会把自己注册为 `ctx.link`。**一个 context 只能有一个 link 实现**——
 * 加载第二个会抛错（cordis 对重复服务位的标准行为）。
 *
 * > 想同时用多条链路（局域网优先、Tailscale 兜底）？那是**编排层**的事
 * > （一个实现内部组合多条链路，或者按 `DeviceInfo.link` 路由），
 * > 不是这个服务位的事。一个服务位一个当前生效的实现，选择权在配置。
 */
export abstract class LinkService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'link');
  }

  /** 链路标识，例如 `'lan'` / `'tailscale'`。用于日志与流水，不参与逻辑分支 */
  abstract readonly id: string;

  /**
   * 现在看得见哪些设备。
   *
   * **看得见 ≠ 连得上**：`online` 那一栏才是"连得上"。
   * 见 `DeviceInfo` 上的注释。
   */
  abstract discover(): Promise<DeviceInfo[]>;

  /**
   * 连一台设备，拿到一条会话。
   *
   * 连不上**要抛**（带一句人看得懂的话），不要返回一个半死的会话 ——
   * 那样失败会推迟到第一次 `request()` 才暴露，中间那段时间调用方以为一切正常。
   */
  abstract connect(deviceId: string): Promise<LinkSession>;

  /**
   * 收下一台新设备（**可选**）。
   *
   * 有"名册"这个概念的链路才需要实现它。名册是**外部权威**的（尾巴网络：
   * 谁在我的网络里是 Tailscale 说了算）就不需要 —— 那种链路本来就知道谁在。
   *
   * 实现必须把收下的设备**记下来**（落盘），否则用户配过一次的关系
   * 会因为中枢重启就没了。返回收下之后的 `DeviceInfo`。
   */
  pair?(target: PairTarget): Promise<DeviceInfo>;

  /**
   * 忘掉一台设备（**可选**）。
   *
   * 返回的是**结论**而不是人话：`'forgotten'` 忘掉了 / `'unknown'` 本来就不认识 /
   * `'static'` 这台是配置里写死的、忘不掉（得去改配置）。人话由调用处拼 ——
   * 内核知道该跟用户怎么说，链路不知道。
   */
  forget?(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'>;

  /**
   * 自检（**可选**）。返回的每一条都会原样出现在 `butler doctor` 的输出里。
   *
   * 理由跟其他能力位一样：**只有实现自己知道该验什么**。
   * 局域网链路知道要看网卡在不在、密钥配没配；Tailscale 链路知道要看
   * `tailscale status` 输出。让 doctor 去猜，就得把每个实现的配置 schema
   * 抄一份 —— 那是维护灾难，也是层次错误。
   *
   * 几条约定：
   *   - **不抛错**。真出意外就返回一条 `ok: false` 并说明。
   *   - **别做重活**。只查前置条件，不要真去连每台设备（那是分钟级的活）。
   *   - **没实现就是没有**，doctor 会跳过 —— 这是可选的，不是必须的。
   */
  check?(): Promise<HealthCheck[]> | HealthCheck[];
}

export default LinkService;
