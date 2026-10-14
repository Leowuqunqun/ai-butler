# @butler/seam-channel

> ⚠️ **`@butler/*` 是占位 scope，还没发布到 npm** —— 产品名定了会统一改掉。
> 现在想用请从仓库里直接引（`pnpm install` 后走 workspace 链接）。

通道能力位 —— 在 cordis 里以 `ctx.channel` 暴露。

**这个包只有接口，没有实现。** 它定义"一个 IM 通道要长什么样"，
让核心层（管家）只认 `ctx.channel`、不认"微信"。
换通道 = 换一个插件，**核心层一行都不用改**。

```
packages/
├── seam-channel/          ← 你在这里：只声明接口
├── channel-wechat/        ← 微信的实现（长轮询 iLink）
└── （未来）channel-telegram / channel-feishu / channel-slack …
```

---

## 我想接一个新 IM，要做什么

写一个类，继承 `ChannelService`，实现 5 个方法，`export default`。

下面是一个**能跑的最小通道**（约 40 行）：

```ts
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { ChannelService } from '@butler/seam-channel'
import type { InboundMessage, SendOpts, SendResult } from '@butler/seam-channel'

export class MyChannel extends ChannelService {
  /** ① 通道标识：日志和流水里用，不参与逻辑分支 */
  readonly id = 'myim'

  static Config = z.object({
    token: z.string().default(''),
  })

  constructor(ctx: Context, public config: { token: string }) {
    super(ctx)   // ← 服务名 'channel' 由基类传，你不用管
    // 收尾一律走 effect：cordis 4 没有 'dispose' 事件
    ctx.effect(() => () => this.stop(), 'myim.stop')
  }

  /** ② 开始收信。怎么收随你：长轮询 / webhook / websocket */
  async start(): Promise<void> {
    this.timer ??= setInterval(() => void this.poll(), 3000)
  }

  /** ③ 停止收信。必须能在没 start 过时安全调用 */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** ④ 发文本 */
  async sendText(to: string, text: string, opts?: SendOpts): Promise<SendResult> {
    await fetch(`https://myim.example/api/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.token}` },
      body: JSON.stringify({ to, text }),
    })
    return { chunks: 1 }
  }

  /** ⑤ 发本机文件 */
  async sendFile(to: string, path: string, opts?: SendOpts): Promise<SendResult> {
    // 具体怎么上传由你决定；核心层只交给你一个本机路径
    return { fileName: path.split('/').pop() }
  }

  // ── 剩下的全是基类给的，不用写 ──

  private timer?: NodeJS.Timeout

  private async poll(): Promise<void> {
    for (const raw of await this.fetchNew()) {
      // 附件要先落成本机文件，再交出去（见下面"规则 1"）
      this.emitMessage({
        channel: this.id,
        fromId: raw.from,
        text: raw.text,
        contextToken: raw.replyToken,
        raw,                        // 通道私有数据挂在 raw 上
      })
    }
  }

  private async fetchNew(): Promise<any[]> { return [] }  // 你的拉取逻辑
}

