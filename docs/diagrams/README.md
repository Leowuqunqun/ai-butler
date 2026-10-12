# 架构图

**图源是 `.mmd`（Mermaid），`.svg` / `.png` 是渲染产物。** 改图请改 `.mmd`，然后：

```bash
npm i -g @mermaid-js/mermaid-cli   # 首次
bash scripts/render-diagrams.sh          # 全部
bash scripts/render-diagrams.sh tech-03  # 只重渲某一张
```

`.svg` 被 [`ARCH-product.md`](../ARCH-product.md) 和 [`ARCH-technical.md`](../ARCH-technical.md)  
直接引用，GitHub 上能渲染。

> **图里的标注是中文，目前只有这一套。** 四份英文文档（[`README.en.md`](../../README.en.md)、  
> [`VISION.en.md`](../VISION.en.md)、[`ARCH-product.en.md`](../ARCH-product.en.md)、  
> [`ARCH-technical.en.md`](../ARCH-technical.en.md)）引用的是同一批图，  
> 并在文首如实说明了这件事。
>
> **为什么不做英文版**：图是漂移最快的东西 —— 设计一改就得重画。  
> 复制 18 张等于把维护面积翻倍，收益却不如下面这句大：  
> **欢迎只补最常被看到的那一两张。** 改 `.mmd`、重渲、提 PR 就行。

---

## 先看这一张

**[`arch-00-overview`](arch-00-overview.svg) —— 整体架构，一页看全。**

主人 → 微信服务器 → 一个 cordis 容器（产品五层 ↔ 技术部件）→ 模型 / 其他设备。
它回答的是「这产品由哪些东西组成、它们怎么连起来」；下面 17 张是它的展开：
每张只讲一件事，所以改起来便宜。**改细节别动这张；动这张，要回头同步下面几张。**

---

## 产品架构

| 图                        | 内容     | 一句话                          |
| ------------------------ | ------ | ---------------------------- |
| `product-01-context`     | 产品全景   | 主人 / 微信 / 管家 / 模型 / 其他设备 的关系 |
| `product-02-layers`      | 五层能力模型 | 接入 → 对话 → 能力 → 设备 → 信任       |
| `product-03-journey`     | 首次使用旅程 | 从双击到把事办成，标出体验痛点              |
| `product-04-mechanisms`  | 四个核心机制 | 审批 · 记忆 · 主动 · 多设备           |
| `product-05-interaction` | 交互形态   | 发进来什么、回出去什么、逃生舱              |

## 技术架构

| 图                         | 内容         | 一句话                         |
| ------------------------- | ---------- | --------------------------- |
| `tech-01-container`       | 单机容器       | M1 的形态：core 兼 hub 角色，node 角色内嵌同进程 |
| `tech-02-multimachine`    | 多机部署       | 中枢（core）+ 多节点（link-lan/node），跨网走 `ctx.link` |
| `tech-03-seams`           | 包结构与 seam  | seam 包只声明，实现包继承注册           |
| `tech-04-patch-layers`    | 配置分层       | 内置组合 → 用户覆盖 → 运行期状态         |
| `tech-05-seq-inbound`     | 入站回合时序     | 一条消息从微信到结果回来                |
| `tech-06-seq-approval`    | 审批时序       | 要动手前先问，超时 = 拒绝              |
| `tech-07-seq-multidevice` | 跨设备时序      | 别名解析 + 离线就直说                |
| `tech-08-seq-media`       | 收图 / 收文件时序 | CDN 下载 + 两种 aes_key 编码 + 解密 |
| `tech-09-state-approval`  | 审批状态机      | 待决 → 已批准 / 已拒绝              |
| `tech-10-class-seams`     | seam 类图    | 五个抽象基类与各自的实现（channel-feishu 还是候选） |
| `tech-11-er-state`        | 数据模型       | `state/` 下的实体与关系            |
| `tech-12-boot`            | 启动组合       | patch 行怎么变成运行时的 ctx         |

---

## 配色约定

改图时沿用这套，保持全局一致：

| 含义               | 填充        | 描边            |
| ---------------- | --------- | ------------- |
| 人（主人）            | `#FFE7C2` | `#E8A33D`     |
| 核心逻辑（hub / node） | `#D6E8FF` | `#3D7DE8`     |
| seam 接口          | `#EDE0FF` | `#8B5CF6`     |
| 实现               | `#D9F2E3` | `#34A853`     |
| 存储               | `#FFF6D6` | `#D9A400`     |
| 外部系统             | `#F1F3F5` | `#ADB5BD`（虚线） |
| 风险 / 禁止          | `#FFE0E0` | `#E5484D`     |

子图统一中性灰 `fill:#F8F9FA,stroke:#ADB5BD`——  
Mermaid 默认会给每个子图随机上色，那样一张图里颜色是乱的。
