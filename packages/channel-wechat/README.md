# wechat-agent-bridge

**把微信变成你的 agent 遥控器。** 手机扫码登录个人微信，之后在微信里发消息，
就跑在你电脑上的 agent 干活——回文本、发文件。

不需要公网 IP、不需要域名、不需要回调地址。收消息走长轮询，发消息走同一个通道。

```
   你的手机微信                    你的电脑
  ┌──────────────┐            ┌──────────────────────────────┐
  │  「查一下今天 │  长轮询收   │  wechat-agent-bridge         │
  │    的日程，   │ ─────────► │   ├─ src/ilink.mjs  微信通道  │
  │    发我截图」 │            │   ├─ 队列 + 串行 worker       │
  │              │ ◄───────── │   └─ src/backends/  ┌───────┐ │
  │  「给你，三张 │   发文本/   │        （可插拔）◄──┤ agent │ │
  │    图」      │    发文件   │                     └───────┘ │
  └──────────────┘            └──────────────────────────────┘
```

---

## 为什么又造一个

微信没有官方的个人号机器人 API。已经有的几条路各有各的问题：

| 方案 | 问题 |
| --- | --- |
| 公众号 / 企业微信 | 要认证、要备案，还得让对方也装；**收不到你私人微信的消息** |
| 逆向 hook 微信客户端 | 版本一升级就崩，封号风险高 |
| 桌面 GUI 自动化（截图 + 模拟点击） | 慢、脆、会霸占你的屏幕；一个任务能烧掉几十步还不一定成 |
| 本项目 | 走腾讯的 **iLink Bot** 通道（个人微信扫码），协议稳定，**不需要公网回调** |

而"接哪个 agent"这件事，本项目**不替你决定**：微信通道和 agent 是分开的，
agent 是可插拔后端（内置 DSH / 任意命令 / 自己写一个模块）。

---

## 特性

- **扫码登录**，不需要公网 IP、域名、证书、回调——长轮询拉消息
- **扫码页会自动换码**：iLink 的二维码只活约 90 秒，所以本项目给的是一张会自动刷新的网页，而不是一个静态图片
- **会话续接**：每个微信用户对应一个 agent 会话，agent 有长期记忆
- **收语音**：微信服务端已经把语音转成文字，不需要自己接 ASR
- **收图片 / 文件**：微信发来的图片和文件会自动从 CDN 取回、解密、落到 `state/inbox/`，
  然后把**本机路径**交给 agent。所以 agent 直接就能"看图"和"读文件"——
  图片它自己看，xlsx 它自己解析，**后端不需要为附件做任何适配**
- **发文件**：agent 在回复里写一行 `[[file:/绝对/路径|配文]]`，桥自动上传并发送（AES-128-ECB 加密上传到微信 CDN）
- **可插拔 agent 后端**：DSH / 任意命令行程序 / 自己写的模块
- **收干分开**：收消息的循环从不被 agent 阻塞，所以你随时能发下一条；忙的时候它会先回一句"前面还有 N 条"
- **引用原问题**：协议没有原生引用能力（见下），所以每条回复开头会带一行 `↩ 你的原问题`，连发多条时不会串味
- **看得见你的引用**：你在微信里引用某条消息再说话，被引用的那句会作为上下文交给 agent（走 `InboundMessage.quote`）——
  但它**不参与路由**，所以引用一句带 `@设备` 的老话不会让这条消息被送到那台设备上去。
  （⚠️ 用 `butler run` 那条路才有；旧命令行入口 `wechat-agent-bridge` 至今不处理引用，见下面的"已知缺口"）
- **离线可测**：`npm test` 不需要微信也不需要模型

---

## 快速开始

需要 **Node.js ≥ 20**。

```bash
git clone <本仓库> wechat-agent-bridge
cd wechat-agent-bridge
npm install
```

### 1. 先什么都不接，验证通道是通的

