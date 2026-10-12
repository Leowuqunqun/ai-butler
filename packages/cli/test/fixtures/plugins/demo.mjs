import { Service } from '@deepseek-ai/cordis';

/** 最小的可加载插件。顺带证明一件事：cordis 的 Service 基类**不会**替你存 config，得自己接 */
export class Demo extends Service {
  constructor(ctx, config) {
    super(ctx, 'demo');
    this.config = config;
  }
}

export default Demo;
