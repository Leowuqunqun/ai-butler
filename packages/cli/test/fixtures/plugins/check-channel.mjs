import { ChannelService } from '@butler/seam-channel';

/**
 * 一个"检查结果由配置决定"的通道夹具。
 *
 * 继承**真 seam**（不是随便一个 Service），因为 doctor 只对脊梁上的三个服务位
 * 问自检 —— 夹具要是没占住 `ctx.channel`，测的就不是真实路径了。
 */
export class CheckChannel extends ChannelService {
  id = 'check';

  constructor(ctx, config) {
    super(ctx);
    this.config = config ?? {};
  }

  async start() {}
  async stop() {}
  async sendText() { return { chunks: 1 }; }
  async sendFile() { return {}; }

  check() {
    if (this.config.throws) throw new Error('这个插件自检的时候炸了');
    return this.config.checks ?? [];
  }
}

export default CheckChannel;
