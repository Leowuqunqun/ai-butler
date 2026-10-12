/**
 * 「管家自己找得到 butler 吗」—— 一条量**本进程环境里的 PATH** 的判据。
 *
 * ── 为什么这条判据只能住在内核里 ────────────────────────────────
 *
 * 只有**管家自己**知道它那个进程的 PATH 长什么样。装配机器的人（`install.sh`）
 * 看的是另一个进程的环境 —— 在那儿断言"管家找得到自己"是没有意义的。
 * 同理，它也只能在管家进程里被看见：`butler doctor`（问内核的 `check()`）
 * 和微信里的「自检」问的是**同一个** `check()`，所以这里是**一处判据、两处可见**。
 *
 * ── 为什么值得单独查一条 ───────────────────────────────────────
 *
 * 管家干活是在**子 shell** 里。"在微信里跟它说一句、让它自己设开机自启"
 * 走的就是那条路，而那个 shell 继承的正是这个进程的 PATH。PATH 里没有
 * `butler` 时，那条路走到一半会回一句"找不到 butler" —— 对只会用微信的主人
 * 来说，这就等于路断了。
 *
 * 安装器生成的壳脚本会把 `<prefix>/bin` 放进管家自己的 PATH（**只改这一个
 * 进程**，仍然不动用户的 dotfiles）。这一项就是它的判据 —— 它过了，
 * "在微信里让它自己做"才从"也许行"变成"行"。
 *
 * ⚠️ Windows 上还没有安装器（`autostart` 那边也是如实说"还没做"），所以这一条
 * 在那儿会如实报 ✗。**别把它改成"平台不认识就算过"** —— 那正是这份报告最坏
 * 的一种错法：没查成被说成没问题。
 *
 * ⚠️ 开发机 / 测试环境里天然没有 `butler`，所以这一条必然报 ✗ —— 那不是 bug。
 * 各包的用例往 PATH 里放一个**真 shim**（见各自 test/fixtures 里的说明），
 * 但**真正把关的是 `scripts/verify-clean-install.sh`**：它跑在真装出来的进程里。
 *
 * @module @butler/core/butler-path
 */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { HealthCheck } from '@butler/seam-channel';

/** 这一项在人话报告里的名字。**doctor 和微信自检用的是同一条**，别在两处各写一份 */
export const BUTLER_ON_PATH = '管家自己找得到 butler 吗';

/**
 * 在给定的 PATH 里找一个**可执行的普通文件** `butler`，返回它的路径。
 *
 * 故意**不去 spawn 一个进程**（`butler --help` 那种）：自检是只读的、要快，
 * 而且真跑一次等于把管家整个再起一遍。这里只查盘：目录在、文件在、可执行。
 */
export function findButlerOnPath(pathValue: string | undefined = process.env.PATH): string | undefined {
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    // PATH 里空的一段是"当前目录"（历史遗留写法），不是我们铺的路，跳过去
    if (!dir) continue;
    const file = join(dir, 'butler');
    try {
      // 有个**目录**叫 butler 不算数：shell 不会把它当命令
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // 不在这个目录里 / 不是可执行的 —— 都当"这儿没有"，继续往后找
    }
  }
  return undefined;
}

/** 把上面那次查找翻成一条给人看的检查。**没找到时要说清下一步**，不能只有一个 ✗ */
export function butlerOnPathCheck(pathValue: string | undefined = process.env.PATH): HealthCheck {
  const found = findButlerOnPath(pathValue);
  if (found) {
    return {
      name: BUTLER_ON_PATH,
      ok: true,
      detail: `找得到：${found}（所以在微信里让它自己设开机自启，这条路走得通）`,
    };
  }
  return {
    name: BUTLER_ON_PATH,
    ok: false,
    detail: '找不到 —— 它起的子 shell 里没有 butler 这个命令',
    fix: '重跑一次安装器：它生成的壳脚本会把 AI 管家的目录放进管家自己的 PATH'
      + '（只改这个进程，不动你的 dotfiles）',
  };
}