```bash
node src/cli.mjs config    # 生成默认配置（state/config.json）
node src/cli.mjs qr        # 起扫码页，浏览器打开它打印的地址，用手机微信扫
```

扫完手机上点确认，终端会打印 `✅ 绑定成功`。

默认后端是 `echo`（不接模型，原样回显）。现在先这么跑：

```bash
node src/cli.mjs run
```

**在微信里给这个 bot 发一条消息。** 因为配置里 `allowFrom` 是空的、`bindFirstSender`
是开的，**第一条来信会把这个微信号认成主人**，之后只服务它。

你应该会收到类似这样的回话：

```
↩ 你好
（echo 后端，未接模型）收到：你好
```

到这里，微信通道、队列、引用、白名单就都验证过了。**通道没问题了再去接模型**——
这样出问题的时候你知道该怀疑哪一半。

### 2. 接你自己的 agent

**改用 DSH**（推荐，本项目就是为它写的）：

```bash
cp examples/dsh.patch.yml my.patch.yml
# 编辑 my.patch.yml：把 ① 改成你的模型通道
```

```jsonc
// state/config.json
{
  "workspace": "/你的/工作目录",
  "agent": {
    "backend": "dsh",
    "dsh": { "patchFile": "./my.patch.yml" }
  }
}
```

自检 patch 文件有没有问题：

```bash
dsh --profile headless --patch ./my.patch.yml --dump-config | head
```

然后重启桥：

```bash
node src/cli.mjs run
```

**改用别的 agent**（Claude Code、Codex、任何一问一答的 CLI）：

```jsonc
{
  "agent": {
    "backend": "exec",
    "exec": { "argv": ["/usr/local/bin/my-agent"], "input": "arg" }
  }
}
```

**写自己的后端**：一个导出 `run(ctx)` 的 `.mjs` 文件，然后把 `backend` 指过去。
契约（很短）见 [`src/backends/index.mjs`](src/backends/index.mjs) 头部注释。

### 3. 放到后台常驻

```bash
nohup node src/cli.mjs run >> state/bridge.log 2>&1 &
```

macOS 用户建议装成 launchd 服务（**进程由系统拉起而不是从 shell 拉起，
可以避免下面「坑 2」**）：

```bash
# ~/Library/LaunchAgents/com.you.wechat-agent-bridge.plist 里写：
#   ProgramArguments: [<node 绝对路径>, <项目>/src/cli.mjs, run]
#   WorkingDirectory: <项目>
#   RunAtLoad: true   KeepAlive: true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.you.wechat-agent-bridge.plist
```

---

## 命令

源码检出里跑（装成命令行工具之后就是 `wechat-agent-bridge <子命令>`，参数完全一样）：

```
node src/cli.mjs qr                 起扫码页登录（--port 换端口）
node src/cli.mjs login              终端模式登录（不断打印二维码文件路径）
node src/cli.mjs run                常驻：收消息 → agent → 回话
node src/cli.mjs status             看数据目录 / 配置 / 绑定 / 后端 / 最近流水
node src/cli.mjs send "文本"        主动发一条（--to <userId> 指定收件人）
node src/cli.mjs sendfile <路径> [配文]
node src/cli.mjs backends           列出内置 agent 后端
node src/cli.mjs audit [n]          看最近 n 条收发流水
node src/cli.mjs config             打印合并后的配置
```

---

## 数据放哪（`state/`）

配置、微信登录态、会话游标、收件箱全在**同一个目录**下：

```
<数据目录>/
└── state/
    ├── config.json     配置
    ├── token.json      微信登录态（泄露 = 把号交出去）
    ├── sessions.json   会话映射
    ├── cursor.json     长轮询游标
    ├── audit.jsonl     收发流水
    └── inbox/          收到的图片/文件解密后落这里
```

数据目录按这个优先级决定：

