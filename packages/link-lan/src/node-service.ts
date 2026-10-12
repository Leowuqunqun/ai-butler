/**
 * 节点侧 —— 把**本机的 agent** 摊给中枢用。
 *
 * 中枢在另一台电脑上通过 `ctx.link` 连过来，调 `agent.run`，
 * 这里就把它转交给本机的 `ctx.agent`，进度原样回流。
 *
 * ── 为什么是 `ctx.node` 这个服务位 ──────────────────────────────
 *
 * 它**不是**五个 seam 之一（没有 `seam-node` 包，也没打算有）。
 * 跟 `ctx.core` 一个性质：某个具体插件自己的槽位。
 * 做成服务位是为了让 `butler node` 那条命令能像 `run` 调 `core.start()`
 * 一样对称地写 —— 并且能拿到真实的监听地址打给用户看。
 *
 * ── `static inject = ['agent']` 白拿了什么 ──────────────────────
 *
 * 一台没装 agent 的机器上，这个插件**根本不会被构造**。
 * 不需要自己写"没有 agent 就报错"的代码，也不会出现"节点在线但没人干活"
 * 这种最让人困惑的状态。
 *
 * ── 远端产出的文件怎么回传（✅ 已实现）──────────────────────────
 *
 * 难点只有一句话：**路径在对面那台机器上不存在**。
 * 所以绝不透传路径，而是"**铸取件凭证**"：
 *
 *   agent 返回 files: [{ path: '/home/leo/报表.xlsx', name: '报表.xlsx' }]
 *        ↓ 这里给每个文件铸一个一次性 token，只记在自己内存里
 *   回给中枢 files:   [{ token: 'a3f…', name: '报表.xlsx' }]
 *        ↓ 中枢拿 token 调 file.read，按块（512 KiB）取回
 *
 * 这么做换来一条**结构上就成立**的保证：中枢**只能拿到 agent 主动交出来的
 * 那些文件**，拿不到这台机器上的任意路径。就算中枢那台被攻破、或者密钥泄漏，
 * 它也没法把这里当成"读取任意文件"的接口 —— 它压根没有路径可填。
 *
 * 凭证十分钟不用就作废（用户说"发我那个报表"，agent 早就跑完了；
 * 十分钟后还来取，只可能是有人在瞎试）。
 *
 * @module @butler/link-lan/node
 */

import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { hostname } from 'node:os';

import { AgentService } from '@butler/seam-agent';
import { defaultIdentityFile, loadIdentity, localAddresses, newNodeId, newSecret, saveIdentity } from './identity.js';
import type { NodeIdentity } from './identity.js';
import { LanNode } from './server.js';

interface NodeConfig {
  id: string;
  alias: string;
  port: number;
  host: string;
  secret: string;
  /** 身份文件（id + 密钥）放哪。空 = 默认的 `~/.butler/node.json` */
  identityFile: string;
  cwd: string;
  capabilities: string[];
}

/** 一次取件要读多少字节。太大就白占内存，太小就来回太多次 */
const CHUNK = 512 * 1024;

/** 取件凭证多久不用作废 */
const OFFER_TTL_MS = 10 * 60_000;

/** 一张"你刚才交出来的那个文件在这儿"的条子 */
interface Offer {
  path: string;
  name: string;
  caption?: string;
  at: number;
}

export class NodeService extends Service {
  // 类型全部给 default —— 必填在构造函数里拦（见 ARCH-technical §5 实测表）
  static Config = z.object({
    id: z.string().default(''),
    alias: z.string().default(''),
    port: z.number().default(41338),
    host: z.string().default('0.0.0.0'),
    secret: z.string().default(''),
    identityFile: z.string().default(''),
    cwd: z.string().default(''),
    capabilities: z.array(z.string()).default(['agent']),
  });

  // 没有 agent 的机器上，这个插件根本不会被构造
  static inject = ['agent'];

  readonly config: NodeConfig;

  /** 这台机器是谁、密钥是什么。第一次起来时生成，之后一直用存下来的那份 */
  readonly identity: NodeIdentity;

  /** 身份文件在哪。`start()` 时把身份写进去 */
  private readonly identityFile: string;

  private node: LanNode | null = null;

  /** token → 那个文件在哪。**只活在内存里**，重启就没了（本来也不该跨重启） */
  private readonly offers = new Map<string, Offer>();

