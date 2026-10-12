/**
 * 验收探针：**在真 DSH 里**把插件的桥接层跑两轮。
 *
 * 为什么要这个东西：仓库里的 36 个测试全都是离线的 —— 它们证明"逻辑对"，
 * 但没法证明"我们调 DSH 的那几行 API 真的存在、真的按我们以为的语义工作"
 * （`agents.create` 的选项、`followup` 收不收我们手搓的消息、
 * `session/event` 的名字、`installModelSelection` 的用法）。
 * 那些只有真跑一次才知道。
 *
 * 它怎么做到不碰微信、不花钱：
 *   - 通道用一个**记账用的假对象**（`sendText` 只记录），微信协议那半边不参与；
 *   - 模型指的是本地假端点（`fake-model.mjs`，回声），所以是一次真往返但不花钱。
 *
 * 判定打在 stdout，run.sh 直接 grep：
 *
 *     [probe] 第一句 → 回声: 探针第一句
 *     [probe] 第二句 → 回声: 探针第二句
 *     [probe] 会话 seq：第一轮后 N，第二轮后 M     ← M > N = 同一个会话在接着长
 *     [probe] 判定: PASS
 *
 * @module dsh-probe
 */

export const name = 'butler-probe';

/** 跟插件一样：只要 dsh-base 里有的服务 */
export const inject = ['agents', 'sessions', 'agentDefaultModel'];

const say = (message) => process.stdout.write(`[probe] ${message}\n`);

export async function apply(ctx) {
  const sent = [];
  const channel = {
    async sendText(to, text, opts) {
      sent.push({ to, text, opts });
      return { chunks: 1 };
    },
    async setTyping() {},
  };

  try {
    const { WechatBridge } = await import('@butler/dsh-plugin/bridge');
    const { sessionIdFor } = await import('@butler/dsh-plugin/turn');

    let installSelection;
    try {
      ({ installModelSelection: installSelection } = await import('@deepseek-ai/dsh-agent'));
      say('installModelSelection：拿到了');
    } catch (error) {
      say(`installModelSelection：没拿到（${error?.message ?? error}）—— 退化成只传 agentOptions`);
    }

    const sessionId = sessionIdFor('probe-user');
    let createCount = 0;
    const realCreate = ctx.agents.create.bind(ctx.agents);
    ctx.agents.create = async (options) => {
      createCount += 1;
      return realCreate(options);
    };

    const bridge = new WechatBridge({
      channel,
      agents: ctx.agents,
      sessions: ctx.sessions,
      model: ctx.agentDefaultModel,
      installSelection,
      cwd: process.env.PROBE_CWD ?? process.cwd(),
      config: { owner: ['probe-user'], typing: false, quoteReply: true },
      state: { read: () => ({ owner: 'probe-user' }), write: () => {} },
      log: (message) => say(message),
      onEvent: (handler) => ctx.on('session/event', handler),
    });

    const prompts = ['探针第一句', '探针第二句'];
    const replies = [];
    const seqs = [];
    for (const text of prompts) {
      sent.length = 0;
      await bridge.handle({ channel: 'wechat', fromId: 'probe-user', text, contextToken: `tk-${text}` });
      const reply = sent.at(-1);
      replies.push(reply?.text ?? '');
      say(`${text} → ${reply?.text ?? '(什么都没发出来)'}`);
      const live = ctx.agents.get(sessionId);
      seqs.push(live?.session?.seq ?? -1);
    }

    say(`会话 ${sessionId} 的 seq：第一轮后 ${seqs[0]}，第二轮后 ${seqs[1]}（同一份在接着长）`);
    say(`agents.create 调用次数：${createCount}（0 = 接上已有会话，1 = 新建了一个；两轮不该建两个）`);

    // 判据故意不跟"具体回复内容"绑死：
    //   - DSH 会往 user 角色里注入运行时上下文，所以不能拿"最后一条 user"当真；
    //   - 真话是"这一轮真的走完了 DSH 的 LLM 管线，并且回到微信那头了"。
    const problems = [];
    if (!replies.every((reply) => reply.startsWith('假模型回复'))) problems.push('回复不是模型产出的（没走到 LLM）');
    if (createCount > 1) problems.push(`建了 ${createCount} 个会话（该复用同一个）`);
    if (!(seqs[0] >= 0 && seqs[1] > seqs[0])) problems.push('两轮没落在同一个会话上（seq 没长）');
    if (ctx.agents.get(sessionId) === undefined) problems.push('跑完这个会话不在 live 列表里');

    say(`判定: ${problems.length === 0 ? 'PASS' : `FAIL（${problems.join('；')}）`}`);
    if (problems.length > 0) process.exitCode = 1;
  } catch (error) {
    say(`判定: FAIL（抛出来了：${error?.stack ?? error}）`);
    process.exitCode = 1;
  }
}