| 优先级 | 怎么给 | 什么时候用 |
| --- | --- | --- |
| 1 | `--home <目录>` / `--home=<目录>` | 临时换一份数据（第二套配置、测试） |
| 2 | `WAB_HOME=<目录>` | 做成服务 / 跑多个实例 |
| 3 | 包目录（源码检出时） | 开发态：数据就在仓库里，方便翻 |
| 4 | `~/.wechat-agent-bridge` | **`npm i -g` 安装态** |

第 4 条不是洁癖：包一旦被装进 `node_modules`，写包目录意味着
**下次升级配置和登录态全丢**，系统级 Node 下还可能根本没有写权限。
所以路径里一带 `node_modules` 就自动改走用户目录。

`status` 随时能看到当前实际用的是哪个：

```
$ wechat-agent-bridge status
数据
  state 目录               /Users/you/.wechat-agent-bridge
  配置文件                  /Users/you/.wechat-agent-bridge/state/config.json
```

---

## 配置

配置写在 `<数据目录>/state/config.json`（首次运行自动生成）。所有字段都有默认值，
**只需要写你想改的**。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | 项目目录 | agent 在哪个目录干活（它看到的根） |
| `allowFrom` | `[]` | 只服务这些微信 userId。**空 = 谁先发谁是主人** |
| `bindFirstSender` | `true` | 白名单为空时，第一条来信自动认主并落盘 |
| `maxReplyChars` | `1200` | 单条消息上限，超出自动分条并加 `(1/N)` 前缀 |
| `agentTimeoutMs` | `300000` | 一次 agent 调用的硬超时，超了掐断并如实告知 |
| `typing` | `true` | 发"正在输入" |
| `quoteReply` | `true` | 回复开头带一行 `↩ 原问题`（**这一行由本通道渲染** —— 内核只把"在回哪句"传下来，别的通道可能用原生引用） |
| `queueAck` | `true` | 排队时先回一句"前面还有 N 条" |
| `progressIntervalMs` | `40000` | 处理中的进度提示间隔，0 = 关 |
| `maxQueue` | `20` | 积压上限，超了拒收 |
| `media.enabled` | `true` | 关掉就完全不下载收到的图片/文件 |
| `media.cdnBaseUrl` | （默认 CDN） | 一般不用改，服务端返回 baseurl 时会覆盖 |
| `media.maxBytes` | `104857600` | 单个附件上限（100MB，协议上限） |
| `agent.backend` | `"echo"` | `echo` / `exec` / `dsh` / 模块路径 |

---

## 当 cordis 插件用（把微信接进你自己的内核）

