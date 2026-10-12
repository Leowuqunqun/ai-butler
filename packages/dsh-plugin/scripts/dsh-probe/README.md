# 验收探针（真机）

**离线测试证明逻辑对，这里证明接线对。**

`packages/dsh-plugin/test/` 那 37 个测试跑在假的 DSH 上，所以它们没法回答
"我们调 DSH 的那几行 API 到底是不是这个语义"。这个目录就是来回答那个问题的：
在一个**临时 DSH home** 里把真插件装起来，用**本地假模型**真跑两轮。

```bash
bash run.sh                 # 仓库里
bash probe/run.sh           # 发行包里（解开包之后）
PROBE_KEEP=1 bash run.sh    # 留现场：临时 home 与日志不删
```

不出网、不花钱、不碰你正在用的 `~/.dsh`。

## 三个文件

| 文件 | 是什么 |
| --- | --- |
| `run.sh` | 验收本身：建临时 profile → 装插件与探针 → 起假模型 → 跑两遍 → 逐项断言 |
| `index.mjs` | 探针插件：装进**同一个** profile，启动时用真 `ctx.agents/sessions/agentDefaultModel` 驱动 `@butler/dsh-plugin/bridge` 跑两轮（通道是记账用的假对象，不碰微信） |
| `fake-model.mjs` | 本机假模型：一个说固定话的 OpenAI 兼容端点（同时支持流式与非流式） |

## 它断言什么

1. 打出来的插件包在真 DSH 里**装得上、挂得上**（行名解析、peer、patch 顺序都按预期）；
2. `autostart: false` 时**只挂通道、不登录微信**（登录要人扫码，验收里不做）；
3. 第一遍（会话存储空）→ 走 `create`；第二轮 → 复用 `live` 会话；**只建一个会话**；
4. 第二遍（存储留着）→ 走 `resume` 接回同一份，**一个新会话都不建** —— 这就是"跨重启还连续"；
5. 每轮回复都是**模型产出的**，并且真的回到了"微信"那头；
6. 假模型的服务端日志里**有我们发出去的那两句话**（对账：消息真的到了模型）。

## 已知的两个坑（都是这里抓出来的）

- **`undefined` 值的键会毁掉整条消息**：DSH 往会话里写事件前做无损 JSON 快照，
  `{ messageId: undefined }` 往返之后会少一个键，于是
  `session event "agent/inbox/spliced" carries non-JSON-serializable data`。
  现在在 `userMessage()` 入口统一清掉。
- **别插第二行 pi-ai**：模板里本来就有 `llm-pi-ai` 那一行，再 `insert` 一行会让内置
  provider 重复声明（`LlmError: configurable provider "amazon-bedrock" is already declared`）。
  而且 DSH 的 `config` 是**整体替换**，改写已有行时要给出完整的 `providers`。

## 这里**不**验的

- 真微信登录（要你扫码）；
- 真云端模型（要你的 API key）。

这两件只能在你自己的机器上验。