export default MyChannel
```

`export default` 就是全部 —— cordis 靠它把这个类当插件加载，
它会在 `ctx.channel` 上就位。

## 你免费拿到的

| 能力 | 由谁提供 |
| --- | --- |
| `onMessage(handler)` 多消费者分发 | 基类。重复注册同一 handler 会去重（热重载不会收两遍） |
| 一个消费者抛错不打断收信 | 基类。会记日志，其余消费者照常收到 |
| `offMessage(handler)` | 基类 |
| `setTyping(to, on)` 默认 no-op | 基类。**不支持"正在输入"的通道不用管它**，调用不会抛错 |
| `check()` 自检 | **可选**，不实现就没有这个方法。`butler doctor` 会把返回的每一条原样打给用户 |
| 配置的默认值/校验 | `static Config` + cordis |
| 挂载与卸载（含收尾） | cordis 的 fiber。服务位随卸载自动消失 |
| 依赖门控 | `static inject`。依赖没就位时服务位不出现，就位后自动出现 |

## 实现者必须遵守的三条

**规则 1 —— 附件要落成本机文件再交出去。**
远端下载/解密/转码都是通道自己的事。核心层拿到 `LocalFile.path` 就该能直接读，
不许出现"核心层再调一次通道去下载"这种事。微信的附件是加密 CDN 的，
下载+解密全部在通道内部完成（见 `channel-wechat/src/media.mjs`）。

**规则 2 —— 不要在构造函数里开始收信。**
由核心层显式调 `start()`。加载插件 ≠ 立刻上线：
扫码登录之前就不该开始轮询。

**规则 3 —— `emitMessage` 不能阻塞你的收信循环。**
核心层处理慢是核心层的事。把"收信"和"干活"分开：
收了就往队列里塞，干活的慢不该让通道掉线（微信实现就是这么做的）。

## 核心层怎么消费

```ts
// 核心层只认 ctx.channel，永远不 import 任何具体通道
ctx.inject(['channel'], (ctx) => {
  ctx.channel.onMessage(async (msg) => {
    await ctx.channel.setTyping(msg.fromId, true, { contextToken: msg.contextToken })
    const answer = await ctx.agent.run({ text: msg.text ?? '', files: msg.files, cwd })
    await ctx.channel.sendText(msg.fromId, answer.text, { contextToken: msg.contextToken })
  })
})
```

## 数据形状

```ts
interface InboundMessage {
  channel: string          // 'wechat'
  fromId: string           // 通道内的用户标识
  text?: string            // 文本，或语音转写结果
  files?: LocalFile[]      // 已下载到本机
  contextToken?: string    // 回复时要带上（微信必须有）
  raw?: unknown            // 通道私有 —— 核心层不要读
}

interface LocalFile {
  path: string             // 本机绝对路径
  name: string             // 已做安全处理，可直接展示
  mime: string
  size: number
  kind: 'image' | 'video' | 'file' | 'voice' | 'unknown'
}
```

**为什么语音没有单独类型**：微信服务端已经把语音转成文字了，
通道直接塞进 `text` 即可。核心层永远只需要处理"文本 + 附件"。

**为什么没有消息 id**：微信不给（Telegram 给）。要"引用某条消息"只能靠通道自己 ——
微信在文本前面拼一行 `↩ …`，Telegram 用原生的引用回复。

**出站引用是一个字段，不是一段文本**：`SendOpts.quote` 里传的是"在回哪句"的
**原文**，显示成什么样归通道。这件事以前写在内核里，结果是 Telegram 用户会看到
同一句话被引用两次（原生引用一次、文本前缀又一次）—— 见下面的对照表。

**入站引用也是一个字段**：`InboundMessage.quote`。微信把它挂在 text item 的
`ref_msg` 上，Telegram 挂在 `reply_to_message` 上；通道各自压成一行纯文本交出来，
内核只认这一个字段。

**为什么不并进 `text`**：路由只认"正文里某一行以 `@` 开头"。并进去的话，用户
引用一句带 `@某台设备` 的**老话**，就会把这条消息送到那台设备上去执行 ——
他只是在引用自己以前说过的话。而 agent 又确实需要知道"他在回哪句"（连着发几条
时这是理解问题的前提），所以它作为**上下文**进提示词，但不进路由。

**引用的是媒体时，写法只有一种**：用 `quotedMedia(kind, name?)`
（`[图片]` / `[文件（季度报表.xlsx）]`）。这不是洁癖：同一行字会被内核放进提示词，
两个通道各拼一套的话，agent 对"用户在回哪句"的理解就会随着**用哪个 IM** 而变化。

| 通道 | `quote` 传进来之后 |
| --- | --- |
| 微信（`channel-wechat`） | 顶一行 `↩ 原话`（协议没有引用回复字段） |
| Telegram（`channel-telegram`） | 用 `contextToken` 里那个消息号走原生引用，文本一个字不动 |
| 任何通道 | **不传 `quote` 就不加任何引用装饰**（进度播报、队列回执不是"在回答某句话"） |
| 任何通道的 `sendFile` | 也认这个字段（Telegram 把文件挂成原生引用回复；微信的发文件没有引用能力 → **如实忽略**） |

## 怎么加载

```ts
import { Context } from '@deepseek-ai/cordis'
import MyChannel from './my-channel.js'

