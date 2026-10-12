/**
 * 配置文件与 patch 叠加 —— 纯逻辑，不碰文件系统之外的东西。
 *
 * ── 跟 dsh 的关系（说清楚，免得以后当成跑偏）──────────────────────
 *
 * **语义照搬，语法简化。** 保留的是 dsh 那几条真正要紧的语义：
 *
 *   1. 行由 `id` 寻址
 *   2. **`config` 是整体替换，不是深合并** ← 最容易踩的一条
 *   3. `disabled`
 *   4. 行的顺序不承载语义
 *   5. base 作为一次叠加施加在空根上，用户的 patch 再往上叠
 *
 * 简化掉的是**文件语法**，两条，都有理由：
 *
 *   - **用 JSON 不用 YAML**：少一个依赖。而且这个文件的第一作者是引导页/GUI，
 *     它本来就要机器读写；给人看的注释版将来可以再加。
 *   - **不要 `- insert:` 外壳**：现在只有"插入"一种操作，外壳没带来任何信息。
 *   - **`disabled` 只收 true/false，不支持 dsh 的 `!!js "表达式"`**：
 *     那等于在配置文件里 `eval` 任意代码。对"给完全不懂技术的人用"的产品来说
 *     这是个纯粹的脚下枪，代价大于收益。
 *
 * @module @butler/cli/config
 */

import { readFileSync } from 'node:fs';

/** 配置里的一行 = 一个要装进容器的插件 */
export interface PluginRow {
  /** 行的地址。patch 靠它找到要覆盖哪一行 */
  id: string;
  /** 模块名或路径。包名从**应用自己的目录**解析，相对路径从**配置文件所在目录**解析 */
  name: string;
  /** 原样交给插件的配置。patch 覆盖它是**整体替换** */
  config?: Record<string, unknown>;
  /** 关掉这一行。默认 false */
  disabled?: boolean;
}

export interface ConfigFile {
  plugins?: PluginRow[];
}

export class ConfigError extends Error {
  constructor(message: string, readonly source: string) {
    super(`${source}：${message}`);
    this.name = 'ConfigError';
  }
}

/** 读一个配置文件并做基本的形状校验。报错一律带上文件路径 —— 小白看不懂"第 3 个元素" */
export function readConfigFile(path: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new ConfigError('文件不存在', path);
    throw new ConfigError(`读不了（${e.message}）`, path);
  }
  return parseConfig(text, path);
}

export function parseConfig(text: string, source: string): ConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`不是合法的 JSON（${(error as Error).message}）`, source);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('最外层应当是一个对象，形如 { "plugins": [ … ] }', source);
  }
  const rows = (raw as ConfigFile).plugins;
  if (rows === undefined) return { plugins: [] };
  if (!Array.isArray(rows)) throw new ConfigError('"plugins" 应当是数组', source);

  rows.forEach((row, i) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ConfigError(`plugins[${i}] 应当是一个对象`, source);
    }
    if (typeof row.id !== 'string' || !row.id) {
      throw new ConfigError(`plugins[${i}] 缺少 id（行的地址，patch 靠它定位）`, source);
    }
    if (typeof row.name !== 'string' || !row.name) {
      throw new ConfigError(`plugins[${i}]（id=${row.id}）缺少 name（模块名或路径）`, source);
    }
    if (row.config !== undefined && (row.config === null || typeof row.config !== 'object' || Array.isArray(row.config))) {
      throw new ConfigError(`plugins[${i}]（id=${row.id}）的 config 应当是一个对象`, source);
    }
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean') {
      throw new ConfigError(`plugins[${i}]（id=${row.id}）的 disabled 只能是 true/false`, source);
    }
  });

  return { plugins: rows };
}

/**
 * 把 overlay 叠到 base 上。**后写的赢。**
 *
 * 两种写法，都是 dsh 的语义：
 *   - `id` 已存在 → 覆盖。**只覆盖你写了的字段**；`config` 一旦写了就是**整体替换**，
 *     不深合并（所以默认值要在 base 里写全，别指望"我补一个字段就行"）
 *   - `id` 不存在 → 追加（相当于 dsh 的 insert）
 */
export function mergeRows(base: readonly PluginRow[], overlay: readonly PluginRow[]): PluginRow[] {
  const rows: PluginRow[] = base.map((r) => ({ ...r }));
  for (const patch of overlay) {
    const i = rows.findIndex((r) => r.id === patch.id);
    if (i < 0) rows.push({ ...patch });
    else rows[i] = { ...rows[i], ...patch };   // config 随之整体替换（不是深合并）
  }
  return rows;
}

export interface LoadedConfig {
  rows: PluginRow[];
  /** 实际读了哪些文件，按叠加顺序。doctor 要拿它告诉用户"我看的是哪儿" */
  files: string[];
  /** 被 disabled 关掉的行 */
  disabled: PluginRow[];
}

/** 读 base + 一串 patch，叠加成最终的行列表 */
export function loadConfig(basePath: string, patches: readonly string[] = []): LoadedConfig {
  const files = [basePath, ...patches];
  let rows: PluginRow[] = [];
  for (const file of files) {
    rows = mergeRows(rows, readConfigFile(file).plugins ?? []);
  }
  return {
    rows: rows.filter((r) => !r.disabled),
    files,
    disabled: rows.filter((r) => r.disabled),
  };
}
