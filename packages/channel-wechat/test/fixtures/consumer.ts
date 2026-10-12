/**
 * 消费方探针 —— **只做类型检查，不运行**。
 *
 * 它模拟"核心层"怎么用这个通道：只认 `ctx.channel`（seam），不认微信。
 * 跑 `pnpm typecheck` 时会被编译一次。
 *
 * 为什么值得专门放一个文件：手写的 `plugin.d.ts` 光靠运行时测试
 * 是查不出类型错误的 —— `plugin-types.mjs` 只能核对成员**名字**对不对。
 * 这个探针第一次跑就抓到 `static Config` 被写成了 `unknown`，
 * 那会让 `ctx.plugin(WechatChannel, …)` 直接编译不过。
 */

import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@butler/seam-channel';
import WechatChannel from 'wechat-agent-bridge/plugin';

export async function main(): Promise<void> {
  const ctx = new Context();

  // ① 能作为插件装进去；配置**只需传想改的字段**，其余由 schema 补默认值
  await ctx.plugin(WechatChannel, { home: '/tmp/wab', replyChars: 500 });
  await ctx.plugin(WechatChannel);          // 一个都不传也得行

  // ② 核心层按 seam 消费：拿到的应当是完整的接口类型
  const channel: ChannelService = ctx.channel;
  channel.onMessage((m) => {
    const path: string | undefined = m.files?.[0]?.path;
    const from: string = m.fromId;
    console.log(from, m.text, path);
  });
  await channel.start();
  await channel.sendText('u1', '你好');
  await channel.setTyping('u1', true, { contextToken: 'tk' });

  // ③ 实现类自己暴露的成员也有类型。
  //    注意 `config` **不在 seam 契约里**，所以必须从实现类拿 ——
  //    这正是接口隔离生效的证据（上一版探针在这里报错，是对的）
  const wechat: WechatChannel = ctx.channel as WechatChannel;
  const id: string = wechat.id;
  const media: boolean = wechat.config.mediaEnabled;
  const home: string = wechat.config.home;
  console.log(id, media, home);

  await channel.stop();
}
