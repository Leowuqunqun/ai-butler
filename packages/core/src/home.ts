/**
 * 「管家自己的家在哪儿」—— **一条规则，一个式子**。
 *
 * `$BUTLER_HOME`（去掉两头空白；空串 / 全空白 = 没设）> `~/.butler`。
 *
 * ── 为什么值得单独一个文件 ────────────────────────────────────
 *
 * 这条例子的另一头是**用户看到的承诺**：探针说"凭据存好了，`butler run` 直接用"。
 * 只要**有任何一个**算管家目录的地方不认 `BUTLER_HOME`，那句承诺在他那儿就是假的 ——
 * 现象正是"探针说存好了，`butler run` 却说还没有 app_id"，而两边看起来都没问题，
 * 是最难查的一类。第 37 轮补齐了 CLI / 探针那几处，第 42 轮补上内核和几个叶子包。
 *
 * ⚠️ **叶子包（`memory-file`、`link-lan`、`approval-im`、两个通道）故意不引这个模块**：
 *    它们是 leaf，各自只写一行同样的式子，靠 `packages/cli/test/home-contract.mjs`
 *    把"所有算管家目录的地方"凑在一起真跑一遍。**共享代码不是这儿的解药，能跑出一条
 *    红的契约才是** —— 契约红了，是某个地方漂了；共享了但没人跑，是九处一起漂。
 *
 * ⚠️ **别把它写成常量**：`BUTLER_HOME` 可能在 import 之后才被设上（测试就是这么做的），
 *    常量在 import 那一刻就把家定死了，后面读到的还是旧的那个（第 37 轮的教训）。
 *
 * @module @butler/core/home
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 管家目录：`$BUTLER_HOME` > `~/.butler`。 */
export function butlerHome(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BUTLER_HOME ?? '').trim() || join(homedir(), '.butler');
}
