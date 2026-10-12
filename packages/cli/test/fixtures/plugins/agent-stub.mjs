import { AgentService } from '@butler/seam-agent';

/** 占住 ctx.agent 的大脑夹具。检查项由配置注入，跟 check-channel 一个路子 */
export class AgentStub extends AgentService {
  id = 'stub';
  cancellable = false;

  constructor(ctx, config) {
    super(ctx);
    this.config = config ?? {};
  }

  async run() { return { sessionId: null, text: '干完了' }; }

  check() {
    if (this.config.throws) throw new Error('这个大脑自检的时候炸了');
    return this.config.checks ?? [];
  }
}

export default AgentStub;
