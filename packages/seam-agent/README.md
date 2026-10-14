# @butler/seam-agent

Agent 能力位 —— `ctx.agent`。**只有接口，没有实现。**

"干活的那颗大脑"是可替换的。核心层只认这个能力位，不认"dsh"；
换大脑不需要改核心层一行代码。

> ⚠️ `@butler/*` 是**占位 scope**，尚未发布到 npm。要装自己 clone 仓库、
> 走 pnpm workspace。

## 契约长什么样

```ts
interface AgentRequest {
  text: string;                 // 用户说的话（有附件时末尾已附上本机路径）
  files?: LocalFile[];          // 附件，已落成本机文件
  sessionId?: string | null;    // 续接会话；首次为 null
  cwd: string;                  // 在哪干活
  onProgress?: (line: string) => void;   // 长任务进度（可选）
  signal?: AbortSignal;         // 取消（可选，但"拉起子进程"的实现应当支持）
}

interface AgentResult {
  sessionId?: string | null;    // 下次用它续接
  text?: string;                // 回给用户的正文
  files?: OutboundFile[];       // 要发回去的附件
  error?: string | null;        // 失败原因（优先返回它，而不是抛异常）
  code?: AgentErrorCode;        // 机器可读的失败类型，核心层据此恢复
}
```

## 自己写一个

```ts
import z from '@deepseek-ai/schemastery';
import { AgentService } from '@butler/seam-agent';
import type { AgentRequest, AgentResult } from '@butler/seam-agent';

export default class MyAgent extends AgentService {
  static Config = z.object({ bin: z.string().default('my-agent') });

  readonly id = 'my';
  override readonly cancellable = true;

  constructor(ctx, readonly config: { bin: string }) { super(ctx); }

  async run(req: AgentRequest): Promise<AgentResult> {
    // 干活。失败就 return { error: '为什么失败' }，别抛。
    return { text: '干完了' };
  }
}
```

装它：

```ts
await ctx.plugin(MyAgent, { bin: '/usr/local/bin/my-agent' });
// ctx.agent 就位了
```

## 实现者必须遵守的四条

1. **一问一答。** 核心层是串行的，不要自己再开长驻循环。
2. **失败必须说。** 返回 `error` 而不是抛异常；错误信息里带上"为什么"。
3. **尊重 `signal`。** agent 一跑几分钟，用户改主意了不该只能干等超时。
4. **不要自己回消息。** 你只管产出结果，怎么发给用户是核心层的事。

## 为什么 `files` 和 `onProgress` 是可选的

不是每个后端都用得上：多数 agent 自己有读文件的工具，靠正文里的路径就够了——
所以 `files` 是留给**一次性多模态后端**的（直接把图喂给视觉模型）。
`onProgress` 同理：能报就报，不报核心层也会定期说一句"还在处理"。

**契约是从已经跑通的实现里长出来的，不是先画好再逼实现去满足。**

## 测试

```bash
pnpm test        # 12 个用例，全离线
```

被测对象是**编译产物**（`lib/`）；假 agent 用 TypeScript 写在
`test/fixtures/` 里，所以类型契约（抽象成员漏没漏）和运行行为一起被验证。

覆盖：加载与双身份、重复注册抛错、每个契约字段真的传到实现、Config 默认值与覆盖、
抛异常如实冒泡、返回 `error` 是正常路径、`inject` 门控、卸载时 effect 收尾。

---

## 自检：`check?()`

**可选。** 实现了，`butler doctor` 就会问你"你这层现在行不行"，并把答案原样打给用户：

```ts
override check(): HealthCheck[] {
  const bin = which(this.config.argv[0] ?? '');
  return [bin
    ? { name: '要跑的程序', ok: true, detail: `${bin}（问题当最后一个参数）` }
    : { name: '要跑的程序', ok: false, detail: `找不到 ${this.config.argv[0]}`,
        fix: '确认这个程序装好了；不在 PATH 里的话，argv 的第一项写绝对路径' }];
}
```

**只有实现者知道自己缺什么**：dsh 知道它要哪个二进制和哪个 patch 文件，
exec 知道 `argv[0]` 在不在，接 API 的实现知道 key 配没配。
让 doctor 从外面查是层次错误。

三条约定：**不抛错**、**别做重活**（不真跑一次任务）、
**`detail` 说状态、`fix` 说动作**（那句 `fix` 决定用户能不能自己解决）。

⚠️ 实现 `check()` 时记得写 **`override`** —— 它覆盖的是基类的**可选**成员，
不是抽象成员，所以 `noImplicitOverride` 会要求这个关键字。
