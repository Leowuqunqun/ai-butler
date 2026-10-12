/**
 * `ctx.agent` 的实现：把问题交给**任意「一问一答」的命令行程序**，用它的 stdout 当回答。
 *
 * 适合这些场景：
 *   - 你自己包的一个脚本
 *   - 另一个 agent CLI（Claude Code、aider……）
 *   - 一个 curl 封装
 *   - 任何没有 Node SDK 的东西
 *
 * 它也是 `ctx.agent` 这个能力位的**第二个实现**。第二个实现存在的意义是
 * 检验契约：如果契约是照着 dsh 量身定做的，这里就会别扭。
 *
 * ── 一个刻意的限制：没有会话概念 ─────────────────────────────────
 *
 * 每次都是一次性调用，返回的 `sessionId` 恒为 `null`。
 * 如果你的 CLI 支持续接会话，**别硬塞进这个实现**——自己写一个实现包更合适。
 * 契约里的 `sessionId` 是可选的，不需要它的实现直接返回 `null` 就行。
 *
 * @module @butler/agent-exec
 */

import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import type { AgentRequest, AgentResult, HealthCheck } from '@butler/seam-agent';

export interface ExecAgentConfig {
  /** **必填**：完整命令行。问题会被接到末尾（`input: 'arg'`）或写进标准输入（`input: 'stdin'`） */
  argv: string[];
  /** `arg` = 问题当最后一个参数；`stdin` = 写进标准输入 */
  input: 'arg' | 'stdin';
  /** 单轮上限。到点 SIGKILL */
  timeoutMs: number;
  /** 在哪跑。留空 = 用请求里的 `cwd` */
  cwd: string;
}

export class ExecAgent extends AgentService {
  static Config = z.object({
    argv: z.array(z.string()).default([]),
    input: z.string().default('arg'),
    timeoutMs: z.number().default(300_000),
    cwd: z.string().default(''),
  });

  readonly id = 'exec';
  override readonly label = '任意命令行';
  override readonly cancellable = true;

  constructor(ctx: Context, readonly config: ExecAgentConfig) {
    super(ctx);

    // schemastery 不会拒绝缺字段，必填项自己校验（理由见 agent-dsh 的 README 第 3 条）
    if (!Array.isArray(this.config.argv) || this.config.argv.length === 0) {
      throw new Error('exec agent 缺少必填配置：argv（要跑的命令行，数组形式，例如 ["my-agent", "--quiet"]）');
    }
    if (this.config.input !== 'arg' && this.config.input !== 'stdin') {
      throw new Error(`exec agent 的 input 只能是 'arg' 或 'stdin'，收到 ${JSON.stringify(this.config.input)}`);
    }
    if (this.config.timeoutMs <= 0) throw new Error('exec agent 的 timeoutMs 必须大于 0');
  }

  /**
   * 自检 —— 只查 `argv[0]` 在不在、能不能执行。
   *
   * 这一个检查就覆盖了这个实现最常见的失败：用户抄了一行命令，
   * 但那个程序没装、或者不在这台机器的 PATH 里。
   */
  override check(): HealthCheck[] {
    const bin = this.config.argv[0] ?? '';
    const found = which(bin);
    const mode = this.config.input === 'stdin' ? '问题走标准输入' : '问题当最后一个参数';
    return [found
      ? { name: '要跑的程序', ok: true, detail: `${found}（${mode}）` }
      : {
        name: '要跑的程序',
        ok: false,
        detail: `找不到 ${bin || '(argv 是空的)'}`,
        fix: '确认这个程序装好了；不在 PATH 里的话，argv 的第一项写它的绝对路径',
      }];
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    const { argv, input, timeoutMs, cwd } = this.config;
    const [bin, ...rest] = argv;
    const args = input === 'arg' ? [...rest, req.text] : rest;
    const where = cwd || req.cwd;

    this.ctx.logger?.info?.(
      '[agent-exec] %s %s（input=%s 上限=%ds cwd=%s）',
      bin, args.slice(0, 4).join(' '), input, Math.round(timeoutMs / 1000), where,
    );

    return await new Promise<AgentResult>((resolve) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;
      const finish = (r: AgentResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };

      try {
        child = spawn(bin!, args, {
          cwd: where,
          env: process.env,
          stdio: [input === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({ sessionId: null, error: `无法启动 ${bin}：${errMsg(error)}` });
        return;
      }

      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* 已经退出了 */ }
      }, timeoutMs);

      const onAbort = (): void => {
        aborted = true;
        try { child.kill('SIGKILL'); } catch { /* 已经退出了 */ }
      };
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener('abort', onAbort, { once: true });

      let out = '';
      let err = '';

      if (input === 'stdin') {
        // 子进程可能没读 stdin 就退了 —— 那样写会拿到 EPIPE，不该因此炸掉
        child.stdin?.on('error', () => { /* 忽略 */ });
        child.stdin?.end(req.text, 'utf8');
      }
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });

      child.on('error', (error) => {
        finish({ sessionId: null, error: `无法启动 ${bin}：${errMsg(error)}` });
      });

      child.on('close', (code) => {
        if (aborted) {
          finish({ sessionId: null, error: '已取消' });
          return;
        }
        if (timedOut) {
          finish({ sessionId: null, error: `命令超时（>${Math.round(timeoutMs / 1000)}s 没跑完，已掐断）` });
          return;
        }
        // 约定：有 stdout 就用 stdout 当回答，哪怕退出码非零 ——
        // 很多 CLI 会"边输出边以非零码退出"，那也还是有话要说
        const body = out.trim();
        if (body) {
          finish({ sessionId: null, text: body });
          return;
        }
        if (code === 0) {
          finish({ sessionId: null, text: '' });   // 说完了但没内容 —— 交给核心层说"没出结果"
          return;
        }
        const lines = err.trim().split('\n').map((s) => s.trim()).filter(Boolean);
        finish({
          sessionId: null,
          error: (lines[lines.length - 1] ?? '').slice(0, 300) || `${bin} 退出码 ${code}`,
        });
      });
    });
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default ExecAgent;

/** 在 PATH 里找可执行文件。给绝对路径就直接看它在不在 */
function which(bin: string): string | null {
  if (!bin) return null;
  if (isAbsolute(bin) || bin.includes('/')) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch { return null; }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* 这一项不行，看下一个 */ }
  }
  return null;
}
