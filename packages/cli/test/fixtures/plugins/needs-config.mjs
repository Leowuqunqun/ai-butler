import { Service } from '@deepseek-ai/cordis';

/** 模拟"必填配置没给"的实现：构造时就抛，跟 agent-dsh / agent-exec 一样 */
export class NeedsConfig extends Service {
  constructor(ctx, config) {
    super(ctx, 'needsConfig');
    if (!config?.token) throw new Error('缺少必填配置：token（去哪儿拿：设置页扫一下码）');
  }
}

export default NeedsConfig;
