# @butler/seam-link

链路能力位 —— `ctx.link`。**这个包只有接口，没有实现。**

「怎么够到另一台电脑」是可替换的：局域网、Tailscale、SSH、自建中继…… 每一种都是一个独立的包，继承这里，装到管家上。

已经有的实现：

| 实现 | 名册从哪来 | 适合 |
| --- | --- | --- |
| [`@butler/link-lan`](../link-lan) | 配置里手写的 `peers` | 两台机器在同一个 WiFi。零依赖 |
| [`@butler/link-tailscale`](../link-tailscale) | 问 Tailscale：谁在我的网络里 | 中枢和节点不在一个网络里。**线上跑的还是 link-lan 那套协议** |

两个实现一起看，能看清这个 seam 到底分叉在哪：**分叉的是"怎么找到那台机器"，
不该分叉的是线上协议**。第二个实现只多了"问名册"这一步，
`LinkService` / `LinkSession` / 内核的路由一行都没改。

## 先说清楚：手机遥控电脑**不需要**这个

手机走微信、电脑长轮询腾讯服务器 —— **iLink 本身就是那个现成的公共中继**。

你在外面用微信遥控家里电脑，不需要穿透、不需要公网 IP、不需要任何链路。

**只有中枢 → 其他节点才需要链路。** 这就是这个 seam 存在的全部理由：让管家的主控机器去够到第二台、第三台电脑。

## 我想接一条新链路，要做什么

```ts
import { LinkService } from '@butler/seam-link'
import type { DeviceInfo, LinkSession } from '@butler/seam-link'
import z from '@deepseek-ai/schemastery'

export class MyLink extends LinkService {
  static Config = z.object({
    token: z.string().default(''),   // 全部给 default，必填在构造函数里拦（见下面"踩过的坑"）
  })

  readonly config: { token: string }
  readonly id = 'mine'

  constructor(ctx, config) {
    super(ctx)
    if (!config.token) throw new Error('要配一个 token。没有它，同网络的任何人都能遥控这台电脑')
    this.config = config
  }

  async discover(): Promise<DeviceInfo[]> { /* 现在看得见谁 */ }
  async connect(deviceId: string): Promise<LinkSession> { /* 连过去，连不上就抛 */ }
  override check() { /* 可选 */ }
  override async pair(target) { /* 可选：收下一台新设备 */ }
  override async forget(deviceId) { /* 可选：不再管那一台 */ }
}

export default MyLink
```

四步：继承、实现三个成员、加 `static Config`、`export default`。

### 那两个可选方法：`pair` / `forget`

只在"设备怎么进名册"这件事**归你管**的时候才实现：

```ts
pair?(target: PairTarget): Promise<DeviceInfo>        // 把一台新设备收进来
forget?(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'>
```

- **局域网那条链路实现了**：设备是用户拿一个一次性配对码收进来的，收下的记在自己文件里。
- **尾巴网络那条没实现**：名册由 Tailscale 说了算，密钥两边本来就一致 ——
  **它不需要配对**。内核看到没有这个方法，就说"这条链路不用配对，发「设备」看看"。

`forget` 返回的是**结论**（忘掉了 / 我不认识它 / 它写在配置文件里我忘不掉），不是人话 ——
"你去哪删"该怎么说由内核决定（它知道用户接下来要做什么），链路只知道"这台不是我管的"。

**这两件事也不必和"连接"长在一起。** 它们进 seam 是因为用户要在微信里做这两件事，
而做这两件事需要链路那侧配合；如果你的链路根本不需要它们，就别实现 ——
留空比写一个假实现好得多。

## 你免费拿到的

- **服务位注册**：`export default` 之后 `ctx.link` 自动就位，不用手写注册代码
- **配置解析与默认值**：`static Config` 用 schemastery，`this.config` 拿到的就是解析好的普通对象（不用 `.get()`）
- **依赖门控**：加 `static inject = ['memory']`，依赖没就位时你的插件**根本不会被构造**
- **生命周期**：`ctx.effect(() => () => cleanup(), '标签')` 会在卸载时执行
- **自检被 doctor 收集**：实现了 `check?()` 就自动出现在 `butler doctor` 的输出里

## 实现者必须遵守的四条

1. **必须能拒绝未授权的调用方。** 这是安全红线，不是可选项。局域网是共享介质 —— 咖啡馆的 WiFi 上，任何人都在同一个广播域里。没有认证的链路 = 把「用自然语言遥控这台电脑」的接口敞开给同网的每一个人。而且要在**读第一个字节之前**就校验完，不要做流式鉴权。

2. **`discover()` 不许阻塞。** 它回答的是"现在看得见谁"，不是"等哪台机器上线"。连不上的节点照常出现在结果里，`online: false` 就够了。

3. **失败必须说。** 把失败收成一个 error 事件（或让 `request()` 抛），别返回一个看起来正常、实际是空的结果 —— 用户会以为"它就是没找到"。

4. **尊重 `signal`。** 已经发出去的请求要能撤，撤了之后不要再回调 `onEvent`。

