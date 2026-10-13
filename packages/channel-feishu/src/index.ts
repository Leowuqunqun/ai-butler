/**
 * `ctx.channel` 的第三个实现：飞书 / Lark。
 *
 * ── 这个文件为什么这么薄 ──────────────────────────────────────
 *
 * 长连接、断线重连、心跳保活、握手超时、事件归一化（群里 @ 提及换成人名、
 * merge_forward 展开、卡片 / 表情 / 评论）、去重、按 chat 串行、流式卡片、
 * 媒体上传（含 SSRF 防护）、限流重试 —— 这些**全在官方 `@larksuite/channel`
 * 里**，我们一行都不重写。
 *
 * 理由不是偷懒，是那份代码更该由他们维护：它的维护者和官方 `node-sdk` 是同一批
 * ByteDance 账号，飞书改协议他们先知道；我们抄一份，改协议时是我们先坏。
 *
 * 我们只做它不做的那件事：**把它折成 `ctx.channel`**。所以这里的判断标准很简单：
 * **任何一行跟飞书协议细节有关的代码都不该出现在这个文件里** ——
 * 纯映射进 `map.ts`（纯函数，能离线测），跨重启的状态进 `seen.ts`，
 * 网络全部交给官方包。
 *
 * @module @butler/channel-feishu
 */

import z from '@deepseek-ai/schemastery';
import { ChannelService, type HealthCheck, type LocalFile, type SendOpts, type SendResult } from '@butler/seam-channel';
import type { Context } from '@deepseek-ai/cordis';
import { createLarkChannel, type LarkChannel, type NormalizedMessage } from '@larksuite/channel';

import { toInbound, toQuoteLine, decodeContext } from './map.js';
import { SeenStore } from './seen.js';
import { destFor, downloadTypeOf, guessMime, kindOf } from './files.js';

import { mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** 飞书的硬上限。超了官方包会报错，不如我们先把话说清楚 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface FeishuChannelConfig {
  /** 开发者后台或扫码注册给的 app_id（`cli_…`）。**空 = 还没填** */
  appId: string;
  appSecret: string;
  /** 管家目录。去重表放在 `<home>/state/feishu-seen.json` */
  home: string;
  /** 群里要不要 @ 它才理。默认要 */
  requireMention: boolean;
  /** 只理这些群（chat_id，`oc_…`）。空 = 不筛（真正的门在核心层的"认主"） */
  allowChats: string[];
  /** 去重表记多少条 messageId */
  seenLimit: number;
  /** 单文件上限（MB）：收进来的超过它不落盘，发出去的超过它直接报错。飞书自己也是 30 */
  maxFileMb: number;
}

export class FeishuChannel extends ChannelService {
  // 全部给 default、不用 .required() —— 本项目的既定写法（见 ARCH-technical §5）：
  // static Config 拦不住漏填，必填在构造函数里拦。
  static Config = z.object({
    appId: z.string().default(''),
    appSecret: z.string().default(''),
    home: z.string().default(''),
    requireMention: z.boolean().default(true),
    allowChats: z.array(z.string()).default([]),
    seenLimit: z.number().default(1000),
    maxFileMb: z.number().default(30),
  });

  readonly id = 'feishu';
  readonly config: FeishuChannelConfig;

  private readonly home: string;
  private readonly seen: SeenStore;
  /** 官方那个通道实例。**测试里用 makeChannel 覆写掉**（见 test/） */
  private readonly lark: LarkChannel;
  private off?: () => void;
  private running = false;

  constructor(ctx: Context, config: FeishuChannelConfig) {
    super(ctx);
    // `home` 空着就用默认位置。**不在 Config 里给默认值**：默认值要在运行时算
    //（会用到 homedir()），写在 schema 里会让 dump 出来的配置看起来是死的。
    this.home = config.home || join(homedir(), '.butler');
    // `maxFileMb` 在这里兜一次底：`static Config` 的默认值只有在**经 cordis 装载**时
    // 才生效，而这个类是能被直接 `new` 出来的（测试就是那么干的）。少了这一行，
    // 上限会变成 `NaN` —— 而 `size > NaN` 永远是 false，**限流被静默关掉**。
    // 这种"默认失效"不该靠调用方守规矩。
    this.config = { ...config, home: this.home, maxFileMb: config.maxFileMb || 30 };
    this.seen = new SeenStore(join(this.home, 'state', 'feishu-seen.json'), config.seenLimit);
    this.lark = this.makeChannel(this.config);
    // 收尾一律走 effect（cordis 4 没有 'dispose' 事件）
    ctx.effect(() => () => this.stop(), 'feishu.stop');
  }

  /**
   * 造官方通道。抽成方法只为一件事：**测试能覆写它**。
   * 有了它，适配层可以在没有网络、没有凭据的情况下被完整测一遍。
   */
  protected makeChannel(config: FeishuChannelConfig): LarkChannel {
    return createLarkChannel({
      appId: config.appId,
      appSecret: config.appSecret,
      policy: {
        requireMention: config.requireMention,
        ...(config.allowChats.length > 0 ? { groupAllowlist: config.allowChats } : {}),
      },
      // 去重分工：官方包管**进程内**（官方重推最密的那几波），
      // 落盘表管**跨重启**（重推最远 6 小时后才来，那时内存早空了）。见 seen.ts。
      safety: { dedup: { ttl: 60 * 60 * 1000 } },
    });
  }

  /**
   * 开始收信。必须幂等 —— 起两条长连接会让飞书在集群里**随机挑一条**投递，
   * 表现是"消息偶尔不回"，极难查。
   */
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.config.appId.trim() || !this.config.appSecret.trim()) {
      // 这条错会原样出现在 `butler run` 的"起不来：…"里，所以要写成人话
      throw new Error(
        '还没有飞书应用的 app_id / app_secret。跑一次 `butler run` 选飞书，'
        + '它会开一个二维码给你扫 —— 扫码就能建应用并授权，不用自己去开发者后台点那一串步骤。',
      );
    }
    // 先订阅、再连：连上之后立刻到达的消息不能漏。
    const off = this.lark.on('message', (msg) => {
      void this.handleIncoming(msg);
    });
    this.off = off;
    try {
      await this.lark.connect();
    } catch (error) {
      off();
      this.off = undefined;
      throw error;
    }
    this.running = true;
    const me = this.lark.botIdentity;
    this.ctx.logger?.info('feishu: 上线了（%s）', me ? `${me.name} ${me.openId}` : '身份未知');
  }

  /** 停止收信。**没 start 过也要能安全调用**（doctor、卸载、启动失败回滚都会调到） */
  async stop(): Promise<void> {
    this.off?.();
    this.off = undefined;
    if (!this.running) return;
    this.running = false;
    try {
      await this.lark.disconnect();
    } catch (error) {
      this.ctx.logger?.warn('feishu: 断开时出错（不管它，进程要走了）: %o', error);
    }
  }

  /**
   * 一条消息进来了。
   *
   * （名字**不能**叫 `onMessage` —— 那是接缝基类给核心层用的公开注册方法，
   * 同名会把它遮掉。编译器在这里救了我们一次，别再改回去。）
   *
   * 三件事，顺序有讲究：
   *   1. **机器人发的消息直接不理** —— 飞书群里两个机器人互相 @ 会刷屏，官方包有
   *      `botLoopGuard` 兜底，但我们连第一句都不接更省事。
   *   2. **先查去重表再说别的** —— 飞书是"至少一次"投递，重复消息是真的会来。
   *   3. **把被引用的那句原文取回来** —— 接缝要的是"他在回哪句"的**文本**，
   *      而事件里只有 `replyToMessageId`，所以要多一次 `fetchMessage`。
   *      取不到就当没引用（正文照走）：少一段上下文，好过整条消息不回。
   *
   * 注意这里 `await` 了引用那一次网络调用之后才 `emitMessage`：这会让**这个会话**
   * 的下一条消息等一会儿（官方包默认按 chat 串行），但不会阻塞别的会话，
   * 也不会阻塞收信循环 —— 接缝规则 3 的要求是"别把循环卡死"，不是"不许有 await"。
   */
  private async handleIncoming(msg: NormalizedMessage): Promise<void> {
    if (msg.senderIsBot) return;
    if (this.seen.has(msg.messageId)) {
      this.ctx.logger?.info('feishu: 跳过重复投递的消息 %s', msg.messageId);
      return;
    }
    this.seen.add(msg.messageId);

    // 取引用原文 + 落盘附件 —— 两件事互不依赖，**并行**做。
    // 串着做等于让用户白等一趟网络（而这两趟网络都不快）。
    const [quote, files] = await Promise.all([this.fetchQuote(msg), this.fetchFiles(msg)]);

    this.emitMessage(toInbound(msg, {
      ...(quote ? { quote } : {}),
      ...(files.length > 0 ? { files } : {}),
      channelId: this.id,
    }));
  }

  /** 取出被引用那句话的原文。取不到就当没引用（少一段上下文，好过整条消息不回） */
  private async fetchQuote(msg: NormalizedMessage): Promise<string | undefined> {
    if (!msg.replyToMessageId) return undefined;
    try {
      const quoted = await this.lark.fetchMessage(msg.replyToMessageId);
      return quoted ? toQuoteLine(quoted) : undefined;
    } catch (error) {
      this.ctx.logger?.debug('feishu: 取被引消息失败（当没引用）: %o', error);
      return undefined;
    }
  }

  /**
   * 把这条消息带的附件落到本机。
   *
   * 接缝的硬要求：`files` 里每个 `path` 都必须是**已经能读**的文件
   * （"不允许按需再下载"——那等于把通道的复杂度漏给核心层）。所以这里 `await` 完才 `emitMessage`。
   *
   * 三条纪律：
   *   · **一个附件失败不拖累整条消息**：记一条 warn、跳过它，正文照走。
   *     少一个附件是遗憾，整条消息不回是事故。
   *   · **超上限的不交出去**：落了盘才发现太大，就删掉 —— 别让 agent 去读一个
   *     100 MB 的文件（它多半会整个读进上下文）。
   *   · **文件名是对方给的**：所以一律过 `destFor` 消毒，绝不用它直接拼路径。
   */
  private async fetchFiles(msg: NormalizedMessage): Promise<LocalFile[]> {
    const res = msg.resources ?? [];
    if (res.length === 0) return [];
    const dir = join(this.home, 'state', 'files', 'feishu');
    const cap = this.config.maxFileMb * 1024 * 1024;
    const out: LocalFile[] = [];

    for (const r of res) {
      const { path: dest, name } = destFor(dir, r);
      try {
        // 官方包的下载是 **pipe 到磁盘**（不把整个文件读进内存），前提是父目录已存在
        mkdirSync(dir, { recursive: true });
        const { contentType, bytesWritten } = await this.lark.downloadResourceToFile(
          msg.messageId,
          r.fileKey,
          downloadTypeOf(r.type),
          dest,
        );
        if (bytesWritten > cap) {
          rmSync(dest, { force: true });
          this.ctx.logger?.warn(
            'feishu: 附件太大（%s MB > %s MB），没交给 agent：%s',
            (bytesWritten / 1024 / 1024).toFixed(1),
            String(this.config.maxFileMb),
            name,
          );
          continue;
        }
        out.push({
          path: dest,
          name,
          mime: guessMime(name, contentType),
          size: bytesWritten,
          kind: kindOf(r.type),
        });
      } catch (error) {
        // 下载失败常常是权限点没开（`im:resource`），把原始错误留着给用户看
        this.ctx.logger?.warn('feishu: 附件下载失败（跳过它，消息照走）%s: %o', name, error);
      }
    }
    return out;
  }

  /**
   * 发一段文本。
   *
   * 两件事归实现管、内核不插手，这里的选择是：
   *   - **分条**：交给官方包（它自己知道飞书的上限）。`opts.maxChars` 因此不用 ——
   *     我们照它返回的 `chunkIds` 数告诉内核分了几条。
   *   - **"在回哪句"**：走**原生引用回复**（`reply`）。所以 `opts.quote` 这里
   *     故意不用 —— 飞书自己会把被引那句话贴在气泡上，再顶一行 `↩…` 就重复了。
   *     这是 Telegram 那一课学来的：引用该由通道决定怎么显示，不是内核塞文本。
   */
  async sendText(to: string, text: string, opts: SendOpts = {}): Promise<SendResult> {
    const ctx = decodeContext(opts.contextToken, to);
    const input = { markdown: text };
    const res = ctx.messageId
      ? await this.lark.reply(
        { chatId: ctx.chatId, messageId: ctx.messageId, ...(ctx.threadId ? { threadId: ctx.threadId } : {}) },
        input,
      )
      : await this.lark.send(ctx.chatId, input);
    return { chunks: res.chunkIds?.length ?? 1 };
  }

  /** 发一个本机文件。图片走图片、其余走文件 —— 飞书两条路的尺寸上限不一样 */
  async sendFile(to: string, path: string, opts: SendOpts = {}): Promise<SendResult> {
    const ctx = decodeContext(opts.contextToken, to);
    const name = basename(path);
    const isImage = /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      throw new Error(`要发的文件读不到：${path}`);
    }
    const cap = isImage ? MAX_IMAGE_BYTES : this.config.maxFileMb * 1024 * 1024;
    if (size > cap) {
      throw new Error(
        `文件太大，飞书收不下：${name} 是 ${(size / 1024 / 1024).toFixed(1)} MB，`
        + `上限 ${(cap / 1024 / 1024).toFixed(0)} MB。把它压小或切成几份再发。`,
      );
    }

    const input = isImage
      ? { image: { source: path } }
      : { file: { source: path, fileName: name } };
    const res = ctx.messageId
      ? await this.lark.reply(
        { chatId: ctx.chatId, messageId: ctx.messageId, ...(ctx.threadId ? { threadId: ctx.threadId } : {}) },
        input,
      )
      : await this.lark.send(ctx.chatId, input);
    return { fileName: name, ...(res.chunkIds?.length ? { chunks: res.chunkIds.length } : {}) };
  }

  /**
   * 自检。规矩照接缝写的来：**不抛错**、**不做重活**。
   *
   * 所以这里**不探活**：真探一次要把长连接连起来，那是"重活"。凭据在不在、
   * 去重表放哪，这两件光看文件就能回答的事，才是 doctor 该报的。
   * （一次有时限的 REST 探活是下一步的事，先如实说"没查"。）
   */
  override async check(): Promise<HealthCheck[]> {
    const out: HealthCheck[] = [];
    if (!this.config.appId.trim() || !this.config.appSecret.trim()) {
      out.push({
        name: '飞书登录态',
        ok: false,
        detail: '还没有填 app_id / app_secret',
        fix: '跑一次 `butler run` 选飞书 —— 它会开一个二维码给你扫，扫码就能建应用并授权',
      });
    } else {
      const me = this.lark.botIdentity;
      out.push({
        name: '飞书登录态',
        ok: true,
        detail: me ? `已连上：${me.name}（${me.openId}）` : '凭据已填；这次没探活（doctor 不做重活）',
      });
    }
    out.push({
      name: '飞书去重表',
      ok: true,
      detail: join(this.home, 'state', 'feishu-seen.json'),
    });
    return out;
  }

}

export default FeishuChannel;