const ctx = new Context()
await ctx.plugin(MyChannel, { token: process.env.MYIM_TOKEN })
await ctx.channel.start()

// 卸载：服务位消失，effect 里的清理自动执行
await ctx.fiber.dispose()
```

## 踩过的坑（照抄 dsh 时确认过的）

这几条都是**实测**结论，不是照抄文档：

- **`super(ctx, 'channel')`** —— 服务名由基类传，子类 `super(ctx)` 即可。
  一个 context 只能有一个通道实现；加载第二个会抛
  `service "channel" has been registered at ...`，不会静默覆盖。
- **`static Config` 解析出来是普通对象**，直接 `this.config.token` 读就行。
  （dsh 里常见 `this.config.timeoutMs.get()`，那是因为它用了 schemastery 的
  `volatile()`；本项目不需要，别照抄。）
- **cordis 4 没有 `'dispose'` 事件**，只有 `internal/*`。
  收尾一律走 `ctx.effect(() => () => cleanup())`。
- **`ctx.plugin()` 返回 `Fiber`：可以 `await`，但它不是 `Promise` 实例。**
  所以 `assert.rejects(() => ctx.plugin(...))` 会被 Node 拒掉
  （`Expected instance of Promise ... but got an instance of Fiber`）。
  而且加载失败的报错是**异步**冒出来的 —— 不 `await` 就看不见，
  更**不会**同步抛。正确写法：

  ```ts
  await assert.rejects(async () => { await ctx.plugin(Dup) })
  ```
- **`static inject` 未满足时，插件根本不会被构造** ——
  所以"重复注册服务位"的报错也只有在依赖齐了之后才会出现。

## 测试

```sh
pnpm --filter @butler/seam-channel test
```

12 个用例，全部离线（不连网、不需要任何账号凭证）：
覆盖服务位就位、双身份、配置解析、inject 门控、消息分发与去重、
消费者抛错隔离、默认 no-op、重复注册报错、卸载回收。

## License

MIT

---

## 自检：`check?()`

**可选**。实现了，`butler doctor` 就会问你"你这层现在行不行"，并把答案原样打给用户：

```ts
check(): HealthCheck[] {
  return [{
    name: '微信登录态',
    ok: false,
    detail: '还没登录过这台机器',
    fix: '启动时会打印二维码，用微信扫一下就好',
  }];
}
```

**为什么这个检查必须由你（实现者）来写**，而不是让 doctor 从外面查：
只有你知道登录态存在哪、需要哪个二进制、哪个目录必须可写。让 doctor 去猜，
就得把每个实现的配置 schema 抄一份 —— 那是维护灾难，也是层次错误。

三条约定：

- **不抛错。** 真出意外就返回一条 `ok: false` 说明情况。doctor 会兜住抛错，
  但那时用户看到的是一句没用的"自检本身出错了"。
- **别做重活。** 只查前置条件（文件在不在、登录态有没有、目录可不可写）。
  不许真跑一次任务 —— 用户每遇到一次"没反应"就会跑一次自检。
  **唯一允许的联网是一次"有时限的探活"**（Telegram 就是这么做的：问一句 `getMe`
  看这串 token 还认不认，免费、不要权限）。它能查出一类光看文件查不出来的事：
  "昨天还好好的、今天不回消息" —— 因为 token 在对面被作废了。
  但必须同时满足两条，否则就别做：
  ① **有上限**（这条实现用的是 5 秒），不能吊住整个自检；
  ② **连不上不算故障**：网断/超时要说"这次没查"，仍然是 `ok: true` ——
    网一断就报红，只会让用户去修一个不存在的问题。
- **`detail` 说状态，`fix` 说动作。** 尤其 `fix`：那一句话决定用户能不能自己解决。
  别写 "token expired"，写"微信登录过期了，重新扫一下码"。

⚠️ **`ok: true` 也要写 `detail`。** "已登录，3 月 2 日扫的码"比一个光秃秃的
勾有用得多 —— 用户看到它才知道"哦，这台机器上确实登录过"。
