/**
 * 数据目录（`state/` 的父目录）解析。
 *
 * 为什么单独一个模块：`cli.mjs` 一被 import 就会执行命令（顶层 switch），
 * 没法直接单测。把这套优先级规则抽出来，才能用测试钉住它。
 *
 * ── 要解决的坑 ─────────────────────────────────────────────────
 *
 * 原来写的是 `ROOT = resolve(HERE, '..')`。源码检出里跑没问题，
 * 但包被 `npm i -g` 装进 node_modules 之后：
 *
 *   · state/ 写进 node_modules 里面 —— 下次升级整个目录被替换，配置和登录态全丢
 *   · 系统级 Node（/usr/local/lib/node_modules）下往往**没有写权限**，直接崩
 *
 * 所以规则是：**路径里带 node_modules 就说明是安装态，往用户目录写**。
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** 安装态（而非源码检出）时的默认数据目录 */
export const USER_HOME_DIR = join(homedir(), '.wechat-agent-bridge');

/**
 * 解析数据目录。
 *
 * 优先级从高到低：
 *   1. `--home <dir>` / `--home=<dir>`
 *   2. `WAB_HOME` 环境变量
 *   3. `pkgRoot`（源码检出：state/ 就在仓库里，方便翻）
 *   4. `~/.wechat-agent-bridge`（`pkgRoot` 位于 node_modules 时）
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot 包根目录（`src/` 的上一级）
 * @param {string[]} [opts.argv] 命令行参数（不含 node 与脚本路径）
 * @param {Record<string,string|undefined>} [opts.env] 环境变量
 * @returns {string} 绝对路径
 */
export function resolveHome({ pkgRoot, argv = [], env = {} } = {}) {
  if (typeof pkgRoot !== 'string' || !pkgRoot) {
    throw new TypeError('resolveHome: 必须传 pkgRoot（包根目录）—— 缺了它就没法判断是源码检出还是安装态');
  }
  const root = resolve(pkgRoot);

  // ① --home=<dir>
  const withEq = argv.find((a) => a.startsWith('--home='));
  if (withEq) return resolve(withEq.slice('--home='.length));

  // ② --home <dir>（后面必须真的跟一个值，不能跟上另一个 flag）
  const i = argv.indexOf('--home');
  if (i >= 0) {
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) return resolve(next);
  }

  // ③ WAB_HOME
  if (env.WAB_HOME) return resolve(env.WAB_HOME);

  // ④ 装进 node_modules 就是安装态 —— 绝不能往包目录里写
  if (root.split(sep).includes('node_modules')) return USER_HOME_DIR;

  return root;
}
