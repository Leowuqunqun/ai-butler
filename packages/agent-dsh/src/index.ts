/**
 * `ctx.agent` 的实现：把 DSH 本体的 headless agent 当成干活的大脑。
 *
 * ── 为什么用 `--patch` ───────────────────────────────────────────
 *
 * 所有覆盖（模型通道、人格、沙箱）都写在一个 patch 文件里，通过命令行注入，
 * **不碰任何全局 profile 配置**。换机器只要改这一个文件。
 *
 * ── 两个必填项和两个踩过的坑 ─────────────────────────────────────
 *
 * 1. **`--patch` 必须在 `--json` 之前。** 写成 `dsh --json --patch f.yml`
 *    会直接报 `unknown option '--patch'`。
 *
 * 2. **`DSH_HOME` 必须隔离。** 如果管家和 `dsh web`（GUI）共用同一个
 *    `DSH_HOME`，同一个 cwd 会落进同一个 sessions 目录，GUI 会给会话挂上写锁，
 *    续接时就会报 `session "..." is already owned by an active write handle`。
 *    所以这里强制用管家自己私有的 home。
 *    （这条错误会被识别成 `SESSION_LOCKED`，核心层会丢掉旧会话重试一次。）
 *
 * @module @butler/agent-dsh
 */

import { spawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { isAbsolute, resolve as pathResolve, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import type { AgentRequest, AgentResult, HealthCheck } from '@butler/seam-agent';

export interface DshAgentConfig {
  /** dsh 可执行文件。默认从 PATH 里找 */
  bin: string;
  /** 用哪个 profile。headless 是给"没人看着"的场景用的 */
  profile: string;
  /** **必填**：模型通道 / 人格所在的 patch 文件 */
  patchFile: string;
  /** **必填**：管家私有的 DSH_HOME，绝不能和 dsh web 共用 */
  home: string;
  /** 单轮上限。到点 SIGKILL，别让用户无限等 */
  timeoutMs: number;
}

/** headless agent 吐出来的 NDJSON 事件（实测形状，见 dsh-headless 的 json-stream） */
type DshEvent =
  | { type: 'session'; sessionId?: string; cwd?: string }
  | { type: 'status'; phase?: string; reason?: { kind?: string; error?: { message?: string } } }
  | { type: 'thinking'; text?: string }
  | { type: 'text'; text?: string }
  | { type: 'tool_call'; callId?: string; tool?: string; input?: unknown }
  | { type: 'tool_result'; callId?: string; status?: string; result?: string }
  | { type: 'final'; text?: string };

export class DshAgent extends AgentService {
  // 这两个不给默认值，但**别指望编译期能拦住漏配**（实测过，见 README 第 3 条）：
  // schemastery 的 Schema 可调用，满足 cordis 的 `Plugin.Transform`，
  // 所以 `static Config` 确实是 `ctx.plugin()` 的类型来源 —— 但它推断出的类型
  // 含 `undefined`，而 cordis 的 `Spread` 见 `undefined` 就把配置参数判成可选。
  // 结论：`ctx.plugin(DshAgent, {})` 编译得过。拦漏配的是下面构造函数里的运行时校验。
  static Config = z.object({
    bin: z.string().default('dsh'),
    profile: z.string().default('headless'),
    patchFile: z.string(),
    home: z.string(),
    timeoutMs: z.number().default(300_000),
  });

  readonly id = 'dsh';
  override readonly label = 'DSH headless agent';
  override readonly cancellable = true;

  constructor(ctx: Context, readonly config: DshAgentConfig) {
    super(ctx);

    // ⚠️ schemastery **不会**拒绝缺字段：`z.object({a: z.string()})` 传 `{}`
    // 会静悄悄给你一个没有 a 的对象。所以必填项必须自己校验——
    // 不校验的话，错误会拖到用户第一次发消息时才炸，而且炸得莫名其妙。
    const missing = (['patchFile', 'home'] as const).filter((k) => !this.config[k]);
    if (missing.length) {
      throw new Error(
        `dsh agent 缺少必填配置：${missing.join('、')}`
        + `（patchFile 是模型通道/人格所在的 patch 文件；home 是管家私有的 DSH_HOME）`,
      );
    }
    if (this.config.timeoutMs <= 0) throw new Error('dsh agent 的 timeoutMs 必须大于 0');

    // ⚠️ 两个路径**当场钉成绝对的**。不钉的话，相对路径会跟着**每个任务的 cwd**
    // 漂移 —— 用户在 /a 下发消息能跑，换到 /b 就报"patch 文件不存在"，
    // 而且报错看着毫无道理（配置一个字没改）。
    this.patchFile = isAbsolute(this.config.patchFile)
      ? this.config.patchFile
      : pathResolve(process.cwd(), this.config.patchFile);
    this.home = isAbsolute(this.config.home)
      ? this.config.home
      : pathResolve(process.cwd(), this.config.home);
  }

  /** 已解析成绝对路径的 patch 文件 */
  readonly patchFile: string;
  /** 已解析成绝对路径的私有 DSH_HOME */
  readonly home: string;

  /**
   * 自检 —— 只查前置条件，**不跑 dsh**（自检不该花几十秒、也不该产生副作用）。
   *
   * 这里三项正好覆盖了新手最常见的三种"发了消息没反应"。
   */
  override check(): HealthCheck[] {
    const out: HealthCheck[] = [];

    // ① dsh 在不在。找不到是最常见的一种，而且报错信息通常很难懂
    const found = which(this.config.bin);
    out.push(found
      ? { name: 'dsh 可执行文件', ok: true, detail: found }
      : {
        name: 'dsh 可执行文件',
        ok: false,
        detail: `找不到 ${this.config.bin}`,
        fix: '先装上 dsh，或者把配置里的 bin 改成它的绝对路径',
      });

    // ② patch 文件在不在。模型通道和人格都写在里面，没有它 dsh 起不来
    out.push(existsSync(this.patchFile)
      ? { name: 'dsh patch 文件', ok: true, detail: this.patchFile }
      : {
        name: 'dsh patch 文件',
        ok: false,
        detail: `${this.patchFile} 不存在`,
        fix: '这个文件里写着模型通道和人格，缺了它干不了活；把配置里的 patchFile 指对',
      });

    // ③ 私有 DSH_HOME。**跟 dsh web 共用会撞写锁**，所以这里专门拦一下
    const sameAsGlobal = pathResolve(this.home) === pathResolve(join(homedir(), '.dsh'));
    if (sameAsGlobal) {
      out.push({
        name: 'dsh 私有数据目录',
        ok: false,
        detail: `${this.home} 跟 dsh 自己的目录是同一个`,
        fix: '换一个目录。共用会跟 dsh web 抢同一个会话的写锁，续接时会报「已被占用」',
      });
    } else {
      const parent = pathResolve(this.home, '..');
      const ok = existsSync(this.home) || existsSync(parent);
      out.push(ok
        ? { name: 'dsh 私有数据目录', ok: true, detail: this.home }
        : {
          name: 'dsh 私有数据目录',
          ok: false,
          detail: `${parent} 不存在`,
          fix: '把它上一级目录建出来，或者把配置里的 home 指到别处',
        });
    }

    return out;
  }

  async run(req: AgentRequest): Promise<AgentResult> {
    // 路径用构造函数里钉好的绝对版本，不用 config 里的原始值（可能是相对的）
    const { bin, profile, timeoutMs } = this.config;
    const patchFile = this.patchFile;
    const home = this.home;
    try {
      mkdirSync(home, { recursive: true });
    } catch { /* 已存在 */ }

    // ↓ 顺序是硬要求：--patch 必须在 --json 之前
    const args = ['--profile', profile, '--patch', patchFile, '--json'];
    if (req.sessionId) args.push('--session-id', req.sessionId);
    args.push(req.text);

    const started = Date.now();
    this.ctx.logger?.info?.(
      '[agent-dsh] 启动：profile=%s session=%s 上限=%ds cwd=%s',
      profile, req.sessionId ?? '(新)', Math.round(timeoutMs / 1000), req.cwd,
    );
    // ⚠️ 启动细节**只进日志，不进 onProgress**。
    // onProgress 是给用户看的；"启动 dsh（上限 300s）"这种话是开发者语言，
    // 漏进聊天窗口只会让人困惑。（这是端到端测试抓到的，不是设想。）

    return await new Promise<AgentResult>((resolve) => {
      const out: AgentResult = { sessionId: req.sessionId ?? null, text: '', error: null };
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
        child = spawn(bin, args, {
          cwd: req.cwd,
          env: { ...process.env, DSH_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({ ...out, error: `无法启动 dsh：${errMsg(error)}` });
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

      let buf = '';
      let stderr = '';
      // tool_result 事件里**没有**工具名，只有 callId，所以得自己记一张表
      const calls = new Map<string, string>();

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let ev: DshEvent;
          try { ev = JSON.parse(line) as DshEvent; } catch { continue; }   // 非 JSON 行直接跳过
          this.consume(ev, out, req, calls);
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        finish({ ...out, error: `无法启动 dsh：${errMsg(error)}` });
      });

      child.on('close', (code) => {
        const secs = Math.round((Date.now() - started) / 1000);
        if (aborted) {
          finish({ ...out, error: `已取消（跑了 ${secs}s）` });
          return;
        }
        if (timedOut) {
          finish({
            ...out,
            error: out.error ?? `agent 超时（>${Math.round(timeoutMs / 1000)}s 没跑完，已掐断）`,
          });
          return;
        }
        if (!out.text && !out.error && code !== 0) {
          // stderr 里通常混着插件告警，别原样倒进微信，只取最后一行
          const lines = stderr.trim().split('\n').map((s) => s.trim()).filter(Boolean);
          const tail = (lines[lines.length - 1] ?? '').slice(0, 200);
          if (/already owned by an active write handle/i.test(stderr)) {
            finish({
              ...out,
              error: '会话被别的进程占着（同一个会话有活跃的写句柄）',
              code: 'SESSION_LOCKED',
            });
            return;
          }
          finish({ ...out, error: tail || `dsh 退出码 ${code}` });
          return;
        }
        finish(out);
      });
    });
  }

  /** 消化一个 NDJSON 事件。**只认实测见过的字段**，多出来的一律忽略 */
  private consume(ev: DshEvent, out: AgentResult, req: AgentRequest, calls: Map<string, string>): void {
    switch (ev.type) {
      case 'session':
        if (typeof ev.sessionId === 'string' && ev.sessionId) out.sessionId = ev.sessionId;
        return;
      case 'final':
        if (typeof ev.text === 'string') out.text = ev.text;
        return;
      case 'status':
        if (ev.phase === 'turn_end' && ev.reason?.kind === 'error') {
          out.error = ev.reason.error?.message ?? 'agent 报错';
        }
        return;
      case 'tool_call': {
        const tool = ev.tool ?? '工具';
        if (ev.callId) calls.set(ev.callId, tool);
        // 这一条是**给用户看的**：agent 跑几分钟的时候，
        // "它在干什么"比"还在等"有用得多（实测过：不报进度时用户只看到没反应）
        this.report(req, `🔧 ${tool} ${compact(ev.input)}`);
        return;
      }
      case 'tool_result': {
        if (ev.status !== 'error') return;
        // 工具名只能从刚才那张表里查
        this.report(req, `⚠️ ${(ev.callId && calls.get(ev.callId)) || '工具'} 失败了`);
        return;
      }
      default:
        return;   // thinking / text 会刷屏，不外传
    }
  }

  private report(req: AgentRequest, line: string): void {
    this.ctx.logger?.debug?.('[agent-dsh] %s', line);
    req.onProgress?.(line);
  }
}

/** 把工具入参压成一行短的，别把整个 JSON 灌进聊天窗口 */
function compact(input: unknown, max = 60): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return trunc(input, max);
  try {
    const s = JSON.stringify(input);
    return s === '{}' ? '' : trunc(s, max);
  } catch {
    return '';
  }
}

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default DshAgent;

/** 在 PATH 里找可执行文件。给绝对路径就直接看它在不在 */
function which(bin: string): string | null {
  if (isAbsolute(bin) || bin.includes('/')) return existsSync(bin) ? bin : null;
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
