# 术语表 / Glossary

**这份文件是双语的。** 左边是中文文档里的说法，右边是英文文档里的对应说法。

它有两个用途：

1. **给译者用。** 翻译这套文档时，术语只能从这张表里选。同一个概念在四份文档里
   必须叫同一个词 —— 这是文档读起来像一个人写的前提。
2. **给读者用。** 英文读者想对照中文源码注释时，能在这里找到对应关系。

> **语言之锚是中文版。** 中文版是源，英文版是译本。
> 两边不一致时以中文版为准 —— 改的时候请两个一起改（CI 会检查结构是否对齐）。

---

## 核心概念

| 中文 | English | 说明 |
| --- | --- | --- |
| 管家 / AI 管家 | the butler / AI butler | 产品名。小写 `butler` 指命令行；大写 `Butler` 只出现在包名前缀 `@butler/*` |
| 能力位 | service slot | cordis 语境下"一个服务名占住的位置"。不要叫 *capability* |
| 接缝 | seam | 只声明接口、不含实现的那一层。这是本项目的关键词，别译成 *interface layer* |
| 实现包 | implementation package | 相对 seam 包而言 |
| 内核 | kernel | `packages/core`。**不叫** *core package*（会跟 `ctx.core` 混淆） |
| 脊梁 | spine | 跑起来必不可少的几条能力位（channel / agent / core） |
| 通道 | channel | `ctx.channel` |
| 大脑 | agent | `ctx.agent`。中文文档里"大脑"就是 agent，英文统一用 *agent* |
| 夹具 | fixture | 测试用的假实现 |
| 用例 | test case | |
| 认主 | claim ownership / owner claiming | 第一个跟管家说话的人成为主人 |
| 主人 | the owner | |
| 一声不吭 | goes silent | 陌生人来消息时管家的行为（安全设计） |
| 逃生舱 | escape hatch | patch 文件的定位 |
| 小白 / 不懂技术的人 | non-technical user | 别用 *novice*（略带贬义），也别用 *layman* |
| 自检 | self-check | `check()` 的实现叫 *self-check*；`butler doctor` 整体叫 *doctor* |
| 实测 | measured / empirically verified | 强调"跑出来验过"，不是"查文档抄的"。可作 *measured facts* |
| 如实 | honestly / verbatim | 报告错误时原样转述，不粉饰 |
| 收信循环 | receive loop | 长轮询那一层 |
| 长轮询 | long-poll | |
| 游标 | cursor | iLink 的 `get_updates_buf` |
| 分条 | chunking | 超长文本拆成多条 |
| 正在输入 | typing indicator | |
| 引用 | quote / quoted reply | |
| 落本机 | saved locally | 附件下载到本机磁盘 |
| 收件箱 | inbox | `state/inbox/` |
| 排队 | queue | |
| 进度播报 | progress updates | 干活过程中主动告诉用户进展 |
| 中枢 | hub | 多终端里的主控机器 |
| 节点 | node | 被纳管的其他设备 |
| 设备别名 | device alias | 「家用电脑」这种名字 |
| 降级 | degradation | 出错时的行为 |
| 端到端 | end-to-end | |

## 产品名与包名

| 中文 | English | 说明 |
| --- | --- | --- |
| 微信通道 | the WeChat channel | `packages/channel-wechat` |
| 命令行入口 | the CLI | `butler` 命令 |
| 引导页 | onboarding page | M3 里的那个扫码页 |
| 双击装 | double-click install | 不装 Node、不碰终端 |
| 不问 key | never asks for a key | 指的是不向用户索要模型 key 之外的任何东西 |

## 翻译规则

1. **结构必须对齐。** 英文版的二级标题（`##`）数量、顺序与中文版一致。
   CI 会检查这一条 —— 它拦的是"加了新章节但忘了另一边"。
2. **不译的东西**：代码、标识符、文件路径、命令、包名、API 名、测试名、
   错误信息原文、`ctx.xxx`。这些一律原样保留。