  constructor(ctx: Context, config: NodeConfig) {
    super(ctx, 'node');

    // ── 身份：配置 > 状态文件 > 当场生成 ──
    //
    // 生成的会**存下来**（0600）：下次起来还是同一个 id、同一把密钥，
    // 用户不用抄任何东西，中枢那边配过的关系也不会断。
    const file = config.identityFile || defaultIdentityFile();
    const saved = loadIdentity(file);
    const id = config.id || saved?.id || newNodeId();
    const secret = config.secret || saved?.secret || newSecret();

    // 配置里的 id 跟存下来的不一致：**当场拦住**。悄悄改掉的话，中枢那边
    // 记着的还是老 id，表现出来是"那台电脑不见了"，而且没有任何线索。
    if (config.id && saved?.id && config.id !== saved.id) {
      throw new Error(
        `配置里的 id 是「${config.id}」，但 ${file} 里记的是「${saved.id}」。` +
        'id 一旦定下就别改 —— 中枢那台机器是靠它认出这台电脑的。' +
        `真要改，先删掉 ${file}，再到中枢那台重新配对一次。`,
      );
    }
    // ⚠️ 这里**只读不写**。写盘放在 `start()` 里 —— 不然 `butler doctor`
    // （只装载、不启动）都会在用户家里造一个身份文件出来。
    // "加载 ≠ 上线"这条规矩，连文件系统也算上。
    this.identity = { id, secret };
    this.identityFile = file;
    this.config = config;

    // 卸载时收干净：ctx.effect 是 cordis 4 里唯一的收尾手段（没有 'dispose' 事件）
    ctx.effect(() => () => this.stop(), 'node.stop');
  }

  /**
   * 本机的 agent。
   *
   * 这个 getter 顺带干了件必要的事：**让 `@butler/seam-agent` 的模块增强生效**
   * （`ctx.agent` 的类型是那个包 `declare module '@deepseek-ai/cordis'` 出来的）。
   * 不 import 它，`this.ctx.agent` 就编译不过。
   */
  private get agent(): AgentService {
    return this.ctx.agent;
  }

  /** 这台机器在中枢那边叫什么 */
  get alias(): string {
    return this.config.alias || hostname();
  }

  /** 现在正在监听吗 */
  get listening(): boolean {
    return this.node !== null;
  }

  /** 手头还有几张没过期的取件凭证（测试用） */
  get offerCount(): number {
    this.prune();
    return this.offers.size;
  }

  /** 真的在监听时，监听地址；没起来就是 null */
  get address(): { host: string; port: number } | null {
    const node = this.node;
    return node ? { host: this.config.host, port: node.port } : null;
  }

  /**
   * 别的机器可以用哪个地址连过来。给 `butler node` 打给用户看 ——
   * 用户会**照着这一行**发配对请求，所以它必须是真能连上的那个。
   */
  lanAddresses(): string[] {
    const port = this.node?.port ?? this.config.port;
    const host = this.config.host;

    // 只听了某一个地址（比如配置里写死 127.0.0.1）就不能报局域网地址 ——
    // 那是**谎报**：用户照着发过来只会得到"连不上"，而且猜不出为什么。
    if (host && host !== '0.0.0.0' && host !== '::') return [`${host}:${port}`];

    // 内部地址和 docker0 这类虚拟网卡已经在 localAddresses 里滤掉了（`utun` 除外 ——
    // macOS 上 Tailscale 就在那儿，跨网配对靠它）——
    // 列出来只会让用户抄错一个
    return localAddresses().map((ip) => `${ip}:${port}`);
  }

  /**
   * 配对要用的那一行信息。
   *
   * 还没 `start()` 时 `addresses` 是空的（端口号还没有），但码已经有了 ——
   * 命令行是在 `start()` 之后才打的，所以正常情况下两者都齐。
   */
  pairingInfo(): {
    code: string;
    expiresAt: number;
    state: 'live' | 'used' | 'burned';
    addresses: string[];
    /** 只听本机。中枢多半连不上，命令行要**额外提醒一句** */
    loopbackOnly: boolean;
  } {
    const node = this.node;
    const host = this.config.host;
    return {
      code: node?.pairingCode ?? '(还没起来)',
      expiresAt: node?.pairingExpiresAt ?? 0,
      state: node?.pairingState ?? 'live',
      addresses: this.lanAddresses(),
      loopbackOnly: host === '127.0.0.1' || host === 'localhost' || host === '::1',
    };
  }

  /** 换一个新的配对码（`butler node --pair`） */
  refreshPairCode(): string {
    return this.node?.refreshPairCode() ?? '';
  }

