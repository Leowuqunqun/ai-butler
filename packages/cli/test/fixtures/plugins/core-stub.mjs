import { Service } from '@deepseek-ai/cordis';

/**
 * 假装是内核。
 *
 * ⚠️ 收尾走 `ctx.effect` —— 跟**真内核一模一样**。
 * 容器卸载插件时不会替你调 stop()，只会跑你注册的 effect teardown。
 * 夹具要是省掉这一层，测的就是一个真实产品里不存在的路径。
 */
export class CoreStub extends Service {
  constructor(ctx, config) {
    super(ctx, 'core');
    this.config = config ?? {};
    ctx.effect(() => () => this.stop(), 'stub.stop');
  }

  async start() {
    console.log(`[stub] core 上线了 workspace=${this.config.workspace ?? '(没配)'}`);
  }

  async stop() { console.log('[stub] core 下线了'); }
}

export default CoreStub;
