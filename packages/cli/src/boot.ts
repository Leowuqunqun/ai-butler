/**
 * 把配置变成一个跑起来的 cordis 容器。
 *
 * ── 一条刻意的设计：**装不上不算致命** ────────────────────────────
 *
 * `boot()` 遇到装不上的插件**不抛**，而是收进 `failures` 里继续装下一个。
 * 因为这个函数的两个调用方要的东西不一样：
 *
 *   - `doctor` 要的是"**哪几行有问题**"，一行坏掉不能让它什么都报不出来
 *   - `run` 要的是"到底能不能上线"，它自己看 `failures` 和 `ctx.core` 在不在再决定
 *
 * 所以判断留给调用方，`boot()` 只负责如实汇报。
 *
 * @module @butler/cli/boot
 */

import { Context } from '@deepseek-ai/cordis';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type LoadedConfig, type PluginRow } from './config.js';
import { importPlugin, type ResolveContext } from './resolve.js';
import { installConsoleLog, type LogLevel } from './logging.js';

/** 本包根目录（`lib/` 或 `src/` 的上一层）—— 包名插件从这儿开始找 */
export const SELF_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface BootFailure {
  id: string;
  name: string;
  /** 一句人话，直接可以打给用户看 */
  message: string;
}

export interface BootOptions {
  configPath: string;
  /** 叠加在上面的 patch 文件，后写的赢 */
  patches?: readonly string[];
  /** 覆盖"应用自己的目录"（测试用） */
  selfDir?: string;
  /** 覆盖配置文件所在目录（一般不用） */
  configDir?: string;
  /**
   * 已经读好的行：传了就用它，不再读配置文件。
   *
   * 为什么需要：`run` 必须在**装进容器之前**把通道凭据填进那一行
   * （插件的 config 是构造时读进去的，装上了再改不生效）。
   */
  rows?: PluginRow[];
  /**
   * 插件日志的级别（不给就读 `BUTLER_LOG_LEVEL`，再不给就是 `warn`）。
   * 有它，测试不必去动进程环境变量。
   */
  logLevel?: LogLevel;
}

export interface Booted {
  ctx: Context;
  config: LoadedConfig;
  /** 真的装上了的 */
  loaded: PluginRow[];
  /** 被 disabled 关掉的 */
  disabled: PluginRow[];
  /** 装不上的。**不致命**，交给调用方判断 */
  failures: BootFailure[];
  /**
   * 某个服务位在不在（`ctx.channel` / `ctx.agent` / `ctx.core`……）。
   *
   * ⚠️ 为什么是 `has()` 而不是 `services: string[]`：cordis **没有**暴露
   * "列出所有已注册服务"的公开接口 —— `Object.keys(ctx)` 只有内核自己的那几个字段，
   * `ctx.reflect.store` 也不是可枚举的服务表（都实测过）。
   * 所以这里只提供**问一个具体的名字**这个原语，不假装能枚举。
   *
   * ⚠️ 实现是**取值判断**，不是 `name in ctx`。`in` 在插件卸载之后
   * **依然是 true**（cordis 把属性槽留着了），拿它判断"服务在不在"
   * 会在卸载后给出过期答案 —— 实测过，别换回去。
   */
  has(name: string): boolean;
  dispose(): Promise<void>;
}

export async function boot(options: BootOptions): Promise<Booted> {
  const config = loadConfig(options.configPath, options.patches ?? []);
  // 调用方给的行优先（它可能在读完之后填了凭据）
  if (options.rows) config.rows = options.rows;
  const resolveCtx: ResolveContext = {
    configDir: options.configDir ?? dirname(options.configPath),
    selfDir: options.selfDir ?? SELF_DIR,
  };

  const ctx = new Context();
  // 插件自己的日志得能到终端上。Cordis 内建那个 exporter 只往内存里塞、从不打印，
  // 于是 `feishu: 上线了…`、官方 SDK 报的错全进了一个没人看的缓冲 —— 见 logging.ts。
  installConsoleLog(ctx, options.logLevel ? { BUTLER_LOG_LEVEL: options.logLevel } : process.env);
  const loaded: PluginRow[] = [];
  const failures: BootFailure[] = [];

  for (const row of config.rows) {
    try {
      const plugin = await importPlugin(row.name, resolveCtx);
      // ⚠️ `ctx.plugin()` 返回的是 cordis 的 **Fiber**（只是个 thenable），
      // 不是真 Promise —— 直接 `await` 可以，但别把它当 Promise 传给别人
      await ctx.plugin(plugin as never, (row.config ?? {}) as never);
      loaded.push(row);
    } catch (error) {
      failures.push({ id: row.id, name: row.name, message: oneLine(error) });
    }
  }

  return {
    ctx,
    config,
    loaded,
    disabled: config.disabled,
    failures,
    has: (name: string) => (ctx as unknown as Record<string, unknown>)[name] !== undefined,
    async dispose() {
      await ctx.fiber.dispose();
    },
  };
}

/** 把多层嵌套的错误压成一行 —— 打给用户看的东西不该是一棵栈 */
function oneLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n').map((s) => s.trim()).filter(Boolean).join(' ').slice(0, 400);
}
