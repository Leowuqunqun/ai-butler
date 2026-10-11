/**
 * Agent 后端 —— 本项目唯一需要"插件化"的地方。
 *
 * 桥只负责「微信 ⇄ 文本」这一段；真正干活的那颗大脑是可替换的。
 * 想接自己的 agent（Claude Code、Codex、自研 HTTP 服务、一个 shell 脚本……）
 * 只要按下面的契约写一个模块，然后在配置里指过去：
 *
 *     "agent": { "backend": "./my-backend.mjs" }
 *
 * ── 后端契约 ────────────────────────────────────────────────
 *
 *   export default {
 *     name: 'my-agent',
 *
 *     /**
 *      * @param {object} ctx
 *      * @param {string} ctx.text        用户发来的原始文本
 *      * @param {string|null} ctx.sessionId 上次这条会话返回的 id；首次为 null
 *      * @param {object} ctx.config      桥的完整配置（含 agent.* 与 workspace）
 *      * @param {string} ctx.workspace   agent 应该在哪干活
 *      * @param {(line: string) => void} ctx.log 写进桥的日志
 *      * @returns {Promise<{ sessionId?: string|null, text?: string, error?: string|null }>}
 *      *
 *      * - 返回 text：会被剥掉 Markdown 后发进微信；可以用 [[file:/绝对/路径|配文]] 带附件
 *      * - 返回 sessionId：桥会记住，下次同一用户续接同一个会话
 *      * - 返回 error：会把错误如实转述给用户（不要静默失败）
 *      * - 抛异常 = error
 *      *\/
 *     async run(ctx) { ... }
 *   }
 *
 * 约定：**run 必须是"一问一答"**。桥是串行的（前面一条没跑完不会跑下一条），
 * 所以后端不要自己再开长驻循环。
 */

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内置后端：名字 → 模块文件 */
const BUILTIN = {
  echo: './echo.mjs',
  exec: './exec.mjs',
  dsh: './dsh.mjs',
};

/**
 * 解析并加载后端。
 * @param {string} nameOrPath 内置名（echo/exec/dsh）或模块路径
 * @param {string} root 项目根目录，用于解析相对路径
 * @returns {Promise<{name: string, run: Function}>}
 */
export async function loadBackend(nameOrPath, root) {
  if (!nameOrPath) throw new Error('未配置 agent.backend');
  const key = String(nameOrPath).trim();

  let mod;
  if (BUILTIN[key]) {
    mod = await import(new URL(BUILTIN[key], import.meta.url).href);
  } else {
    const abs = isAbsolute(key) ? key : resolve(root, key);
    mod = await import(pathToFileURL(abs).href);
  }

  const backend = mod.default ?? mod;
  if (typeof backend?.run !== 'function') {
    throw new Error(`后端 ${key} 没导出 run()，不满足契约（见 src/backends/index.mjs 头部注释）`);
  }
  return { name: backend.name ?? key, run: backend.run, ...backend };
}

/** 列出内置后端，供 status 显示 */
export function listBuiltins() {
  return Object.keys(BUILTIN).map((k) => ({ name: k, file: join(HERE, BUILTIN[k].replace('./', '')) }));
}
