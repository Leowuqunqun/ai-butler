/**
 * "探针怎么跑"这件事 —— 单独一个入口，因为**两个包都要用它**，而这个文件不该拖进任何依赖。
 *
 * ── 为什么不是写死 `bash packages/channel-feishu/probe/run.sh` ────────────
 *
 * 那句话**只在源码树里成立**。用 `install.sh` 装的人没有 `packages/`：
 * 它是把 tarball 装进 `~/.butler/prefix` 的。照着提示跑，得到的只会是
 * `No such file or directory` —— **一条用户照着做也做不到的提示，比没有提示更坏**。
 *
 * 所以这里按**自己文件的位置**算（`lib/probe-path.js` → `../probe/smoke.mjs`）：
 * 在源码里算出源码的路径，装完之后算出包内的路径，**同一个式子**。
 *
 * 而且**先确认它真的在**：不在就返回 null，让调用方退到"去开发者后台建应用"那条路。
 * （`package.json` 的 `files` 里必须带着 `probe`，否则装完之后这里永远是 null ——
 *  这条约定有测试守着。）
 *
 * 为什么用 `node <路径> --save` 而不是 `bash probe/run.sh --save`：不依赖 bash，
 * 不依赖可执行位，两个平台都一样。
 *
 * @module @butler/channel-feishu/probe-path
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 探针脚本的绝对路径（**不检查存在**，只算位置） */
export function probePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'probe', 'smoke.mjs');
}

/**
 * 给用户照着敲的那条命令；**探针不在这个安装里就返回 null**。
 *
 * 返回 null 时不要硬提探针 —— 那正是这一路最容易犯的错。
 */
export function probeCommand(): string | null {
  const file = probePath();
  return existsSync(file) ? `node ${file} --save` : null;
}

/**
 * 给用户看的"扫码最省事"那句话 —— **一份文本，两个包共用**（适配层的报错、CLI 的引导页
 * 和凭据提示都指同一件事）。放在这里是为了不让它们各自漂移：一句用户照着敲的话，
 * 抄两遍就迟早有一遍过期。
 */
export function scanHint(): string {
  const probe = probeCommand();
  return probe
    ? `扫码最省事：\`${probe}\``
    : '扫码最省事（这个安装里没带探针，要在源码里跑）：`bash packages/channel-feishu/probe/run.sh --save`';
}
