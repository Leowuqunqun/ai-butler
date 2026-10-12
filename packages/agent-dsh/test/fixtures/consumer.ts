/**
 * 类型探针 —— 不运行，只被 `pnpm typecheck` 编译。
 *
 * 它验证的是**消费者视角**能不能用，并且顺手钉死一条反直觉的实测结论：
 *
 *   ✅ 配置**类型写错**会被拦下（`patchFile: 123` 编译不过）
 *   ❌ 配置**漏填必填项**编译期拦不住
 *
 * 后者不是笔误，是 cordis + schemastery 的类型现实：schemastery 的 Schema
 * 调用签名是 `(value?: S) => T | null | undefined`，正好满足 cordis 的
 * `Plugin.Transform`（`Config: (config: S) => T`）；而 cordis 用
 * `Spread<T> = undefined extends T ? [config?: T] : [config: T]` 展开参数，
 * 推断出来的 `T` 含 `undefined` ⇒ **配置参数永远是可选** ⇒ `{}` 也合法。
 *
 * 所以"必填"只能靠**实现自己的构造函数**在加载时拦住（DshAgent 就是这么做的，
 * 见 test/agent.mjs 里那几条"缺必填配置在加载时就抛"）。下面第 3 段
 * 故意**不写** `@ts-expect-error`：写了反而会因为"该报错却没报"而编译失败。
 */
import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { DshAgent } from '@butler/agent-dsh';

export async function probe(ctx: Context): Promise<string> {
  // 1. 最少要给的：patchFile + home
  await ctx.plugin(DshAgent, { patchFile: '/tmp/p.yml', home: '/tmp/h' });

  // 2. 全给也行
  await ctx.plugin(DshAgent, {
    patchFile: '/tmp/p.yml',
    home: '/tmp/h',
    bin: '/usr/local/bin/dsh',
    profile: 'headless',
    timeoutMs: 60_000,
  });

  // 3. 漏填必填项**编译得过**（类型现实，见文件头）。
  //    拦住它的是 DshAgent 构造函数里的运行时校验 —— 加载时就炸，不是用户第一次发消息时才炸。
  await ctx.plugin(DshAgent, {});

  // 4. 但**类型写错**是拦得住的
  // @ts-expect-error patchFile 必须是字符串
  await ctx.plugin(DshAgent, { patchFile: 123, home: '/tmp/h' });

  // 5. 核心层只按 seam 消费，不认识 DshAgent
  const agent: AgentService = ctx.agent;
  const r = await agent.run({
    text: '把报表整理一下',
    sessionId: null,
    cwd: '/tmp/work',
    onProgress: (line: string) => { void line; },
    signal: new AbortController().signal,
  });

  return r.text ?? r.error ?? '';
}

export default probe;
