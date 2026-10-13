# @butler/dsh-plugin

把**微信**接进 [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)：手机上说的话进 DSH 的会话，
DSH 干完活，回复回到微信。

装上之后长这样：

```
微信（你） ──"帮我把 README 的错字改了"──▶  DSH 里的一个会话（在你指定的目录里干活）
     ▲                                              │
     └──────────── 回复 / "正在输入" ◀──────────────┘
```

干活的是 **DSH 自己**（同一个 agent、同一套工具、同一份会话历史），
这个插件只做两件事：把微信这条通道挂进来、把消息接进会话再把回复送回去。
所以微信里说的活，在 DSH 的界面里也能看见、也能接着改。

---

## 装

**最省事的一条路** —— 下整包、解开、跑里面那条命令（`web` 换成 `headless` 也行）：

```bash
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/download/v0.1.0/butler-dsh-plugin-0.1.0.tar.gz | tar xz
cd butler-dsh-plugin-0.1.0 && bash install.sh
```

等价的手工一条（不想要 `install.sh` 就自己敲；`file:` 后面指到**解开的那个目录**）：

```bash
dsh plugin --profile web add "file:$(pwd)/plugin"
```

从仓库里装是同一件事，只是路径换成仓库里的包目录：

```bash
dsh plugin --profile web add file:/绝对路径/packages/dsh-plugin
```

装完重启 profile 就生效。装到哪个 profile 就服务哪个 profile
（`web` = 你在浏览器里用的那个，`headless` = 命令行跑一次就退的那个，都行 ——
这个插件只依赖两个 profile 都有的服务）。

第一次启动它会自己起一个**扫码页**（只监听 `127.0.0.1`），用微信扫一下就登上了。
登录态存在 `~/.dsh/butler-wechat/`，下次不用再扫。

> 想先不进微信、只确认装好了？配置里写 `autostart: false`，插件会挂上通道但不开始收信。

## 配置

在 profile 的 `cordis.patch.yml` 里改（一个字段都不写 = 全用默认值）：

```yaml
- id: butler-wechat
  name: '@butler/dsh-plugin'
  config:
    cwd: /Users/you/code          # 微信里的活在哪干（会话的工作目录）。默认 = DSH 进程的当前目录
    owner: ['<你的 userId>']       # 认主：只服务这些人。默认空 = 第一个说话的人认主，并记住
    home: ~/.dsh/butler-wechat    # 登录态与状态目录
    typing: true                  # 发"正在输入"
    quoteReply: true              # 回复时引用原消息
    qrPage: true                  # 没有登录态时自己起扫码页
    qrPort: 8099                  # 扫码页端口（被占用会自动往后找）
    autostart: true               # 挂上就开始收信
```

## 几件你该知道的事

**认主是第一道门。** 这个插件登的是**你自己的微信号**，所以任何一个给你发消息的人
都可能说话。默认行为是"第一个说话的人成为主人"（跟你扫码的顺序一致），
之后别人发来的消息**一个字都不回、也不会去跑 agent**。想在装之前就定死，写 `owner:`。

**一个人一个会话。** 会话 id 由对方 userId 决定（`wechat-<16位>`），
所以对话是连续的 —— "刚才那个改成蓝色"能找到"刚才那个"；
配上 DSH 的会话持久化，重启也接得上。

**同一个人连发多条不会打架。** 一个人的消息排队串行跑；
两个不同的人各排各的队，互不阻塞。

**一轮挂了会告诉你。** 模型报错、工具炸了、会话没跑完 —— 微信那头会收到一句
"我这边出错了：…"，而不是对着空气等。通道不会因为一轮失败停摆。

**附件会落到本机。** 图片/文件由通道下载后，把**本机路径**交给 agent（不是把内容塞进提示词），
所以 agent 可以按需去读。

## 它不做什么（说清楚）