3. **保留语气。** 这套中文文档的语气是**直接、不绕弯、敢下结论**，
   还会明说"这是踩过的坑"。翻成英文时保持同样的力度 ——
   不要变成四平八稳的公司文档腔。
   - 好：*This is a foot-gun. Don't do it.*
   - 坏：*It is generally recommended to avoid this practice.*
4. **保留标记**：`✅` `⚠️` `🔨` `📐` `🟡` 和引用块（`>`）原样保留。
5. **图有两套。** 中文文档引用 `docs/diagrams/*.svg`，英文文档引用
   `docs/diagrams/en/*.svg` —— 同一批图的英文标注版，张数、顺序、配色都一致。
   中文版是源，英文版是译本。**改图要两套一起改**，渲染脚本会把两套一起重渲。
6. **链接**：指向另一份文档时，如果那份文档已有英文版，就指向英文版；
   没有的话保持指向中文版，并在链接文字里说明。
7. **示例对话保留中文原文，后面加英文注。** 写成：

   ```
   「帮我把桌面上那堆图按日期整理进文件夹」
       (tidy that pile of images on my desktop into folders, by date)
   ```

   **为什么不直接译成英文**：这些例子是**用户真正要打进微信的话**，
   是产品的输入，不是叙述文字。译掉之后它就不再是"照着能用的例子"了。
   同一个理由也适用于路径（`Documents/简历/`）—— 那是真实的目录名。

   只加注、不译，还有个实际好处：**不会出现半译状态**
   （一边把句子译了、一边留着 `项目/2026` 这种中文路径），那种样子最像没做完。

   注放在下一行缩进对齐；列表里就放在同一行，用 ` — ` 隔开。

   **例外：方框里的界面示意图**（`┌───┐` 那种画出来的聊天画面）**整段译成英文**。
   它不是"照着能打的字"，是**截图**：读者要能一眼看懂交互长什么样，
   满屏中文就什么都传达不到。但**框里的文件名、路径保持原样** ——
   那是真实文件的名字（`📎 季度汇报_2026Q3.pptx` 就该长这样）。

   一句话记法：**正文里的例子是输入，译了就不能用了；框里的是截图，不译就白画了。**
8. **占位词要译，真实值不译。** 这是上一条容易卡住的地方，判别标准只有一个：
   **这个值是不是真实存在的？**

   | 写法 | 译法 | 为什么 |
   | --- | --- | --- |
   | `'标签'`（`ctx.effect(…, '标签')` 里的） | `'label'` | 它是"随便一个标签"的占位，不是真实字面量（真实的是 `'wechat.stop'`） |
   | `/你要它管的目录` | `/the/directory/you/want/it/to/manage` | 占位路径，用户会替换掉 |
   | `Documents/简历/` | 原样 | **真实的目录名**，用户机器上就叫这个 |
   | `📎 季度汇报_2026Q3.pptx` | 原样 | 真实文件的名字 |
   | `项目/2026` | 原样 | 真实路径 |

## 语言之锚

| 文档 | 中文（源） | 英文（译本） |
| --- | --- | --- |
| 项目首页 | [`README.md`](../README.md) | [`README.en.md`](../README.en.md) |
| 形态与目标 | [`VISION.md`](VISION.md) | [`VISION.en.md`](VISION.en.md) |
| 产品架构 | [`ARCH-product.md`](ARCH-product.md) | [`ARCH-product.en.md`](ARCH-product.en.md) |
| 技术架构 | [`ARCH-technical.md`](ARCH-technical.md) | [`ARCH-technical.en.md`](ARCH-technical.en.md) |
| 验收证据 | [`EVIDENCE.md`](EVIDENCE.md) | [`EVIDENCE.en.md`](EVIDENCE.en.md) |

包级 README（`packages/*/README.md`）目前只有中文 —— 它们是挨着代码的 API 文档，
增量补齐即可。**没有它们的英文版不影响阅读上面五份。**

[`GETTING-STARTED.md`](GETTING-STARTED.md)（三步上手 + 验收清单）也**故意只有中文**：
它是给"完全不懂技术的中文用户"看的一页纸，不是开发文档 —— 它要能直接发给用户、
能被打印出来照着打勾。翻译它不会让它对目标读者更有用，只会让它更容易过期。
