/**
 * exec 后端 —— 把问题交给任意命令行程序，用它的 stdout 当回答。
 *
 * 适合已经有一个"一问一答"式 CLI 的场景（自己包的脚本、别的 agent CLI、
 * 一个 curl 封装……）。也可以拿它当适配器去接没有 Node SDK 的东西。
 *
 * 配置：
 *   "agent": {
 *     "backend": "exec",
 *     "exec": {
 *       "argv": ["/usr/local/bin/my-agent", "--quiet"],
 *       "input": "arg",          // arg = 把问题作为最后一个参数；stdin = 写进标准输入
 *       "timeoutMs": 300000,
 *       "cwd": null              // 默认用桥的 workspace
 *     }
 *   }
 *
 * 注意：exec 后端**无会话概念**（每次都是一次性调用），返回的 sessionId 恒为 null。
 * 如果你的 CLI 支持续接会话，自己写一个后端模块更合适（见 backends/index.mjs 契约）。
 */

import { spawn } from 'node:child_process';

export default {
  name: 'exec',

  async run({ text, config, workspace, log }) {
    const c = config.agent?.exec ?? {};
    const argv = Array.isArray(c.argv) ? c.argv : [];
    if (!argv.length) {
      return { sessionId: null, error: 'exec 后端没配 agent.exec.argv，没程序可跑' };
    }
    const mode = c.input === 'stdin' ? 'stdin' : 'arg';
    const timeoutMs = Number(c.timeoutMs) || config.agentTimeoutMs || 300_000;
    const cwd = c.cwd || workspace;

    const [bin, ...rest] = argv;
    const args = mode === 'arg' ? [...rest, text] : rest;
    log?.(`exec: ${bin} ${args.slice(0, 3).join(' ')}${args.length > 3 ? ' …' : ''} (input=${mode})`);

    return await new Promise((resolveP) => {
      let child;
      try {
        child = spawn(bin, args, {
          cwd,
          env: process.env,
          stdio: [mode === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return resolveP({ sessionId: null, error: `无法启动 ${bin}: ${e.message}` });
      }

      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }, timeoutMs);

      if (mode === 'stdin') {
        child.stdin.on('error', () => {});
        child.stdin.end(text, 'utf8');
      }
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({ sessionId: null, error: `无法启动 ${bin}: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const body = out.trim();
        if (body) return resolveP({ sessionId: null, text: body });
        if (code === 0) return resolveP({ sessionId: null, text: '' });
        const lines = err.trim().split('\n').map((s) => s.trim()).filter(Boolean);
        resolveP({
          sessionId: null,
          error: (lines[lines.length - 1] ?? '').slice(0, 300) || `${bin} 退出码 ${code}`,
        });
      });
    });
  },
};
