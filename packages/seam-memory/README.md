# @butler/seam-memory

记忆能力位 —— `ctx.memory`。**只声明接口，不实现。**

## 契约

```ts
abstract class MemoryService extends Service {
  abstract readonly id: string;                                  // 'file' / 'sqlite' / …
  abstract get(key: string): Promise<unknown>;                   // 没记住 → undefined，**不抛**
  abstract set(key: string, value: unknown, meta?: MemoryMeta): Promise<void>;   // 同 key = 覆盖
  abstract list(filter?: MemoryFilter): Promise<MemoryEntry[]>;  // **新的在前**
  abstract forget(key: string): Promise<void>;                   // 幂等
}
```

三类的分法（`MemoryKind`）是**产品决定**，不是技术口味：

| kind | 什么算 | 谁能写 |
| --- | --- | --- |
| `preference` | "简历都放 Documents/简历/" | 主人明说，或问了之后他确认（**缺省**） |
| `fact` | "我的工作目录是 ~/work" | 可以自动提取 |
| `grant` | "整理下载文件夹不用问" | **只在主人明确同意后** |

`grant` 单独一类，因为它等于**放宽权限** —— 跟偏好混在一起等于把权限藏在"记性"里。

## 接自己的存储

```ts
import { MemoryService } from '@butler/seam-memory';

export default class MyMemory extends MemoryService {
  static Config = z.object({ /* 你的配置 */ }).description('…');
  readonly id = 'my-store';
  async get(key) { /* … */ }
  async set(key, value, meta) { /* … */ }
  async list(filter) { /* … */ }
  async forget(key) { /* … */ }
}
```

⚠️ 存的内容**含隐私**（"我的工作目录是…"）。实现包至少要做到：
目录 `0700`、文件 `0600`、**别把 value 打进日志**、原子写。

## 为什么它是个能力位

起步 JSON 文件、记忆多了换 SQLite（见 `docs/ARCH-technical.md` 的存储一节）——
**已经看得见第二个实现**，所以它够格做 seam。这也是这个项目一直守的那条：
只有一个实现的时候不做抽象。第一个实现是 [`@butler/memory-file`](../memory-file)。