## 核心层怎么消费

```ts
const devices = await ctx.link.discover()
const home = devices.find((d) => d.alias === '家里那台')
if (!home?.online) return `那台电脑现在离线${since(home?.lastSeen)}`

const session = await ctx.link.connect(home.id)
const result = await session.request('agent.run', { text, cwd }, {
  onEvent: (e) => e.type === 'progress' && say(e.line),
})
```

**核心层只按 seam 消费**，不认 `LanLink`、不认 `MyLink`。换一条链路，上面这段一个字都不用改。

## 数据形状

### `DeviceInfo`

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识。**不是主机名、不是 IP、不是随机数** —— 那三样都会变 |
| `alias` | 人给的名字，例如「家里那台」。用户说的话最终解析到 `id` |
| `os` | `process.platform` 的值 |
| `capabilities` | 会干什么，例如 `['agent', 'files']` |
| `lastSeen` | 最后一次听到它的时间（epoch ms）。**从没听到过是 `null`，不是 0** |
| `online` | 现在连得上吗 |
| `link` | 从哪条链路看见的，例如 `'lan'` |

`online` 和 `lastSeen` 是**两个独立字段**，因为它们回答两个不同的问题：
"看得见吗"（在广播 / 在清单里）和"连得上吗"（真的握过手）。
用户靠 `lastSeen` 听懂"离线"：不能说"连接失败"，要说"最后在线 3 小时前"。

### `LinkEvent`

三种，**都带 `callId`**：

```ts
| { type: 'progress', callId, line }
| { type: 'done',     callId, result }
| { type: 'error',    callId, message, code? }
```

一条会话上可能同时跑着多个调用。不带 `callId`，调用方就得自己猜哪个进度属于谁 —— 猜错就是**串话**：A 的进度显示在 B 的结果上。

## 一个刻意的设计：进度挂在请求上，不挂在会话上

`LinkSession` **没有**会话级的 `onEvent`。进度走 `request(..., { onEvent })`：

```ts
session.request(method, params, { onEvent, signal })
```

会话级回调看着更省事，但那样每个回调都得自己按 `callId` 过滤一遍，漏一次就串话。挂在请求上，**串话在类型层面就不可能发生**。

会话级只有一个 `onClose(handler)` —— 那是"这条链路断了"，跟某一次调用无关。

## 怎么加载

```ts
await ctx.plugin(MyLink, { token: process.env.TOKEN })
```

**一个 context 只能有一个 link 实现**，加载第二个会抛错（cordis 对重复服务位的标准行为）。

想同时用多条链路（局域网优先、Tailscale 兜底）？那是**编排层**的事 —— 一个实现内部组合多条链路，或者按 `DeviceInfo.link` 路由 —— 不是这个服务位的事。一个服务位一个当前生效的实现，选择权在配置。

> 不过实际上**很少需要组合**：装了 Tailscale 的机器，同一个局域网里也是直连的
> （Tailscale 自己会走最短路径）。所以对"每台机器都装了 Tailscale"的人来说，
> `link-tailscale` 一条就同时覆盖了同网和跨网。
> `link-lan` 留给"就是不想装 Tailscale"的人 —— 零依赖是它唯一的、也是足够的理由。

## 踩过的坑

**`HealthCheck` 在这里是第三份副本。** `seam-channel`、`seam-agent` 各有一份一模一样的（4 个字段）。

**是故意的**：每个 seam 包都要能单独装、单独用，不想让「装个链路」顺带把微信通道的依赖拖进来。类型是结构化的，三份形状相同 ⇒ 互相赋值合法，doctor 照样统一处理。

**但第四份出现时就该抽 `@butler/seam-kit` 了** —— 三份是忍耐，四份是债。

（`seam-agent` 确实 import 了 `seam-channel` 的 `LocalFile`，那是**真数据依赖**：附件形状本来就要在通道和 agent 之间流通。`HealthCheck` 不是这种关系。）

**必填字段只能靠构造函数拦。** `static Config` 拦不住漏填 —— `z.object({ secret: z.string() })` 传 `{}` 不会拒绝（实测，见 `docs/ARCH-technical.md` 第五节）。所以实现必须自己 `if (!config.secret) throw`，而且那句错误信息要是人话。

**别用 `.required()`。** 嵌套对象 + `.required()` 会让静态推断出来的类型引用到 cosmokit 内部类型，`.d.ts` 里没法给那个类型起名字 ⇒ `TS2742`。全部给 `.default()` 就没这问题。

## 测试

```bash
pnpm --filter @butler/seam-link test
```

15 个测试。夹具（`test/fixtures/fake-link.ts`）**故意用 TypeScript 写**：抽象成员漏一个就编译不过 —— 类型契约和运行行为一起验。

其中一条特别值得看：**"`check?()` 是可选的"这条必须用最小实现来验**。拿一个实现了 `check` 的夹具去验，断言必然失败，而失败原因跟契约无关 —— 那是在自欺欺人。

## License

MIT