上面那些是**命令行**用法，装完就能跑。如果你在搭自己的 agent 内核
（或者用 [dsh](https://github.com/deepseek-ai/dsh) 那套 cordis），
这个包同时是一个标准的 **`ctx.channel` 插件实现**：

```js
import { Context } from '@deepseek-ai/cordis';
import WechatChannel from 'wechat-agent-bridge/plugin';

const ctx = new Context();
await ctx.plugin(WechatChannel, { home: '/path/to/data' });

// 现在 ctx.channel 就是微信通道，按 seam 的契约消费即可
ctx.channel.onMessage((msg) => {
  console.log(msg.fromId, msg.text, msg.files);   // files 已经是本机路径
});
await ctx.channel.start();

await ctx.channel.sendText('某个 userId', '回你一句');
await ctx.channel.sendFile('某个 userId', '/tmp/报告.pdf');
```

插件和命令行**共用同一批底层模块**（协议、媒体解密、存储），
所以不存在两套逻辑各自演化 —— 命令行今天能跑，插件走的是同一条路。

### 第一次启动，它自己去登录

```js
await ctx.plugin(WechatChannel, { home: '/path/to/data' });
await ctx.channel.start();      // ← 这里可能等十几分钟：它在等人扫码
```

没有登录态时，`start()` **不会报错了事**，而是：起一个只监听 `127.0.0.1` 的
扫码页 → **自动把浏览器打开** → 等扫码 → 把登录态落盘 → 继续上线。
中间不需要第二条命令（以前这里会让人去跑 `wechat-agent-bridge qr` ——
对一个不懂技术的人来说，那条命令的名字他猜不出来）。

```js
// 没有浏览器的地方（服务器 / CI）：关掉扫码页，让它照旧立刻报错
await ctx.plugin(WechatChannel, { home: '/data', qrPage: false });
```

- 等人扫码最多等 `loginTimeoutMs`（默认 12 分钟），超时的错误信息里带着下一步。
- 这期间 `stop()` 也管用：会如实报"登录已被取消"，而不是假装登录成功。
- `qrPort`（默认 8099）被占时会自动往后找端口 —— 打出来的地址就是真的那个。

三件要知道的事：

- **附件下载发生在通道内部，但不在收信循环里。** 你拿到的 `msg.files`
  永远是已经落到 `state/inbox/` 的本机路径（跟命令行行为一致）。
- **这个插件不是权限门。** 配置里那个 `allowFrom` 只是粗筛，
  真正的门（谁能让这台电脑干活）在核心层。没接核心层之前不要把它暴露出去。

契约本身在 [`@butler/seam-channel`](https://github.com/Leowuqunqun/ai-butler/blob/main/packages/seam-channel/README.md)，
想接别的 IM（Telegram、飞书…）看那份文档。

---

## 微信通道能做什么、不能做什么

**能发**：文本、文件（≤100MB）、**图片**（`.png` / `.jpg` / `.gif` / `.webp` / `.heic` …
按图片发，对面看到的是图片，不是一个附件）、**视频**（`.mp4` / `.mov` —— 手机拍的就是这两种）。
认不出来的格式一律**当文件发**：当文件一定送得到，当图片/视频发还得看对面认不认这个格式。
**能收**：文本、语音（服务端已转写）、图片、文件、视频。

**发不了语音** —— 不是没写，是微信的 `voice_item` 要求音频是 **SILK** 格式：
塞个 wav/mp3 进去，对面只会看到一个点不开的气泡。要做就得先有 SILK 编码器，
所以这里如实不做（收语音照样能用：服务端已经把话转成文字了）。

图片、视频和文件走的是同一套上传三步，但 **`aes_key` 的编码不一样**（只有图片是
`base64(16 字节原始 key)`，别的都是 `base64(hex(key))`），而且图片还有第二个
key 来源 —— 这是协议里最容易写混的一处，细节见
[`docs/protocol.md` 第 5 节](docs/protocol.md)，测试里也有两条用例专门钉它。

实在读不出内容的消息（下载凭据过期、群聊等）会明确告诉你"这条我读不了"，而不是装死。

收到附件后的流程是：**解密 → 落到 `state/inbox/` → 把本机路径告诉 agent**。
也就是说 agent 拿到的是一个普通文件路径，它爱怎么读就怎么读。
桥不替它做理解，也不把二进制塞进提示词——这条边界是刻意的：
换模型、换 agent 都不影响附件能不能用。

附件是**串行下载**的（在干活循环里，不在收信循环里），所以下大文件的时候
你照样能发新消息，不会"失联"。

### 关于「引用回复」

**iLink 协议没有出站引用能力**——消息连 id 都没有，无从"引用某一条"。
这一点是照着腾讯官方参考实现 `@tencent-weixin/openclaw-weixin` 确认的：
它的出站结构只有 `{type:1, text_item:{text}}` + `context_token` + `run_id`，
没有任何引用字段；协议里唯一存在的引用（`ref_msg`）是**入站**的，
而且官方自己也只是把它压成一行纯文本给模型。

（入站那个 `ref_msg` 我们压成一行纯文本之后走 `InboundMessage.quote` 交给内核 ——
和 Telegram 的 `reply_to_message` 汇到同一个字段上。**不并进正文**，理由见
[`seam-channel`](https://github.com/Leowuqunqun/ai-butler/tree/main/packages/seam-channel) 的契约注释：引用不能参与路由。）

**只引用、没说话也算内容**：你引用某句话、自己一个字没打（关了 `media` 时引用着一张图
也是这样），管家会把引用交上去照办 —— 而不是回你一句"这条读不了"。
真的什么都没有（没文字、没附件、也没引用）时才会回执，而且那句话现在说的是实情：
"这条消息里没有我能读的内容"。

**发文件挂不了引用**：iLink 发文件没有"引用某条消息"这个能力（协议里连消息 id 都没有），
所以内核就算传了 `quote` 过来，这边也只能如实忽略 —— 不会假装支持。

⚠️ **已知缺口**：`bridge.mjs`（旧命令行入口，`wechat-agent-bridge` 那条命令）仍然是
"收信 → 跑 agent → 回话"的单体，它**还没有**把 `ref_msg` 交给后端。
之所以不补：这条路按计划要整个搬进内核（它和插件共用底下那批模块，只是为了兼容
早期用法还留着），在它身上再长一份格式化逻辑是反着走。用 `butler run` 那条路没有这个问题。

所以本项目用同一种办法：**每条回复开头带一行你的原问题**。

```
↩ 把简历发给我
发你了，两个文件在下面。
```

连发多条时，一眼就知道哪条回复对应哪个问题。不想要就设 `quoteReply: false`。

---

## 两个必须知道的坑

这两个都是实测踩出来的，写在这里省你几个小时。

### 坑 1：`DSH_HOME` 必须和 `dsh web` 隔离

如果桥和 `dsh web`（GUI）用同一个 `DSH_HOME`，而工作目录又一样，
两边会落进**同一个 sessions 目录**。GUI 会给它"看过"的会话挂上写锁，
桥一续接就报：

```
session "session-xxx" is already owned by an active write handle
```

所以本项目默认给桥一个私有的 `DSH_HOME`（`<项目>/dsh-home`），
会话仓库与 GUI 完全隔离。**不要**把它指回 `~/.dsh`。

### 坑 2：`sandbox-exec` 不允许嵌套

如果你的桥进程本身跑在某个沙箱里（典型场景：在另一个 agent 会话里
`nohup` 启的），macOS 的 Seatbelt **不允许嵌套启动**，于是 agent 的每条
bash 都会以这个错失败：

```
sandbox-exec: sandbox_apply: Operation not permitted
```

agent 就变成"只能看不能动"。两种解法：

1. **推荐**：把桥装成 launchd 服务（见上文），进程由系统直接拉起，
   不在任何沙箱内，然后保留默认沙箱配置。
2. **临时**：在 patch 文件里把 bash 执行器换成不套沙箱的实现
   （`examples/dsh.patch.yml` 的 ③-b 有现成几行，照抄即可）。
   **代价是 agent 的 shell 命令不再受文件写入边界约束。**

### 坑 3：`--patch` 必须写在 `--json` 之前

```bash
dsh --profile headless --patch f.yml --json "..."   # ✅
dsh --profile headless --json --patch f.yml "..."   # ❌ unknown option '--patch'
```

---

## 安全

**先把这几条读完再放到公网机器上。**

- **`state/token.json` 等同你的微信登录态。** 泄露 = 把号交出去。
  它已经在 `.gitignore` 里，**永远不要提交、不要贴给别人**。
- **`allowFrom` 是唯一的门。** 白名单为空时，**第一个给 bot 发消息的人就能拿走控制权**。
  这在你自己电脑上调试时很方便，但如果这个 bot 挂在什么公共环境里，请先手工把
  `allowFrom` 填好。
- **agent 会以你的身份执行命令。** 这条桥给 agent 的是"你这台机器的 shell"。
  微信白名单是唯一的边界——想清楚你愿意让它干什么。
- **扫码页只监听 `127.0.0.1`**，不对外暴露。

---

## 测试

```bash
pnpm test      # 在仓库根目录跑全部包
# 或只跑这个包：
cd packages/channel-wechat && node --test test/*.mjs
```

**119 个用例，全部离线**——不连网、不需要微信账号、**不会真的发消息**：

- `test/smoke.mjs`（24 个）：文本处理、配置合并、白名单、认主、排队、发附件、
  引用前缀、会话锁重试、错误转述，以及**真的把收信循环跑一遍**（含 `stop()` 立刻返回）
- `test/media.mjs`（24 个）：`aes_key` 的两种编码、图片的第二个 key 来源、
  AES 加解密往返、CDN 地址拼接、媒体优先级、路径穿越防护、下载失败的降级
- `test/login.mjs`（10 个）：**第一次启动自己登录**——真起一个本地扫码页（真 HTTP）、
  喂一个假客户端，于是"码真的进了页面""浏览器真的被指向那个地址""登录态真的落了盘"
  全都能验；三个平台各自该用哪条命令打开浏览器，也钉着
- `test/plugin.mjs`（30 个）：cordis 插件面——加载、配置默认值、幂等 start、
  收信与过滤、游标持久化、附件下载落盘、失败降级、发文本/文件、正在输入、卸载自停
- `test/home.mjs`（12 个）：数据目录的四级优先级、`--home` 的三种写法、
  安装态（路径含 `node_modules`）必须改走用户目录
- `test/cli.mjs`（9 个）：**真的起子进程跑 CLI**——覆盖"全局 flag 写在子命令前面
  会不会把子命令派发带偏"这类只有端到端才抓得到的问题
- `test/plugin-types.mjs`（6 个）：**防漂移**——手写的 `plugin.d.ts` 跟运行时成员对账
- `test/ilink.mjs`（4 个）：长轮询能被立刻掐断（停机不干等 40 秒）、超时行为不变

另外 `pnpm typecheck` 会编译 [`test/fixtures/consumer.ts`](https://github.com/Leowuqunqun/ai-butler/blob/main/packages/channel-wechat/test/fixtures/consumer.ts)——
一个模拟"核心层怎么用这个通道"的**消费方探针**（只做类型检查，不运行）。
运行时测试查不出手写 `.d.ts` 的类型错误，得靠它：
写它的第一版就抓到 `static Config` 被声明成 `unknown`，
那会让 `ctx.plugin(WechatChannel, …)` 直接编译不过。

媒体那几个用例是**真的在跑 AES**：测试里自己加密一段内容当作"CDN 上的密文"，
再让被测代码去下载解密，比对原文。所以两种 `aes_key` 编码搞反了会被立刻抓住。

插件那几个用例是**真的把通道跑起来**：假 ilink 客户端的 `getUpdates`
会像真的一样挂住（而不是立刻返回空，那样会变成忙等），
所以幂等、退避、中断、卸载这些时序问题都能被测出来。

---

## 协议笔记

iLink Bot API 没有公开文档，本项目的行为是照着腾讯官方参考实现
`@tencent-weixin/openclaw-weixin` 加上实测整理出来的。
踩到的坑都记在 [`docs/protocol.md`](docs/protocol.md)，
包括：

- 为什么二维码只有约 90 秒寿命（文档说 5 分钟，实测不准）
- 为什么**必须**校验响应体里的 `ret`/`errcode`（HTTP 200 不代表成功）
- **发**文件的 AES-128-ECB + `aes_key` 编码陷阱
- **收**图片/文件的加密 CDN 下载：`aes_key` 的**两种编码**，
  以及图片那个**优先于 `media.aes_key`** 的第二个 key 来源（漏了就解出乱码）
- 语音转写、`typing_ticket`、`context_token` 的正确用法

---

## License

MIT
