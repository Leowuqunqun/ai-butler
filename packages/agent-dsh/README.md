# @butler/agent-dsh

`ctx.agent` 的实现：把 **DSH 本体的 headless agent** 当成干活的大脑。

```bash
dsh --profile headless --patch <你的 patch> --json [--session-id <id>] "<任务>"
```

## 为什么用 `--patch`

所有覆盖（模型通道、人格、沙箱）都写在一个 patch 文件里，通过命令行注入，
**不碰任何全局 profile 配置**。换机器只要改这一个文件。

## 用法

```ts
import { DshAgent } from '@butler/agent-dsh';

await ctx.plugin(DshAgent, {
  patchFile: '/Users/me/.butler/dsh.patch.yml',   // 必填
  home: '/Users/me/.butler/dsh-home',             // 必填，见下
  bin: 'dsh',                                     // 默认从 PATH 找
  profile: 'headless',
  timeoutMs: 300_000,
});
// ctx.agent 就位
```

## 人格：它随包发一份模板

```
templates/default.patch.yml
```

`butler init` 会把这份模板抄到用户的 `~/.butler/dsh.patch.yml`。
**用户一个字都不用改。** ① 里的模型通道有默认值（DeepSeek 官方通道 +
`deepseek-flash`），而模型 key **不在这个文件里** —— 它在凭据库里，
`butler run` 第一次会打开一个页面让他贴（见 `packages/cli` 的引导页）。
② 那几行**不该动** —— 因为那不是示例配置，是**产品行为**：

| 里面写了什么 | 为什么 |
| --- | --- |
| 输出禁止 Markdown | 微信不渲染它。收到 `**粗体**` 和表格，用户看到的是乱码 |
| 要发文件就单独写一行 `[[file:/绝对/路径]]` | 通道只认这一种"我发个文件给你"，写之前先确认文件存在 |
| 不许拿截图 + 模拟鼠标键盘去点界面 | 这条路上没有任何人能看到屏幕，点错了没人拦得住 |
| `approval: policy: never` | headless 里没有人能点"允许"，不是 `never` 就会**无限期卡死** |

模块想读它（比如 `butler init` 要抄一份）走子路径导出：

```js
createRequire(import.meta.url).resolve('@butler/agent-dsh/templates/default.patch.yml');
```

## 三个坑（都踩过）

### 1. `--patch` 必须排在 `--json` 前面

写成 `dsh --json --patch f.yml` 会直接报 `unknown option '--patch'`。
实现里参数拼装是写死的顺序，有测试钉着。

### 2. `home` 绝不能和 `dsh web` 共用

如果管家和 `dsh web`（GUI）用同一个 `DSH_HOME`，同一个 cwd 会落进同一个
sessions 目录，GUI 会给会话挂上写锁，续接时就会报：

```
session "..." is already owned by an active write handle
```

所以必须给管家一个**私有的** `DSH_HOME`。这条错误会被识别成 `SESSION_LOCKED`，
核心层收到后会**丢掉旧会话、开个新的重试一次**（而不是把这个英文报错丢给用户）。

### 3. 必填配置是**加载时**拦住的，不是编译期

`schemastery` 的 Schema 是可调用的，所以它正好满足 cordis 的
`Plugin.Transform`（`Config: (config: S) => T`）——`static Config` 就成了
`ctx.plugin()` 的类型来源。但 schemastery 的**调用签名**是
`(value?: S) => T | null | undefined`，推断出来的配置类型含 `undefined`，
于是 cordis 的 `Spread<T> = undefined extends T ? [config?: T] : [config: T]`
**永远**把配置判成可选 —— `ctx.plugin(DshAgent, {})` 编译得过。

所以"必填"由**构造函数**在加载时拦住，错误信息点名缺了哪个、以及它是干什么的。
（类型写错——比如 `patchFile: 123`——仍然是编译期报错。）

## 进度：这一条是给用户看的

headless agent 会吐 NDJSON，其中 `tool_call` 事件带 `{callId, tool, input}`。
实现把它翻成一行进度交给 `onProgress`：

```
🔧 read {"path":"src/index.ts"}
⚠️ bash 失败了
```

这不是锦上添花。实测遇到过 agent 跑了两三分钟**一句话都不说**，
用户那边看到的就是"没反应"，只能反复问"在吗"。把"它在干什么"报出去，
等待才是可忍受的。

`thinking` 和 `text` 事件**不外传**——它们会刷屏。

## 测试

```bash
pnpm test        # 32 个用例（25 + 7 端到端），全离线
```

`bin` 指向 `test/fixtures/fake-dsh.mjs` —— 一个**真进程**，按任务文案演出不同的
NDJSON 流。用真进程是刻意的：这个实现的行为几乎全在**子进程边界**上
（参数顺序、流式解析、超时、被 SIGKILL、非零退出码、stderr 里的会话锁），
用替身模块恰恰测不到这些。

覆盖：加载与双身份、必填配置（三种缺法）、`timeoutMs <= 0`、默认值、
参数顺序、`--session-id` 有无、任务文案位置、私有的 `DSH_HOME` 与 cwd 真的生效、
正常完成 / 没 final / 流里混进非 JSON / 工具进度 / 空入参 / 长入参截断 /
`turn_end` 错误 / 非零退出取 stderr 最后一行 / `SESSION_LOCKED` / 退出码兜底 /
启动失败 / 超时 / 取消 / 已 aborted 的 signal / 监听器不泄漏。

### 端到端那一组（`test/with-core.mjs`）

前面两组都是分开验的：`core` 对着**假** agent，这里对着**假** dsh。
`with-core.mjs` 把它们接起来 —— **真 `core` 驱动真 `DshAgent` 驱动真子进程** ——
验的是**接缝**：

- 通道 → 内核 → dsh → 回话，整条路真的通
- **工具级进度真的送到了用户手里**（那条"221 秒没声音"的解法）
- 会话跨两条消息续接
- 会话被占用 → 内核丢掉旧会话重试 → 用户拿到结果而**不是**报错
- agent 出错时如实转述
- agent 跑着的时候停机能被立刻掐断（子进程也不留）
- 陌生人指挥不动这台机器

> 就是这一组抓到了一个真问题：进度播报里漏出了 `启动 dsh（上限 300s）`
> —— 开发者语言跑进聊天窗口了。现在启动细节只进日志。
