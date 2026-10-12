/**
 * 给测试环境的 PATH 造一个**真 shim** 的 `butler`。
 *
 * ── 为什么不干脆"跳过那一项检查" ────────────────────────────────
 *
 * 内核自检里有一条量**环境里的 PATH** 的判据（"管家自己找得到 butler 吗"）。
 * 开发机 / 测试环境里没有 butler，所以它必然报 ✗ —— 而 ✗ 不是这里要测的东西。
 *
 * **换地方不解决问题**：挪到内核自检，红的是 core 的用例；挪到 CLI，红的是 cli 的。
 * 正确做法是**改环境、不改判据**：往 PATH 里放一个真的可执行文件。
 *
 * ⚠️ **这里造绿不算数。** 真正把关的是 `scripts/verify-clean-install.sh` ——
 * 它跑在**真装出来的**进程里（`install.sh` 生成的壳脚本把 `<prefix>/bin` 放进了
 * 管家自己的 PATH）。
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

let shimDir = '';

/**
 * 往 PATH 最前面放一个可执行的 `butler`。同一个进程里调多次只造一次。
 * 返回那个文件的路径（用例可以直接断言"找到的就是它"）。
 *
 * `runSync` / `runAsync` 会把 `process.env` 整个传给子进程，所以在这里铺一次，
 * 真起出来的 `butler doctor` 也看得见 —— 跟装好的机器上一样。
 */
export function useButlerShim() {
  if (!shimDir) {
    shimDir = mkdtempSync(join(tmpdir(), 'butler-shim-'));
    const file = join(shimDir, 'butler');
    writeFileSync(file, '#!/bin/sh\n# 测试用 shim：只用来证明"PATH 里有这个命令"\necho "butler (test shim) $*"\n');
    chmodSync(file, 0o755);
    process.on('exit', () => rmSync(shimDir, { recursive: true, force: true }));
  }
  const path = process.env.PATH ?? '';
  if (path.split(delimiter)[0] !== shimDir) {
    process.env.PATH = path ? `${shimDir}${delimiter}${path}` : shimDir;
  }
  return join(shimDir, 'butler');
}

/** 临时把 PATH 变成"一个没有 butler 的目录"，跑完自动还原（✗ 那条用例造环境用） */
export async function withoutButler(fn) {
  const empty = mkdtempSync(join(tmpdir(), 'butler-no-'));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
    rmSync(empty, { recursive: true, force: true });
  }
}
