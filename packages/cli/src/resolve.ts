/**
 * 把配置里的 `name` 变成一个真能 `import` 的插件。
 *
 * ── 从哪儿找（这条容易搞错，写清楚）────────────────────────────────
 *
 *   - `./x`、`../x`、`/x` → 从**配置文件所在目录**解析。
 *     你在自己家目录写配置指向自己的脚本，这是你期望的行为。
 *   - `@butler/core` 这种**包名** → 从**应用自己的目录**解析。
 *     插件是随应用一起装上的，就该像任何应用加载自己的依赖那样，
 *     在应用自己的 node_modules 里找 —— 而不是在用户的 `~/.butler/` 里找。
 *
 * @module @butler/cli/resolve
 */

import { createRequire } from 'node:module';
import { isAbsolute, resolve as pathResolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from '@deepseek-ai/cordis';

export interface ResolveContext {
  /** 配置文件所在目录 */
  configDir: string;
  /** 应用自己的目录（本包根目录） */
  selfDir: string;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** 纯函数版：算出"该去哪儿 import"。测试直接断言它，不用真去装包 */
export function resolveSpecifier(name: string, ctx: ResolveContext): { url: string; where: string } {
  if (name.startsWith('.') || isAbsolute(name)) {
    const abs = isAbsolute(name) ? name : pathResolve(ctx.configDir, name);
    return { url: pathToFileURL(abs).href, where: `相对配置文件：${abs}` };
  }

  // 包名：先从应用自己的目录解析。解析不到就交给 Node 的原生解析
  //（本模块自己就住在应用目录里，所以原生解析的起点正是我们想要的）
  try {
    const require = createRequire(join(ctx.selfDir, '_butler_resolve_.js'));
    return { url: pathToFileURL(require.resolve(name)).href, where: `应用依赖：${ctx.selfDir}` };
  } catch {
    return { url: name, where: '应用依赖（交给 Node 原生解析）' };
  }
}

export async function importPlugin(name: string, ctx: ResolveContext): Promise<Plugin> {
  const { url, where } = resolveSpecifier(name, ctx);
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (error) {
    throw new ResolveError(
      `装不上插件 ${JSON.stringify(name)}：${(error as Error).message}\n` +
      `  找的位置：${where}`,
    );
  }

  // 兼容三种导出：默认导出、具名 default、以及整个模块本身就是插件
  const candidate = (mod as { default?: unknown })?.default ?? mod;
  if (candidate === undefined || candidate === null) {
    throw new ResolveError(`插件 ${JSON.stringify(name)} 没有默认导出`);
  }
  return candidate as Plugin;
}