  /** 开始接活。幂等：重复调用不会起第二个监听 */
  async start(): Promise<void> {
    if (this.node) return;

    // 身份落盘：**第一次真正上岗的时候**才写。下一次起来就是同一个 id、
    // 同一把密钥，用户不用抄任何东西，中枢那边配过的关系也不会断。
    saveIdentity(this.identityFile, this.identity);

    const node = new LanNode({
      id: this.identity.id,
      alias: this.alias,
      secret: this.identity.secret,
      port: this.config.port,
      host: this.config.host,
      capabilities: this.config.capabilities,
    });
    this.register(node);
    await node.start();          // 端口起不来就抛 —— 装不上要当场知道，不能"看起来在线"
    this.node = node;
  }

  async stop(): Promise<void> {
    const node = this.node;
    this.node = null;
    this.offers.clear();         // 下线的机器上留着凭证没有意义
    if (node) await node.stop();
  }

  // ───────────────────────── 能被远程调用的方法 ─────────────────────────

  private register(node: LanNode): void {
    node.on('agent.run', async (params, call) => {
      const p = (params ?? {}) as { text?: unknown; sessionId?: unknown; cwd?: unknown };
      const text = typeof p.text === 'string' ? p.text : '';
      const sessionId = typeof p.sessionId === 'string' ? p.sessionId : null;
      // 中枢没指定工作目录就用本机配的；都没配就用进程当前目录
      const cwd = (typeof p.cwd === 'string' && p.cwd) || this.config.cwd || process.cwd();

      const result = await this.agent.run({
        text,
        sessionId,
        cwd,
        onProgress: (line) => call.emit(line),
        signal: call.signal,        // 中枢取消了，本机这活儿也该停
      });

      const { files, ...rest } = result;
      // 见文件头：**不透传路径**，改成一张只在自己手里对得上的取件凭证
      return files?.length ? { ...rest, files: files.map((f) => this.offer(f)) } : rest;
    });

    node.on('file.read', async (params) => {
      const p = (params ?? {}) as { token?: unknown; offset?: unknown };
      const token = typeof p.token === 'string' ? p.token : '';
      const offer = this.take(token);
      const offset = Number.isFinite(p.offset) && (p.offset as number) > 0 ? Math.floor(p.offset as number) : 0;

      let handle;
      try {
        handle = await open(offer.path, 'r');
      } catch (error) {
        // 说得具体一点：用户和中枢都需要知道是"不在了"还是"没权限"
        const code = (error as NodeJS.ErrnoException).code;
        const why = code === 'ENOENT' ? '那台电脑上已经没有这个文件了（被移走或删掉了）'
          : code === 'EACCES' ? '那台电脑上这个文件没权限读'
            : `那台电脑上读不了这个文件（${code ?? '未知原因'}）`;
        throw new Error(`${offer.name}：${why}`);
      }

      try {
        const size = (await handle.stat()).size;

        // 用户要的这段已经越过文件尾了 —— 不是错误，是"取完了"。
        // 传输中途文件被改写时也会走到这儿，如实回 eof 而不是抛。
        const len = Math.max(0, Math.min(CHUNK, size - offset));
        let data = '';
        if (len > 0) {
          const buf = Buffer.alloc(len);
          const { bytesRead } = await handle.read(buf, 0, len, offset);
          data = buf.subarray(0, bytesRead).toString('base64');
        }

        return { name: offer.name, caption: offer.caption, size, offset, eof: offset + len >= size, data };
      } finally {
        await handle.close();
      }
    });

    node.on('file.drop', async (params) => {
      const p = (params ?? {}) as { token?: unknown };
      if (typeof p.token === 'string') this.offers.delete(p.token);
      return { ok: true };
    });
  }

  /** 给一个 agent 交出来的文件铸一张取件凭证 */
  private offer(f: { path: string; name?: string; caption?: string }): {
    token: string; name: string; caption?: string;
  } {
    this.prune();
    const token = randomBytes(16).toString('hex');
    const name = f.name || f.path.split(/[\\/]/).pop() || f.path;
    this.offers.set(token, { path: f.path, name, caption: f.caption, at: Date.now() });
    return { token, name, caption: f.caption };
  }

  /** 拿凭证换条子。过期/不认识都当不存在处理（不区分，免得变成探测工具） */
  private take(token: string): Offer {
    this.prune();
    const offer = this.offers.get(token);
    if (!offer) {
      throw new Error('这个附件的取件凭证已经失效了 —— 让发言的那个人重新说一次，文件就会重新准备好');
    }
    return offer;
  }

  /** 清掉过期凭证。顺手做，不单起定时器（节点上没必要多一个心跳） */
  private prune(): void {
    const deadline = Date.now() - OFFER_TTL_MS;
    for (const [token, offer] of this.offers) {
      if (offer.at < deadline) this.offers.delete(token);
    }
  }
}

export default NodeService;
