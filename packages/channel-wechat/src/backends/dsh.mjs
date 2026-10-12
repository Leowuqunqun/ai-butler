/**
 * dsh 后端 —— 调用 DSH 本体的 headless agent 当大脑。
 *
 * 为什么用 `--patch`：所有覆盖（模型通道、人格、沙箱）都写在一个 patch 文件里，
 * 通过命令行注入，**不碰任何全局 profile 配置**。换机器只要改这一个文件。
 *
 * ⚠️ 两个必须知道的坑（都踩过，见 README）：
 *
 *  1. **参数顺序**：`--patch` 必须在 `--json` 之前。写成 `dsh --json --patch f.yml`
 *     会直接报 `unknown option '--patch'`。
 *
 *  2. **DSH_HOME 必须隔离**：如果桥和 `dsh web`（GUI）共用同一个 DSH_HOME，
 *     同一个 cwd 会落进同一个 sessions 目录，GUI 会给会话挂上写锁，桥一续接就报
 *     `session "..." is already owned by an active write handle`。
 *     所以这里强制用桥自己私有的 home（配置 agent.dsh.home）。
 *
 * 配置：
 *   "agent": {
 *     "backend": "dsh",
 *     "dsh": {
 *       "bin": "dsh",
 *       "profile": "headless",
 *       "patchFile": "./examples/dsh.patch.yml",
 *       "home": "./dsh-home"        // 留空 = <项目>/dsh-home
 *     }
 *   }
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export default {
  name: 'dsh',

  async run({ text, sessionId, config, workspace, log }) {
    const c = config.agent?.dsh ?? {};
    const bin = c.bin || 'dsh';
    const home = c.home;
    if (!home) return { sessionId, error: 'dsh 后端缺少 agent.dsh.home（应为桥私有的 DSH_HOME 目录）' };
    if (!c.patchFile) return { sessionId, error: 'dsh 后端缺少 agent.dsh.patchFile（模型通道/人格的 patch 文件）' };
    try { mkdirSync(home, { recursive: true }); } catch { /* 已存在 */ }

    // ↓ 顺序是硬要求：--patch 必须在 --json 之前
    const args = ['--profile', c.profile || 'headless', '--patch', c.patchFile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(text);

    const timeoutMs = Number(c.timeoutMs) || config.agentTimeoutMs || 300_000;
    log?.(`dsh: profile=${c.profile || 'headless'} session=${sessionId ?? '(新)'} timeout=${Math.round(timeoutMs / 1000)}s`);

    return await new Promise((resolveP) => {
      const out = { sessionId: sessionId ?? null, text: '', error: null };
      let child;
      try {
        child = spawn(bin, args, {
          cwd: workspace,
          env: { ...process.env, DSH_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return resolveP({ ...out, error: `无法启动 dsh: ${e.message}` });
      }

      let buf = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }, timeoutMs);

      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'session' && ev.sessionId) out.sessionId = ev.sessionId;
          else if (ev.type === 'final' && typeof ev.text === 'string') out.text = ev.text;
          else if (ev.type === 'status' && ev.phase === 'turn_end' && ev.reason?.kind === 'error') {
            out.error = ev.reason.error?.message ?? 'agent 报错';
          }
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (e) => {
        clearTimeout(timer);
        resolveP({ ...out, error: `无法启动 dsh: ${e.message}` });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          return resolveP({
            ...out,
            error: out.error ?? `agent 超时（>${Math.round(timeoutMs / 1000)}s 没跑完，已掐断）`,
          });
        }
        if (!out.text && !out.error && code !== 0) {
          // stderr 里通常混着插件告警，别原样倒进微信，只取最后一行
          const lines = stderr.trim().split('\n').map((s) => s.trim()).filter(Boolean);
          out.error = /already owned by an active write handle/i.test(stderr)
            ? 'SESSION_LOCKED'
            : ((lines[lines.length - 1] ?? '').slice(0, 200) || `dsh 退出码 ${code}`);
        }
        resolveP(out);
      });
    });
  },
};
