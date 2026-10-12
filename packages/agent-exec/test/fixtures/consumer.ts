/**
 * 类型探针 —— 不运行，只被 `pnpm typecheck` 编译。
 *
 * 这里最要紧的一条：**第二个实现证明契约不是为 dsh 量身定做的**。
 * 一个"没有会话概念"的后端，照样能完整实现 `ctx.agent` —— 不需要塞空对象、
 * 不需要 `sessionId: undefined` 之类的将就。
 */
import { Context } from '@deepseek-ai/cordis';
import { AgentService } from '@butler/seam-agent';
import { ExecAgent } from '@butler/agent-exec';

export async function probe(ctx: Context): Promise<string> {
  await ctx.plugin(ExecAgent, { argv: ['/usr/local/bin/my-agent', '--quiet'] });
  await ctx.plugin(ExecAgent, {
    argv: ['cat'],
    input: 'stdin',
    timeoutMs: 5_000,
    cwd: '/tmp',
  });

  const agent: AgentService = ctx.agent;

  // 接口在编译期就能回答"支不支持取消"，不用去翻文档
  if (agent.cancellable) {
    const ac = new AbortController();
    const r = await agent.run({ text: '你好', cwd: '/tmp', signal: ac.signal });
    // 没有会话的后端返回 null —— 契约允许，类型也允许
    const sid: string | null | undefined = r.sessionId;
    void sid;
    return r.text ?? r.error ?? '';
  }
  return '';
}

export default probe;
