# @butler/cli

命令行入口。**把配置变成一个真的跑起来的管家。**

> 你是**要给一个不懂技术的人装上**（或者自己第一次装）？先看
> [从零到「用微信遥控这台电脑」：三步](https://github.com/Leowuqunqun/ai-butler/blob/main/docs/GETTING-STARTED.md) —— 那份是给用户看的，
> 这一份是给要改它的人看的。

```bash
butler init                         # 第一次用：把配置写好（你什么都不用填）
butler run                          # 读 ~/.butler/config.json，上线
butler run --again                  # 重新问一遍模型 key / 通道 token（想换一把的时候）
butler init --node                  # 第二台机器：写"被遥控"的那份配置
butler init --im telegram           # 换成用 Telegram 收信（默认微信；一次只能上一个）
butler node                         # 当节点：把这台电脑的 agent 摊给中枢用
butler doctor                       # 自检：查"为什么没反应"
butler run --config my.json --patch b.json   # 换一份配置、叠补丁
butler --help
```

**三条命令对应两台机器**：

| 命令 | 哪台机器用 | 配置里要有 |
| --- | --- | --- |
| `butler init` + `butler run` | **收微信的那台**（中枢） | channel + agent + core（+ link，默认就带着） |
| `butler init --node` + `butler node` | **被遥控的那台**（节点） | agent + `@butler/link-lan/node` |

## 换一个 IM 收信：只改配置里那一行

```bash
butler init --im telegram    # 或者 --im wechat（默认）
butler doctor                # 四个能力位照旧；通道自己的自检也会出现在里面
```

**一次只能上一个**：`ctx.channel` 只有一个位置（seam 的注释里写着，加载第二个
通道实现会直接抛错）。所以这不是多选，是"你打算用哪个"。

`--im telegram` 这条路**也是一个网页**：`butler run` 会先起引导页问你要 bot token
（去哪儿拿写着、粘一下就行），跟模型 key 一样，不用你打开配置文件。它存在的
意义首先是**证明这个位置真的可换** —— 接一个通道进来只动了配置里那一行 `name`，
核心层和 doctor 一个字没改
（`test/switch-im.mjs` 里有两条断言专门钉这件事，其中一条是"`packages/core/src`
里不许出现任何通道包的名字"）。Telegram 通道自己的说明见
[`packages/channel-telegram`](https://github.com/Leowuqunqun/ai-butler/tree/main/packages/channel-telegram)。

## `butler init` —— 第一次用，你什么都不用填

```bash
butler init
```

```
把家安好了：

  写好了  ~/.butler/config.json
  写好了  ~/.butler/dsh.patch.yml

这台是「收微信的那台」。接下来：

  butler run

第一次它会做两件事，都不用你改任何文件：
  1. 开一个网页，让你把模型 key 贴进去（AI 要靠它思考）
  2. 再出一个二维码，用手机微信扫一下
```

**为什么这条命令存在**：这个产品要卖给完全不懂技术的人，而在他动手之前，
我们以前要求他找到 `~/.butler/`、新建一个 JSON、把四个插件名字拼对、把路径填成绝对路径。
**那一步就是终点** —— 拼错一个字符的表现是"装不上"，而且看不出为什么。

三条规矩：

- **配置由程序写，不由用户写。** `init` 一次把两份都写好，四个插件名都是真的
  （写错了 `butler doctor` 会当场红 —— 我们真写错过一次）。
- **只写缺的，绝不覆盖。** 第二次跑会说"已经有了，没动"。
  用户可能已经加过设备、改过目录，一次"初始化"把它抹掉是不可接受的。
- **它只写文件，不联网、不启动。** `run` 和 `node` 都**不会**自动写配置 ——
  缺配置时它们给一行能直接抄的命令（`butler init …`），仅此而已。

生成的两份文件长这样：

| 文件 | 里面是什么 | 用户要动它吗 |
| --- | --- | --- |
| `~/.butler/config.json` | 装哪几个插件（通道 / agent / 内核 / 链路） | **不用** |
| `~/.butler/dsh.patch.yml` | 给 agent 的补丁：模型通道 + **人格** | **不用**（模型可以是默认的 DeepSeek，key 走引导页） |

> 那份补丁里的"人格"是**产品行为**，不是示例：输出原样进对话所以禁止 Markdown、
> 发文件走 `[[file:…]]` 那一行、不许拿截图去点界面、批准策略是 `ask`
> （问进对话里，**到点没人答就是不许**）。
> 它随 `@butler/agent-dsh` 一起发布，`init` 照抄一份到用户家里。

**模型 key 不在这两份文件里** —— 它走 DSH 自己的凭据库。所以这两份文件里
没有一个字节是密钥，而用户也**不需要知道那个文件在哪**：`butler run` 会问一次。

---

## `butler run` —— 第一次要过两道门

```bash
butler run
```

```
装载：
  ✓  channel  wechat-agent-bridge/plugin
  ✓  agent  @butler/agent-dsh
  ✓  core  @butler/core
  ✓  link  @butler/link-lan
模型 key：还没有，起了一个本地页面让你贴
  http://127.0.0.1:8137/s/2f1c…/
（页面已经自动打开；在手机上复制、到这台电脑的浏览器里粘贴也行）
模型 key：存好了 ✓（下次不用再贴）

上线了。用微信给它发句话试试。（Ctrl-C 退出）
```

两道门，都是为了不让人去手写文件：

| 门 | 问什么 | 为什么不能靠命令行问 |
| --- | --- | --- |
| ① 模型 key | 一个输入框：贴 key | 命令行里"贴 key"每一步都在劝退（shell 会不会吃掉、贴对没有、错了怎么改），而且**没法告诉他去哪儿拿** |
| ② 微信登录 | 一个会自动换码的网页 | 二维码是一张**活 90 秒**的图，静态图片必然过期 |

三条约束（都在代码里钉着）：

- **只监听 `127.0.0.1`**，而且地址里带一个**一次性随机串**（`/s/<32 位>/`）：
  别的网页即使猜到端口也发不出能生效的请求。没有那一串一律 404。
- **key 只写进本机**：`<dsh-home>/.credentials.yaml`，权限 `0600`
  （DSH 读到组可读或人人可读的凭据文件会**拒绝启动**，所以这不是讲究）。
  它不进 URL、不进日志、不经过任何网络。
- **能跳过，但会说实话**：跳过之后 `butler doctor` 会说"模型 key 还没有"，
  并且指出下一步是 `butler run`。不填也能先把微信登上。

你已经有 key 在 **dsh 自己**的凭据库里（`~/.dsh/.credentials.yaml`）？
页面上会多一个按钮「用我在 dsh 里已有的那把」—— 一键复制过来，不用重新找。

## 配置文件（JSON）

```json
{
  "plugins": [
    { "id": "channel", "name": "wechat-agent-bridge/plugin", "config": { } },
    { "id": "agent",   "name": "@butler/agent-dsh", "config": { "patchFile": "…", "home": "…" } },
    { "id": "core",    "name": "@butler/core", "config": { "workspace": "/你要它管的目录" } }
  ]
}
```

| 字段 | 意思 |
| --- | --- |
| `id` | 行的地址。patch 靠它找到要覆盖哪一行 |
| `name` | 模块名，或路径 |
| `config` | 原样交给插件。**patch 覆盖它是整体替换，不是深合并** |
| `disabled` | 关掉这一行，默认 `false` |

**三行缺一不可**：`channel` 负责收发，`agent` 负责干活，`core` 把两头接起来。
少一行 `butler run` 会拦下来，并且把缺的那行长什么样直接打给你 —— 不用去翻文档。

### `name` 从哪儿找

| 写法 | 从哪儿解析 | 什么时候用 |
| --- | --- | --- |
| `./x` `../x` `/x` | **配置文件所在目录** | 指向你自己的脚本 |
| `@butler/core` | **应用自己的目录** | 插件随应用安装，就像任何应用加载自己的依赖 |

## patch

补丁文件跟主配置**同一个格式**，`--patch` 可以给多次，**后写的赢**：

```json
{ "plugins": [ { "id": "agent", "config": { "timeoutMs": 900000 } } ] }
```

- `id` 已存在 → 覆盖。**只覆盖你写了的字段**
- `id` 不存在 → 追加
- **`config` 一旦写了就是整体替换**，不深合并 —— 所以默认值要在 base 里写全，
  别指望"我只补一个字段就行"。这条最容易踩，专门有测试钉着。

### 跟 dsh 的 patch 差在哪（说清楚，免得当成跑偏）

**语义照搬，语法简化。** 保留的是 dsh 那几条真正要紧的：行由 `id` 寻址、
`config` 整体替换、`disabled`、行的顺序不承载语义、base 作为一次叠加施加在空根上。

简化掉的是文件语法，都有理由：

- **用 JSON 不用 YAML**：少一个依赖。而且这个文件的第一作者是引导页/GUI，
  它本来就要机器读写。
- **不要 `- insert:` 外壳**：现在只有"插入"一种操作，外壳没带来任何信息。
- **`disabled` 只收 `true`/`false`**，不支持 dsh 的 `!!js "表达式"`：
  那等于在配置文件里 `eval` 任意代码。对一个"给完全不懂技术的人用"的产品来说，
  这是纯粹的脚下枪，代价大于收益。

## 两条实测踩出来的坑（都写在代码注释里了）

**① 常驻必须自己 hold 住事件循环。** 一个还没 resolve 的 Promise 不算"活"，
`process.once('SIGINT')` 也不算 —— 没有别的 handle 时 Node 直接退出。
现象是"打印完『上线了』就自己退了"，看起来像启动失败。真实场景里通道有自己的
轮询 handle 撑着，所以平时不显形，但"看起来在线"和"真的在线"是两回事。

**② 先装好信号处理器，再宣布"上线了"。** 反过来有一个真实的竞态窗口：
用户一看到"上线了"就按 Ctrl-C，而那一刻处理器还没装上，进程被默认动作砍死，
内核的收尾不会跑、微信那边的连接不会体面断开。窗口很窄，但测试里稳定复现过。

顺带第三条，是 `bin` 特有的：`butler` 这个命令是**符号链接**，主入口判断必须比
realpath。直接拿 `process.argv[1]` 跟 `import.meta.url` 比的话永远不相等，
**命令一行都不会跑**，还静默退出 0。

## 设计：装不上不算致命

`boot()` 遇到装不上的插件**不抛**，收进 `failures` 里接着装下一个。
因为两个调用方要的东西不一样：`doctor` 要的是"哪几行有问题"（一行坏掉不能让它
什么都报不出来），`run` 要的是"到底能不能上线"。判断留给调用方，`boot()` 只如实汇报。

## 关于 `has()`

`has(name)` 回答"某个服务位在不在"（`ctx.channel` / `ctx.agent` / `ctx.core`）。

它是**取值判断**，不是 `name in ctx` —— `in` 在插件卸载之后**依然是 true**
（cordis 把属性槽留着了），拿它判断会在卸载后给出过期答案。实测过，
测试里专门钉着，别换回去。

也没有 `services: string[]`：cordis **没有**暴露"列出所有已注册服务"的公开接口
（`Object.keys(ctx)` 只有内核自己的那几个字段，`ctx.reflect.store` 也不是可枚举的
服务表）。所以只提供"问一个具体的名字"这个原语，不假装能枚举。

---

## `butler doctor` —— 出问题的时候跑它

```bash
butler doctor
```

这个产品最坏的用户体验不是报错，是**没反应**。"我发了消息，它不理我" ——
用户没有任何线索。所以 doctor 的目标不是"打印诊断信息"，是**直接告诉他该干什么**：

```

AI 管家自检

环境
  ✓  Node 版本               v24.14.0（需要 20 以上）

配置
  ✓  实际读的文件            /Users/me/.butler/config.json

装载
  ✓  channel  wechat-agent-bridge/plugin
  ✓  agent  @butler/agent-dsh
  ✓  core  @butler/core

能力位
  ✓  ctx.channel  收发消息的通道
  ✓  ctx.agent  干活的大脑
  ✓  ctx.core  把两头接起来的

自检
  ✓  数据目录                /Users/me/.butler
  ✗  微信登录态              还没登录过这台机器
      → 启动时会打印二维码，用微信扫一下就好
  ✓  dsh 可执行文件          /usr/local/bin/dsh
  ✗  dsh patch 文件          /Users/me/.butler/dsh.yml 不存在
      → 这个文件里写着模型通道和人格，缺了它干不了活；把配置里的 patchFile 指对
  ✓  工作目录                /Users/me/pp（agent 就在这儿干活）
  ✓  谁能指挥它              已认主（第一个跟它说话的人）。别人发消息它会一声不吭
  ✓  管家自己找得到 butler 吗  找得到：/Users/me/.butler/prefix/bin/butler

2 项自检没过。按下面标 ✗ 的那几条改，改完再跑一次 doctor。
```

退出码有意义：`0` = 可以跑，非 0 = 还有要修的。脚本里可以直接 `butler doctor || exit`。

### 它查什么

| 段 | 查什么 | 谁报的 |
| --- | --- | --- |
| 环境 | Node 版本够不够 | cli |
| 配置 | 读了哪几个文件、哪一行装不上、为什么 | `boot()` |
| 装载 | 每一行装上了没有、哪些被关掉了 | `boot()` |
| 能力位 | 三条脊梁（channel / agent / core）在不在 | `boot().has()` |
| 自检 | 每一层自己的前置条件 | 各实现的可选 `check()` |

### 三条设计约束

**① 永远不抛错。** 用户跑到 doctor 这一步，说明已经"没反应"了 —— 这时候最不能
发生的就是"诊断工具自己也炸了"。配置读不了、JSON 是坏的、插件自检自己抛异常，
全部收成一条带人话的检查项。有测试专门把一切都弄坏来验这条。

**② 没有任何副作用。** 它**只装载，不启动** —— 不连微信、不跑 agent、不写状态。
有测试断言 `core.start()` 没被调用过。

**③ 每一条没过的检查都必须带 `fix`。** 那句话决定用户能不能自己解决，
是这个工具存在的全部理由。只说 `ok: false` 的检查等于没做。

### 为什么自检要问插件自己

`check?()` 是 seam 上的**可选**约定（见 [seam-channel](https://github.com/Leowuqunqun/ai-butler/blob/main/packages/seam-channel/README.md) /
[seam-agent](https://github.com/Leowuqunqun/ai-butler/blob/main/packages/seam-agent/README.md)）。只有实现自己知道该验什么：微信通道知道
登录态存在哪，dsh 知道它要哪个二进制和哪个 patch 文件，exec 知道 `argv[0]` 在不在。
让 doctor 从外面猜，就得把每个实现的配置 schema 抄一份 —— 维护灾难，也是层次错误。

不实现 `check()` 的插件**不算错**，doctor 直接跳过。

## 凭据都在哪（以及为什么都不在 `config.json` 里）

| 东西 | 落在哪 | 权限 |
| --- | --- | --- |
| 模型 key | `<dsh-home>/.credentials.yaml`（DSH 自己的凭据库） | 0600 |
| 微信登录态 | `~/.butler/state/token.json` | 0600 那套 |
| 通道自己的凭据（Telegram 的 bot token） | `~/.butler/state/secrets.json` | **0600** |
| 收件箱 | `~/.butler/inbox/<日期>/` | 普通 |

**为什么不写进 `config.json`**：那份文件是**引导用户去读**的（doctor 会把它的路径
打出来），他也很可能截图、贴给别人看。凭据进去等于鼓励泄露。

**谁覆盖谁**（`run` 和 `doctor` 同一套规则，不许互相打脸）：

1. **配置里手写的**（`config.botToken` 非空）—— 高级用户的那份，我们一个字不改
2. **引导页存过的** —— 直接填进那一行，不再打扰他
3. 都没有 —— `butler run` 起页面问他一次；`doctor` 只读，说"还没有填"

自检里「Telegram 登录态」那一条会**真去问一次**（免费、5 秒上限）：token 被作废了当场判 ✗
并给出下面这条命令；网断则说"这次没查"、不报红。

**想换一把**（key 过期了、token 在 @BotFather 那边 `/revoke` 过了）：

```bash
butler run --again
```

规则只有一条：**`--again` 是"再问一次"，不是"清空重来"** —— 他不填（或者把页面
关了），原来那把**照样能用**；填了才顶掉。`doctor` 说「模型 key」✗ 时，给出的
出路就是这一行。⚠️ 如果 key 来自**启动环境变量**（`doctor` 会说"来自启动环境里的
XXX"），那往文件里存是不生效的 —— 页面会明确告诉你先把那个环境变量去掉。

顺带一条：这一关必须在**装进容器之前**跑完 —— 插件的 `config` 是构造时读进去的，
装上了再改那个对象是不生效的（`boot()` 因此多了一个 `rows` 参数）。

## `butler autostart` —— 让它开机自己起来

装完、扫码、把终端窗口一关，管家就没了 —— 这是小白最容易误会的一件事
（他以为"装好了"等于"一直在"）。所以给他一条命令，把这件事交给操作系统：

```sh
butler autostart on         # 装上去（macOS launchd / Linux systemd --user）
butler autostart status     # 现在什么状态
butler autostart off        # 摘掉
butler autostart --dry-run  # 只说要干什么，一个字节都不写
```

单元文件里有两个**必须**在的东西，都是踩出来的：

- **当前这份 PATH** —— 登录时系统给的 PATH 是最小集（`/usr/bin:/bin:…`），里面没有 `dsh`，
  而 `dsh` 正是管家思考要用的东西。写进单元文件才是"登录后也能干活"。
- **`--no-open`** —— 否则每次登录都弹一个浏览器页面出来，比不做还烦。

Windows 上它**如实说"还没做"**：写一个你以为生效、其实跑不起来的注册表项，比不做更坏。

测试的纪律：单元文件的内容是纯函数算出来的（离线断言 plist / unit 的每个关键字段），
"跑命令"那一步注入假 runner —— **测试不碰真的 `launchctl`，也不碰真家目录**。
命令行分派和 `--dry-run 真的什么都不写`在 `test/cli.mjs` 里真 spawn 一个进程验。

## `butler node` —— 被遥控的那台机器

跟 `butler run` 是**同一条流水线**（读配置 → 装容器 → 等退出），只差两件事：
要的是 `ctx.node` 而不是 `ctx.core`，以及下面那道安全闸。

```bash
butler node --config ~/.butler/node.json
```

```
节点「家里那台」上线了。
  监听：0.0.0.0:41338

  把这台电脑交给管家 —— 在收微信的那台机器上，用微信发下面这一行
  （可以复制，别手打）：

      配对 192.168.1.9:41338 4A7-K2M

  配对码 4A7-K2M 只能用一次，30 分钟后作废。
  过期或者抄错了，重起这个命令就会换一个新的。
```

节点那份配置**没有 channel、也没有 core** —— 节点只负责干活，不负责收发。

### 那台电脑上不写 id、也不写密钥

```jsonc
{
  "plugins": [
    { "id": "agent", "name": "@butler/agent-dsh", "config": { } },
    { "id": "node",  "name": "@butler/link-lan/node", "config": { "alias": "家里那台", "port": 41338 } }
  ]
}
```

它第一次上岗时**自己生成**一份身份（id + 密钥），存在 `~/.butler/node.json`（权限 0600），
之后一直是同一个身份。所以：

- **用户不用抄任何随机串** —— 手抄密钥这一步，对不懂技术的人就是终点；
- 密钥**从不经过微信**。经过微信的只有屏幕上那个配对码（所以它一次性、会作废、30 分钟过期）；
- 一台机器的密钥泄漏只影响那一台（初稿是全网共用一把）。

> 身份是**上岗时**才落盘的，不是装载时。所以 `butler doctor`（只装载、不启动）
> 不会在用户家里凭空造出一个文件来。

### 中枢那台要多一行：link（配不配都能跑）

要能 `@家里那台` 干活，收微信的那台的配置里得加上链路那一行
（**只加中枢，节点那边加的是 `@butler/link-lan/node`**）：

```json
{ "id": "link", "name": "@butler/link-lan", "config": { } }
```

就这一行，**别的什么都不用填**。设备用微信里的「配对」收（见 `packages/link-lan` 的 README），
收下的记在 `~/.butler/peers.json`，中枢重启还记得。

手写也仍然支持（想一次配好、不想配对的人）：

```json
{ "id": "link", "name": "@butler/link-lan",
  "config": {
    "secret": "跟节点上那个一模一样的密钥",
    "peers": [ { "id": "node-home", "alias": "家里那台", "host": "192.168.1.9", "port": 41338 } ]
  } }
```

`alias` 就是你在对话里 @ 的那个名字，`id` 要跟节点配置里的 `id` 一致。
这台机器只有一台电脑、不需要跨设备的话，**这一行不要加** —— 内核照跑不误。

### 安全闸：配置里有通道就拒绝启动

```
这份配置里有通道 —— 节点不该登录任何 IM。
同一个账号被两个进程同时收信，消息会随机分到两边，看起来就是"时好时坏"。
```

不是洁癖：同一个 IM 账号被两个进程同时长轮询，消息会**随机**落到其中一边，
而两边日志都正常 —— 用户看到的是"有时回有时不回"，极难查。宁可拒绝启动。

### 为什么它跟 `run` 长得这么像

因为本来就该像。两条命令的差别只是**这台机器在架构里的角色**，
不是两套代码。`run` 找 `ctx.core`、`node` 找 `ctx.node`，各起各的，然后一起等退出信号。

## 测试

```bash
pnpm test        # 190 个用例，全离线
```

| 文件 | 验什么 |
| --- | --- |
| `test/config.mjs` | 读取、形状校验、叠加语义（含"整体替换不是深合并"） |
| `test/boot.mjs` | 装载、坏行不致命、`has()`、`dispose` 后服务位真的消失 |
| `test/cli.mjs` | **真 spawn 进程**：退出码、stdout/stderr 分开、Ctrl-C 体面退出、patch 端到端生效 |
| `test/doctor.mjs` | 自检：正常路径、坏配置、坏 JSON、插件装不上、自检自己抛错、中文对齐 |
| `test/real-composition.mjs` | **真的三个插件**（真微信通道 + 真内核 + 真 dsh agent）装进一个容器 |
| `test/node-cli.mjs` | **真 spawn 一个 `butler node` 进程**：真开端口、中枢连过去、进度跨进程回来、安全闸；以及那个 ★ —— **不写 id 不写密钥的配置 → 屏幕上那一行 → 中枢照那一行收下 → 真的能遥控它** |
| `test/m2-e2e.mjs` | **M2 的验收，同一套用例跑两种链路**：中枢是真内核 + 真链路插件，节点是真子进程，中间隔一次真 HTTP 往返 |
| `test/setup.mjs` | **第一次用的人走的那条路**：`init` 生成什么、跑第二次不动任何文件、**生成出来的配置真的装得上**（`doctor` 真装四个插件），以及缺配置时给的是不是一行能抄的命令 |

`real-composition.mjs` 是"架构真的合得上"的最强证据：五个包、三条接缝，
同时立在一个容器里，三条能力位齐、配置端到端传到。

`node-cli.mjs` 里那个 ★ 是这一轮的核心验收：它把小白真正要走的那条路整个跑了一遍，
而且**每一步都是真的** —— 真进程、真端口、真 HTTP、真 SSE、真配对码。
顺带钉住两件容易忘的事：中枢自己**一把密钥都没有**（密钥是配对时换回来的），
以及那个配对码**只能用一次**。

`m2-e2e.mjs` 是"**换一条链路不用改内核**"的最强证据：同一个 `hub()`，
只把 `ctx.link` 的实现从 `@butler/link-lan` 换成 `@butler/link-tailscale`
（名册改问一个假 `tailscale` CLI 要），四条验收标准的断言一个字都不用改。

> ⚠️ 它**只装载，不启动**。通道的构造函数只建客户端不连网，连网在 `start()` 里 ——
> 真连上会跟正在跑的那条桥抢同一个微信账号的消息（两个循环游标会打架）。
