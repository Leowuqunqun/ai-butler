# @butler/seam-approval

`ctx.approval` —— **"要动你的电脑"这件事，得有个人点头**。

这是能力位（seam），不是实现。它只钉住两件事：怎么问、怎么答。

```ts
interface ApprovalService {
  readonly id: string
  list(): Promise<ApprovalRequest[]>                       // 旧的在前，已结算的不在里面
  answer(id: string, decision: 'allow' | 'deny', by?): Promise<boolean>
}
```

## 它**没有** `ask()`

这不是漏了。`ask()` 是"提问方"的接口 —— 而在管家这条路上，**提问方在
dsh 子进程里**（dsh 自己的审批 seam 负责发问），不在管家进程里。
管家这一侧只干两件事：把待批的事念给主人、把主人的答复落回去。

一个没有实现用的接口就是猜。这个项目已经为此删过一次 `requestApproval`
（见 `docs/ARCH-technical.md` 三节），所以这次不猜。

## 三条纪律

1. **超时 = 不许。** 到点没人答就是拒绝。绝不"先做了再说"，也绝不无限期地等。
2. **`answer()` 是幂等的。** 同一件事答第二次返回 `false`（已经结算过了），
   而且**不会**留下第二行账 —— 一次审批只有一行。
3. **读不动要抛。** 记录坏了、盘没了，就把错误抛上去。装作"没人等你"是最坏的一种：
   主人会以为自己什么都批过了。

`by` 说明这个结论是谁下的：`'owner'`（主人）/ `'timeout'`（到点了）/ `'withdrawn'`（对方撤回了）。

实现见 [`@butler/approval-im`](https://github.com/Leowuqunqun/ai-butler/blob/main/packages/approval-im/README.md)（默认，问进对话里）。
