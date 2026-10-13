/**
 * 插件自己的日志（`ctx.logger.*`）往哪儿去。
 *
 * ⚠️ 这一块本来是个**哑洞**（第 46 轮实测，不是推理）：
 *
 * Cordis 的 `Context` 一建起来就替 `ctx.logger` 装了一个默认 exporter，而它只做一件事 ——
 * `this.buffer.push(message)`（上限 1000 条的环形缓冲），**从不打印，也没有任何人去读它**
 * （`@deepseek-ai/cordis` 的 `lib/index.js` 里，`bufferSize = 1e3` 那段就是它）。
 *
 * 于是这些行全部进了一个没人看的缓冲：
 *   · `ctx.logger.info('feishu: 上线了（机器人身份：…）')` —— 验收手册让你看的那句；
 *   · `[core] …`、`[agent-dsh] 启动：profile=…`；
 *   · 官方飞书 SDK 报的错（第 45 轮刚把它们接进这个 logger）。
 *
 * 终端里看不到；自启动的 `logs/autostart.log` 里也没有 —— 那个文件收的是进程的
 * stdout/stderr（`StandardOutput=append:`），而这些行从来没走到 stdout。
 * 实测：真 `butler run` 的输出里，三处插件日志前缀一行都没有。
 *
 * 所以这里再挂一个**往终端打**的 exporter。默认那份留着不动（它不碍谁，也不好从外面摘）。
 *
 * ## 级别：`BUTLER_LOG_LEVEL`
 *
 * ⚠️ Cordis 的级别数字**不是**按严重程度排的，别照着直觉读：
 *
 * | 名字 | 数字 | 过滤后能看到 |
 * | --- | --- | --- |
 * | `error` | 0 | 只有 error |
 * | `info` | 1 | error + info —— **不含 warn**（反直觉，但 `info=1 < warn=2`） |
 * | `warn` | 2 | error + info + warn ← **默认** |
 * | `debug` | 3 | 全都，含 debug（官方 SDK 的 info 就在这一档） |
 *
 * 过滤是 `exporter.levels.default < level` 就跳过，所以数字越大看到越多。
 * 不认识的取值**要说出来**再按默认来 —— 悄悄按默认走，用户会以为自己调对了。
 */

import { Logger, type Context } from '@deepseek-ai/cordis';

/** Cordis 的级别名 → 数字。⚠️ `info=1 < warn=2`，就是它自己的排法 */
const LEVELS = { error: 0, info: 1, warn: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

/** 默认级别。取 `warn`（=2）：error、info、warn 都出来，debug 那一档留着按需开 */
export const DEFAULT_LOG_LEVEL: LogLevel = 'warn';

export interface LogLevelChoice {
  name: LogLevel;
  level: number;
  /** 取值不认识时的那句话（要打给用户看）。认得的取值没有这一项 */
  warning?: string;
}

/** 从环境变量读级别。不认识的值不静默——返回一句要说的话，级别仍按默认 */
export function logLevelOf(env: Record<string, string | undefined>): LogLevelChoice {
  const raw = env.BUTLER_LOG_LEVEL?.trim().toLowerCase();
  if (!raw) return { name: DEFAULT_LOG_LEVEL, level: LEVELS[DEFAULT_LOG_LEVEL] };
  if (Object.hasOwn(LEVELS, raw)) return { name: raw as LogLevel, level: LEVELS[raw as LogLevel] };
  return {
    name: DEFAULT_LOG_LEVEL,
    level: LEVELS[DEFAULT_LOG_LEVEL],
    warning:
      `⚠️  BUTLER_LOG_LEVEL=${raw} 不认识，按 ${DEFAULT_LOG_LEVEL} 来` +
      `（可选：${Object.keys(LEVELS).join(' / ')}）`,
  };
}

/** 一个 exporter 收不收某条消息，由 Cordis 自己按 `levels.default` 判 —— 这里只负责打 */
type LogMessage = Parameters<typeof Logger.format>[1];

/**
 * 挂一个往终端打的 exporter，并返回**摘掉它**的函数（`ctx.logger.exporter()` 给的就是摘除器）。
 *
 * 分流：`warn`/`error` 走 stderr（管道里能和正常输出分开），`info`/`debug` 走 stdout。
 * 不加前缀 —— 这个仓库里每条日志都自己带前缀（`feishu: `、`[core] `……），
 * 而 `message.name` 一律是服务名 `logger`（实测），再拼一遍只是噪声。
 */
export function installConsoleLog(
  ctx: Context,
  env: Record<string, string | undefined> = process.env,
): () => void {
  const choice = logLevelOf(env);
  if (choice.warning) console.error(choice.warning);

  const exporter = {
    colors: 3,
    levels: { default: choice.level },
    export(message: LogMessage): void {
      const line = Logger.format(exporter, message);
      if (message.type === 'error' || message.type === 'warn') console.error(line);
      else console.log(line);
    },
  };
  return ctx.logger.exporter(exporter);
}
