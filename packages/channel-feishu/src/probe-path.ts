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
 * ── 为什么命令里要带 `--home=` ──────────────────────────────────────
 *
 * 凭据按**配置所在目录**找：`butler init --config /别处/config.json` 的家庭就在 `/别处`，
 * CLI 去 `/别处/state/secrets.json` 读。而探针默认往 `~/.butler` 写 —— 于是用户扫码、
 * 探针说"存好了"，`butler run` 还是问他要 app_id。两个包各自的测试都是绿的，
 * 合起来却不通：这条路上最难查的故障。**家不在默认位置时，那条命令必须自己带上 `--home=`。**
 *
 * @module @butler/channel-feishu/probe-path
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 探针脚本的绝对路径（**不检查存在**，只算位置） */
export function probePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'probe', 'smoke.mjs');
}

/**
 * 默认的管家目录：`$BUTLER_HOME` > `~/.butler`。
 *
 * 四处必须是同一条约定（探针的 `homeOf`、CLI 的一切默认路径 —— 见 `butlerHome()`、
 * 这里、以及生成的通道行里的 `home`）—— `packages/cli/test/probe-contract.mjs`
 * 把它们真的凑在一起跑一遍。
 *
 * ⚠️ `BUTLER_HOME` 是第 37 轮补上的：探针一直认它，另外几处不认，于是设了它的人会看到
 * "探针说存好了，`butler run` 却说还没有 app_id"。**别只改这一处** —— 改的是那条规则。
 */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env.BUTLER_HOME ?? '').trim();
  return fromEnv || join(homedir(), '.butler');
}

/** 这个管家目录是不是默认那个（是的话，命令里不必加 `--home=`，保持最短） */
export function isDefaultHome(butlerDir: string): boolean {
  return resolve(butlerDir) === resolve(defaultHome());
}

/** 拼进命令里的 `--home=<路径>`：带引号，路径里有空格或 `"` `$` 反引号也不会散架 */
function homeFlag(butlerDir: string): string {
  return ` --home="${butlerDir.replace(/([\\"$`])/g, '\\$1')}"`;
}

/**
 * 给用户照着敲的那条命令；**探针不在这个安装里就返回 null**。
 *
 * 传了管家目录、且不在默认位置时，命令会带上 `--home=` —— 不然存到別处，
 * 用户会看见"探针说存好了，`butler run` 却说还没有 app_id"。
 *
 * ⚠️ `butlerDir` **必填**（第 35 轮改的）：它原来是可选的，于是三个调用点漏传了它，
 * TypeScript 一声没吭 —— 而漏传的后果正是上面那句话描述的事（`doctor` 和 `init` 引导
 * 里给出的命令都没带 `--home=`）。必填之后，编译器会替我们盯住每一个调用点。
 *
 * 返回 null 时不要硬提探针 —— 那正是这一路最容易犯的错。
 */
export function probeCommand(butlerDir: string): string | null {
  const file = probePath();
  if (!existsSync(file)) return null;
  const flag = isDefaultHome(butlerDir) ? '' : homeFlag(butlerDir);
  return `node ${file} --save${flag}`;
}

/**
 * 给用户看的"扫码最省事"那句话 —— **一份文本，两个包共用**（适配层的报错、CLI 的引导页
 * 和凭据提示都指同一件事）。放在这里是为了不让它们各自漂移：一句用户照着敲的话，
 * 抄两遍就迟早有一遍过期。
 *
 * ⚠️ 和 `probeCommand` 一样，`butlerDir` 必填 —— 它就是为"漏传会静默存错地方"这一课加的。
 */
export function scanHint(butlerDir: string): string {
  const probe = probeCommand(butlerDir);
  return probe
    ? `扫码最省事：\`${probe}\``
    : '扫码最省事（这个安装里没带探针，要在源码里跑）：`bash packages/channel-feishu/probe/run.sh --save`';
}
