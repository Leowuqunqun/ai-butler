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
- **发文件**：agent 在回复里写一行 `[[file:/绝对/路径|配文]]`，桥自动上传并发送（AES-128-ECB 加密上传到微信 CDN）
- **可插拔 agent 后端**：DSH / 任意命令行程序 / 自己写的模块
- **收干分开**：收消息的循环从不被 agent 阻塞，所以你随时能发下一条；忙的时候它会先回一句"前面还有 N 条"
- **引用原问题**：协议没有原生引用能力（见下），所以每条回复开头会带一行 `↩ 你的原问题`，连发多条时不会串味
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

```
node src/cli.mjs qr                 起扫码页登录（--port 换端口）
node src/cli.mjs login              终端模式登录（不断打印二维码文件路径）
node src/cli.mjs run                常驻：收消息 → agent → 回话
node src/cli.mjs status             看配置 / 绑定 / 后端 / 最近流水
node src/cli.mjs send "文本"        主动发一条（--to <userId> 指定收件人）
node src/cli.mjs sendfile <路径> [配文]
node src/cli.mjs backends           列出内置 agent 后端
node src/cli.mjs audit [n]          看最近 n 条收发流水
node src/cli.mjs config             打印合并后的配置
```

---

## 配置

配置写在 `state/config.json`（首次运行自动生成）。所有字段都有默认值，
**只需要写你想改的**。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | 项目目录 | agent 在哪个目录干活（它看到的根） |
| `allowFrom` | `[]` | 只服务这些微信 userId。**空 = 谁先发谁是主人** |
| `bindFirstSender` | `true` | 白名单为空时，第一条来信自动认主并落盘 |
| `maxReplyChars` | `1200` | 单条消息上限，超出自动分条并加 `(1/N)` 前缀 |
| `agentTimeoutMs` | `300000` | 一次 agent 调用的硬超时，超了掐断并如实告知 |
| `typing` | `true` | 发"正在输入" |
| `quoteReply` | `true` | 回复开头带一行 `↩ 原问题` |
| `queueAck` | `true` | 排队时先回一句"前面还有 N 条" |
| `progressIntervalMs` | `40000` | 处理中的进度提示间隔，0 = 关 |
| `maxQueue` | `20` | 积压上限，超了拒收 |
| `agent.backend` | `"echo"` | `echo` / `exec` / `dsh` / 模块路径 |

---

## 微信通道能做什么、不能做什么

**能发**：文本、文件（≤100MB）。
**能收**：文本、语音（服务端已转写）。群聊、图片、视频、文件**暂未处理**——
收到读不出文本的消息会明确告诉你"这条我读不了"，而不是装死。

### 关于「引用回复」

**iLink 协议没有出站引用能力**——消息连 id 都没有，无从"引用某一条"。
这一点是照着腾讯官方参考实现 `@tencent-weixin/openclaw-weixin` 确认的：
它的出站结构只有 `{type:1, text_item:{text}}` + `context_token` + `run_id`，
没有任何引用字段；协议里唯一存在的引用（`ref_msg`）是**入站**的，
而且官方自己也只是把它压成一行纯文本给模型。

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
npm test
```

19 个用例，覆盖文本处理、配置合并、白名单、认主、排队、附件、引用前缀、
会话锁重试、错误转述。用的是假通道和桩后端，**跑测试不会真的发微信消息**。

---

## 协议笔记

iLink Bot API 没有公开文档，本项目的行为是照着两个参考实现（腾讯官方的
`@tencent-weixin/openclaw-weixin`、以及 `@shgroup/dsh-serenity-hooks`）
加上实测整理出来的。踩到的坑都记在 [`docs/protocol.md`](docs/protocol.md)，
包括：

- 为什么二维码只有约 90 秒寿命（文档说 5 分钟，实测不准）
- 为什么**必须**校验响应体里的 `ret`/`errcode`（HTTP 200 不代表成功）
- 发文件的 AES-128-ECB + `aes_key` 编码陷阱
- 语音转写、`typing_ticket`、`context_token` 的正确用法

---

## License

MIT
