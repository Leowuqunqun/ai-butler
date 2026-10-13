/**
 * 探针里"凭据落到哪、怎么落"这件事。
 *
 * ── 为什么值得单独一个文件 ────────────────────────────────────
 *
 * 这条路的**唯一产出**就是那个文件：`<管家目录>/state/secrets.json`。它写不对，
 * 用户就会看到"探针说存好了，`butler run` 却说还没有 app_id" —— 而两边各自的测试
 * 都是绿的（探针没测试，CLI 只测自己读的那一半）。
 *
 * 所以这里把它抽出来，让**写的那一半也能被测**（见 `test/probe.mjs`）。
 * 抽出来不破坏探针"只用官方包"的定位：它依旧只用 node 内建，不 import 我们包的代码。
 *
 * @module @butler/channel-feishu/probe/save
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 管家目录：`--home=` > `BUTLER_HOME` > `~/.butler`。
 *
 * `--home=` 是给"用 `--config` 把家安在别处"的人准备的 —— 凭据按**配置所在目录**找，
 * 探针存错地方是这一路上最常见的坑（错误信息里会打印它去哪儿找过）。
 */
export function homeOf(argv = process.argv, env = process.env) {
  const flag = argv.find((a) => a.startsWith('--home='))?.slice('--home='.length);
  return flag || env.BUTLER_HOME || join(homedir(), '.butler');
}

/** 凭据文件在哪。和 CLI 的 `secretsFileOf` 是同一条约定（`<管家目录>/state/secrets.json`） */
export function secretsFileOf(home) {
  return join(home, 'state', 'secrets.json');
}

/**
 * 把凭据写进管家认的那个文件，格式 `channels.<通道>.<字段>`。
 *
 * 规矩照抄 `packages/cli/src/secrets.ts` 的：**合并写**（不碰别人的 token）、
 * **先临时文件再 rename**（断电不会留半个 JSON）、**0600**。
 * 这里刻意**不打印凭据本身** —— 要看就去那个文件里看，别把它留在滚动的终端里。
 *
 * 坏文件（半个 JSON、形状不对）会被**覆盖**成新的 —— 这正是我们想要的：
 * 它已经没用了，而"因为一个坏文件就再也存不进凭据"是更难查的故障。
 */
export function saveCreds(home, appId, appSecret, channel = 'feishu') {
  const file = secretsFileOf(home);
  let all = { version: 1, channels: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.channels) all = parsed;
  } catch {
    // 没有、或者坏了 —— 新建一个
  }
  all.channels = { ...(all.channels ?? {}), [channel]: { appId, appSecret } };

  mkdirSync(join(home, 'state'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}
