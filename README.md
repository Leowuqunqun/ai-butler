# AI 管家

[![CI](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml/badge.svg)](https://github.com/Leowuqunqun/ai-butler/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

[English](README.en.md) | 中文

在聊天软件里遥控你自己的电脑。你说要什么，它自己去找、去改、去办。

微信、飞书、Telegram 三条通道都能接，一次装一条。

```
你（手机上的微信 / 飞书 / Telegram）：把桌面那堆图按日期整理一下
管家（你的电脑）：32 张图，按拍摄月份分成了 5 个文件夹。要看看清单吗？
```

![整体架构](docs/diagrams/arch-00-overview.svg)

## 它是怎么工作的

管家跑在你自己电脑上。干活的是 DSH（DeepSeek Harness）的 headless agent，它读写文件、跑命令，所以「把桌面整理一下」是真的去整理，不是给你一段操作步骤。

手机和电脑之间不需要内网穿透。三条通道都是**电脑主动往外连**：微信长轮询腾讯的服务器，Telegram 长轮询 Bot API，飞书走 WebSocket 长连接。这三家的服务器就是现成的中继，我们自己不运营任何服务器。只有中枢到其他节点才需要穿透，那一段走局域网或 Tailscale。

能力位拆成五个只声明契约的 seam 包：`ctx.channel` / `ctx.agent` / `ctx.link` / `ctx.approval` / `ctx.memory`。第二条和第三条通道就是这么接进来的，各自只多了一个包，**核心层的代码一行没改**，改的只有 CLI 那边的通道枚举、凭据形状和引导页文案。

要做成什么样、哪些明确不做：[VISION.md](docs/VISION.md)

## 快速开始

macOS / Linux 一行命令。不用先装 Node，它会自己下一个并校验 SHA256：

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/latest/download/install.sh | sh
```

不想碰终端就下载整包、解压、双击 `install.command`：[Releases](https://github.com/Leowuqunqun/ai-butler/releases/latest)

装完浏览器会弹出引导页，只剩两步：贴一次模型 key，再给通道一次凭据。微信是扫一次码，飞书和 Telegram 是贴一串（`app_id` + `app_secret` / bot token）。macOS 第一次双击会被系统拦一下，右键选「打开」即可，我们没买 Apple 的签名证书。

装完的详细走一遍（给完全不懂技术的人看，有可打勾的验收清单和「卡住了看这里」对照表；默认走微信，飞书和 Telegram 各有单独一节）：[GETTING-STARTED.md](docs/GETTING-STARTED.md)

命令行细节在 [packages/cli](packages/cli)。全仓九百多个离线测试，可以现跑现数：`pnpm test`。

### 已经在跑 DSH，只想加一条通道

不用装上面那一整套。打包好的 bundle 就在 Release 里，一条命令装进某个 profile：

```sh
curl -fsSL https://github.com/Leowuqunqun/ai-butler/releases/download/v0.2.1/butler-dsh-plugin-0.2.1.tar.gz | tar xz
dsh plugin --profile web add "file:$(pwd)/butler-dsh-plugin-0.2.1/plugin"
```

配置（`cwd` / `owner` / 端口 / `autostart`）、它不做什么、怎么先自己验一遍：[packages/dsh-plugin](packages/dsh-plugin/README.md)

## 现在能用什么

这个仓库正在从「一个能用的微信桥」长成「一个完整的管家产品」。今天真正能跑的是接入和对话两层，上面几层还在设计或施工中：

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 接入 | 一行安装（`install.command` 双击）+ 引导页，不装 Node、不要管理员密码 | 能用 |
| 接入 | 三条通道任选一条：微信（扫码）/ 飞书（企业自建应用，站在官方 `@larksuite/channel` 上）/ Telegram（bot token） | 三条都能用。微信和 Telegram 早就在跑，飞书 2026-10-14 真机验收过 |
| 接入 | 同时接多个 IM（微信和飞书并用） | 未做。一个 context 只有一个通道位，结论见 [CHANNEL-FEISHU.md 第十三节](docs/CHANNEL-FEISHU.md) |
| 对话 | 收发文本、语音转写、发文件 / 图片 / 视频、引用前缀 | 能用 |
| 对话 | 收图片、收文件（CDN 下载 + 解密 + 落到本机交给 agent） | 能用 |
| 能力 | agent 干活（可插拔后端：DSH / 任意命令行程序） | 能用 |
| 能力 | 记忆 | 能用。回答里写 `[[记住: …]]` 会被记下 |
| 能力 | 主动提醒 | 未开工 |
| 设备 | 多终端：中枢 + 节点 + 别名路由 + 在对话里配对收设备 | 能用。两台机器，说 `@家里那台` 就指过去 |
| 信任 | 审批 | 能用。在对话里问一句；可以给带期限的长期授权 |
| 信任 | 审计 | 未开工 |

每一层的证据（M1 / M2 / M3 明细、用例怎么分布、哪些是端到端、干净环境验收抓到过什么 bug）：[EVIDENCE.md](docs/EVIDENCE.md)

## 仓库结构

```
packages/
  seam-channel/        通道能力位 ctx.channel（TypeScript，只有接口，无实现）
  seam-agent/          大脑能力位 ctx.agent（只有接口，无实现）
  seam-link/           链路能力位 ctx.link（只有接口，无实现）
  seam-approval/       审批能力位 ctx.approval（只有接口，无实现）
  seam-memory/         记忆能力位 ctx.memory（只有接口，无实现）
  core/                内核（hub 角色）：认主、路由、排队、进度播报、回话、审批中转、自检
  channel-wechat/      通道实现：微信（iLink 协议）扫码登录、收发、附件
  channel-telegram/    通道实现：Telegram（纯 fetch 零依赖、长轮询）
  channel-feishu/      通道实现：飞书（站在官方 @larksuite/channel 上；收图片 / 文件落到本机）
  agent-dsh/           大脑实现：DSH headless agent（带工具级进度）
  agent-exec/          大脑实现：任意「一问一答」的命令行程序
  approval-im/         审批实现：在对话里问主人（默认）
  memory-file/         记忆实现：JSON 文件（0600 + 原子写）
  link-lan/            链路实现：局域网（HTTP + SSE，零依赖；配对码收设备）
  link-tailscale/      链路实现：跨网（名册问 Tailscale；线上复用 link-lan 那套协议）
  cli/                 入口 butler：配置 + patch 叠加 → 拉起容器 → 上线 / doctor 自检
  dsh-plugin/          只给 DSH 加通道用的插件形态
docs/                  产品与技术架构、18 张图
scripts/               图渲染 + 文档 / 包结构自检 + 变异测试
```

`hub` / `node` / `installer` 还没拆成包：hub 由 `core/` 承担，node 由 `link-lan/node` 承担，引导器脚本在仓库根目录（`install.sh`）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [VISION.md](docs/VISION.md) | 目标、最终形态、三个岔路的结论、硬骨头 |
| [ARCH-product.md](docs/ARCH-product.md) | 五层能力模型、用户旅程、四个核心机制、产品边界 |
| [ARCH-technical.md](docs/ARCH-technical.md) | 拓扑、包与 seam、契约、patch 分层、时序、降级表 |
| [GLOSSARY.md](docs/GLOSSARY.md) | 中英术语对照表，翻译的规矩，也是读源码注释的对照 |
| [docs/diagrams/](docs/diagrams/) | 18 张架构图（含源文件与配色约定），先看[整体架构](docs/diagrams/arch-00-overview.svg) |
| [CHANNEL-FEISHU.md](docs/CHANNEL-FEISHU.md) | 飞书的接入形态与权限点、长连接的硬约束、逐条映射到 `ctx.channel`、工作量估算；第十三节是「同时收多个 IM」的结论存档 |
| [EVIDENCE.md](docs/EVIDENCE.md) | 每一层的验收明细、端到端用例、干净环境真装一遍、变异测试 |
| [seam-channel/README.md](packages/seam-channel/README.md) | 想接一个新 IM 看这个：契约、示例、踩过的坑 |
| [seam-agent/README.md](packages/seam-agent/README.md) | 想换掉干活的大脑看这个：`ctx.agent` 契约、示例、实现者四条守则 |
| [seam-link/README.md](packages/seam-link/README.md) | 想接一条新链路（Tailscale / SSH / 自建中继）看这个：`ctx.link` 契约、安全红线 |
| [cli/README.md](packages/cli/README.md) | 想知道怎么真的跑起来看这个：`butler init` 生成什么、配置格式、patch 语义、`doctor` |
| [dsh-plugin/README.md](packages/dsh-plugin/README.md) | 只想给 DSH 加一条通道看这个：Release 一条命令装进 profile、真机验收怎么跑 |

其余各包（`link-lan` / `link-tailscale` / `agent-dsh` / `agent-exec` / `channel-wechat` / `channel-telegram` / `channel-feishu` / `approval-im` / `memory-file` / `seam-approval` / `seam-memory`）各自目录下都有 `README.md`。

## 开发

```bash
pnpm install            # 装依赖（Node ≥ 20、pnpm 10）
pnpm build              # 构建 TypeScript 包 → lib/
pnpm typecheck          # 只做类型检查，不产出
pnpm test               # 全部包，全部离线：不连网、不需要 IM 账号、不会真的发消息
pnpm check:docs         # 文档体检：断链 / 锚点 / 被 gitignore 的文件 / 出包文档的链接读者够得着 / 本仓地址指得到
pnpm check:packages     # 打包体检：装出去的包里，入口和编译产物一个都不少，运行时依赖也都声明了
pnpm check:scripts      # 脚本体检：会印字的函数（从源码里认，含 say/die）标题里别放反引号、不带引号的 heredoc 里也别放
pnpm check:user-facing  # 文案体检：会打印给用户看的话里别出现 packages/ docs/ scripts/
pnpm mutate             # 变异测试：验的不是代码，是测试本身（十几分钟，手动跑）
pnpm diagrams           # 重新渲染 docs/diagrams/*.svg
```

测试是刻意做成离线可跑的：微信媒体那部分自己伪造 CDN 密文、自己跑 AES 解密来验证，所以不需要真账号、也不会给谁发消息。CI 在 Node 20 / 22 / 24 三个版本上跑全套。

这些检查为什么存在（每一个都是被真事故逼出来的）：[EVIDENCE.md](docs/EVIDENCE.md)

## 路线图

| | 内容 | 验收 | 状态 |
| --- | --- | --- | --- |
| M0 | 通道层跑通：扫码、收发、附件、引用、可插拔后端 | 当时 19 个离线测试 | 已完成 |
| M1 | 通道层插件化 + 收图片 / 文件 + `doctor` 自检 + CI + 中英文档 | 做完就能开源出去 | 已完成 |
| M2 | 多终端（中枢 + 节点 + 别名路由）+ 在对话里配置 | 两台机器，在对话里说「家用电脑上那个文件」能拿到 | 已完成 |
| M3 | 安装器（双击装、引导页扫码、不问 key）+ 第二个 IM 通道 | 不懂技术的人独立走完 | 进行中 |

里程碑的明细、以及每一条是怎么验的：[EVIDENCE.md](docs/EVIDENCE.md)

## 设计取舍

1. **手机到电脑不需要网络穿透。** 三条通道都是电脑主动往外连：微信长轮询腾讯的服务器，Telegram 长轮询 Bot API，飞书走 WebSocket 长连接。用它们的服务器当中继，我们自己不运营服务器，这也是在外面遥控家里电脑零成本的原因。只有中枢到其他节点才需要穿透，那走 `ctx.link`（局域网 / Tailscale）。
2. **活在哪台机器干，就在哪台机器跑 agent。** 中枢只负责认人、路由、审批、记忆，不替节点读文件，否则中枢会变成瓶颈和隐私黑洞。
3. **架构对齐 dsh，但不把 dsh 的复杂度暴露给不懂技术的人。** seam 拆分、patch 组合、依赖注入都照搬 dsh（内核也用同一个 cordis），但 patch 文件是给开发者和高级用户的逃生舱，不是产品界面。

## 许可证

MIT © 2026 吴群群