- **不带审批**：DSH 的审批请求不会转到微信，按 profile 自己的审批策略走。
  （想的话下个版本可以做 `approval/request` → 微信问一句"允许吗"。）
- **不能从微信主动推消息**：只有"你说话 → 它回话"和握手时的开场白。
- **不发文件出去**：回复只有文本，agent 产出的文件不会自动发到微信。
- **Windows 没验过**（开发机是 macOS）。

## 原理（给要改它的人）

```
packages/dsh-plugin/
  cordis.patch.yml   往 DSH 的组合里插一行 —— 就一行
  src/plugin.mjs     接线：挂微信通道、装 model selection、订阅消息、开收信
  src/bridge.mjs     业务：认主、排队、把消息变成提示词、把回复送回微信
  src/turn.mjs       跟 DSH 打交道：找会话 → followup → 等跑完 → 取正文
  test/              37 个测试，全离线（假通道 / 假 DSH / 真 cordis + 真通道类）
```

- **微信协议**不在这里，在 [`wechat-agent-bridge`](https://github.com/Leowuqunqun/ai-butler/tree/main/packages/channel-wechat)
  （发行包里是 `channel/`）：扫码登录、长轮询收信、附件下载、引用回复都是它的活，它自己有 134 个测试。
- **不 import 任何 DSH 包**：`createUserMessage` 这种"平凡包装"照 `@deepseek-ai/dsh-llm`
  的实现自己构造一份（代码里注了出处）。少一个 import，就少一条"装不上"的路。
- **只依赖 `dsh-base` 的服务**（`agents` / `sessions` / `agentDefaultModel`），
  所以 web 和 headless 两个 profile 都能挂。
- 跑一轮的顺序（找活会话 → 冷载 → 新建，`followup` → `whenIdle` → 从事件里取正文）
  对着 DSH 自己的 headless app 抄的；唯一不同的是用 `ctx.on('session/event')`
  而不是已经废弃的 `eventAt()`。

## 验收

```bash
node --test test/*.mjs                        # ① 离线：逻辑层（37 个测试，一条命令）
bash scripts/dsh-probe/run.sh                 # ② 真机：接线层（发行包里是 bash probe/run.sh）
```

那 37 个测试跑的是"逻辑对不对"：认主、排队、提示词拼装、回复切分、会话 id 稳定。

**但逻辑对不等于接线对** —— 我们调 DSH 的那几行（`agents.create/resume/get`、
`followup`、`whenIdle`、`session/event`、`installModelSelection`）到底是不是这个语义，
只有真跑一次才知道。所以有第二个：[`scripts/dsh-probe/`](https://github.com/Leowuqunqun/ai-butler/tree/main/packages/dsh-plugin/scripts/dsh-probe)。
它在一个**临时 DSH home** 里建 profile（不碰你正在用的 `~/.dsh`），
把插件和一个探针一起装进去，模型指到本机假端点（不出网、不花钱），然后：

- 第一遍（会话存储是空的）→ 断言走 `create`，两轮真跑完，回复真的回到"微信"那头；
- 第二遍（存储留着）→ 断言走 `resume` 接回同一份会话，一个新会话都没建；
- 两边对账：假模型的服务端日志里必须有我们发出去的那两句。

**它抓出过两个真 bug**，都不是离线测试能发现的：

1. `session event "agent/inbox/spliced" carries non-JSON-serializable data` ——
   消息里 `source.messageId` 在没值时是 `undefined`，而 DSH 写事件前要做一次
   **无损 JSON 快照**，`undefined` 值的键 stringify 之后就没了，整条被拒收。
   现在在 `userMessage()` 入口统一清掉（`test/turn.mjs` 里有对应的回归测试）。
2. `LlmError: configurable provider "amazon-bedrock" is already declared` ——
   探针一开始想 `insert` 一行新的 pi-ai，而模板里**本来就有**一行；
   而且 DSH 的 `config` 是**整体替换**不是深合并。现在改成改写模板已有那一行。
