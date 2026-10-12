# @butler/agent-exec

`ctx.agent` 的实现：把问题交给**任意「一问一答」的命令行程序**，用它的 stdout 当回答。

```json
{
  "id": "agent",
  "name": "@butler/agent-exec",
  "config": { "argv": ["/usr/local/bin/my-agent", "--quiet"], "input": "arg" }
}
```

适合：你自己包的脚本、别的 agent CLI（Claude Code、aider……）、一个 curl 封装、
任何没有 Node SDK 的东西。

## 配置

| 字段 | 默认 | 意思 |
| --- | --- | --- |
| `argv` | **必填** | 完整命令行。数组形式，**不经过 shell** |
| `input` | `arg` | `arg` = 问题当最后一个参数；`stdin` = 写进标准输入 |
| `timeoutMs` | `300000` | 单轮上限，到点 SIGKILL |
| `cwd` | 空 | 留空 = 用请求里的 `cwd` |

## 它存在的第二个理由：检验契约

`ctx.agent` 最早是照着 dsh 长的。**第二个实现**就是为了检验这件事：
如果契约是给 dsh 量身定做的，这里就会别扭。

结果是不别扭，两个地方值得说：

- **没有会话概念的后端，可以完整实现这个契约。** 每次都是一次性调用，
  `sessionId` 恒为 `null`。不需要塞空对象、不需要 `sessionId: undefined` 之类的将就。
  契约里 `sessionId` 是可选的，不需要它的实现直接返回 `null` 就行。
- **`cancellable` 让调用方在编译期就知道支不支持取消**，不用去翻文档。
  `exec` 支持，所以是 `true`。

> 如果你的 CLI 支持续接会话，**别硬塞进这个实现** —— 自己写一个实现包更合适。

## 几个刻意的选择

**不经过 shell。** `argv` 是数组，直接交给 `execve`。所以问题里带换行、引号、
`$(whoami)`、反引号都不会被当成命令执行 —— 有测试钉着。
需要 shell 语义的话，自己写 `["sh", "-c", "…"]`，把风险留在你自己手里。

**有 stdout 就用 stdout，哪怕退出码非零。** 很多 CLI 会"边输出边以非零码退出"，
那也还是有话要说。只有 stdout 是空的时候，非零退出码才会被当成错误。

**stdout 空 + 非零退出码 → 只取 stderr 的最后一行。** 不是整段倒给用户：
前面那些通常是无关的警告。stdout 空 + 退出码 0 → 返回空 `text`，
由内核层去说"没出结果"（那是产品话术，不该由实现包决定）。

**stdin 写不进去不算错。** 子进程可能根本不读 stdin 就退了，这时写会拿到 EPIPE。
直接忽略 —— 有测试拿 200KB 去撞管道缓冲区。

## 测试

```bash
pnpm test        # 21 个用例，全离线
```

`argv` 都指向真程序（`node -e`、`cat`），因为这个小东西的价值全在**子进程边界**上：
退出码、stdout/stderr、超时、被掐断、stdin 的 EPIPE。用替身模块恰恰测不到这些。
