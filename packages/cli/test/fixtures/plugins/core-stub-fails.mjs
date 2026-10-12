import { Service } from '@deepseek-ai/cordis';

/**
 * 一个"装载没问题、上线这一步炸了"的内核。
 *
 * 这条路径真实存在，而且**小白一定会撞上**：微信扫码 12 分钟没人扫，
 * 通道的 start() 就会抛（"登录超时 —— 重新跑一次 butler run"）。
 * 那时候用户该看到那一句话，而不是一棵栈。
 */
export class CoreStubFails extends Service {
  constructor(ctx, config) {
    super(ctx, 'core');
    this.config = config ?? {};
    ctx.effect(() => () => this.stop(), 'stub-fails.stop');
  }

  async start() {
    // 抛什么由配置说了算 —— "超时"和"用户自己取消"要走两条不同的路
    throw new Error(this.config.message ?? '登录超时（12 分钟无人确认） —— 重新跑一次 butler run 会重新出码');
  }

  async stop() {}
}

export default CoreStubFails;
