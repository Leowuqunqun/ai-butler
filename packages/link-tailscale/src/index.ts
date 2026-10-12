/**
 * 尾巴网络链路 —— `ctx.link` 的**第二个真实现**。
 *
 * ── 它换掉的到底是什么 ──────────────────────────────────────────
 *
 * 线上跑的**还是 `link-lan` 那套 HTTP + SSE**，一个字都没改。
 * 换掉的是"**怎么找到那台机器**"：
 *
 * | | `link-lan` | `link-tailscale` |
 * |---|---|---|
 * | 名册哪来的 | 用户手写在配置里的 `peers` | 问 Tailscale：谁在我的网络里 |
 * | 地址怎么来 | 手填的局域网 IP | 尾巴地址（`100.x.y.z`），换网、换 IP 都不变 |
 * | 谁算"我的节点" | 配了就算 | **探一下**：答得上来的才是节点 |
 * | 适用场景 | 同一个 WiFi | 中枢和节点不在一个网络里 |
 *
 * 所以这不是把 `link-lan` 抄了一遍。**同一个包两个实现，只在"发现"这一层分叉**
 * —— 这也正是 `ctx.link` 这个 seam 想验证的东西：换一种找机器的方式，
 * 内核一行都不用改。
 *
 * ── 一个必须讲清楚的安全取舍 ────────────────────────────────────
 *
 * Tailscale 自己已经用 WireGuard + 设备身份把网络封住了，所以有人会问：
 * 那还需要共享密钥吗？**这里仍然要求密钥**（跟 `link-lan` 同一把）。
 *
 * 理由不是不信任 Tailscale，而是"**谁在你的尾巴网络里**"和"**谁能遥控你这台电脑**"
 * 是两件事：你的尾巴网络里可能有家人的设备、可能开着共享节点、
 * 可能哪天加进来一台临时机器。密钥是第二道门，而它几乎不花用户什么力气
 * ——`butler node` 会把配对那一串直接打出来（见 M2 的配对流程）。
 *
 * ── 配对和名册（现在跟局域网那条对齐了）──────────────────────────
 *
 * 用户**不需要**在两台机器上手抄同一把密钥。节点屏幕上打出一句「地址:端口 + 一次性
 * 配对码」，用户抄到微信里发「配对 …」，中枢拿它换回那台机器**自己的**密钥
 * —— 每台一把，一台泄漏不等于全都泄漏 —— 并且当场落盘。重启中枢，名册还在。
 *
 * 原来那条「配一把共享密钥、探全网」照样能用（那只是名册的另一个来源），
 * 但配对是推荐路径：它不要求用户在两台机器上把同一串东西抄对。
 *
 * @module @butler/link-tailscale
 */

import z from '@deepseek-ai/schemastery';
import { LinkService } from '@butler/seam-link';
import type { Context } from '@deepseek-ai/cordis';
import type { DeviceInfo, HealthCheck, LinkSession, PairTarget } from '@butler/seam-link';
import {
  LanSession, defaultPeersFile, loadPeers, normalizePairCode, pairWithNode, pingNode, savePeers,
} from '@butler/link-lan';
import type { StoredPeer } from '@butler/link-lan';

import { explainState, readTailnet } from './tailnet.js';
import type { Tailnet } from './tailnet.js';

export { parseTailnet, readTailnet, explainState, isRunning } from './tailnet.js';
export type { TailPeer, Tailnet } from './tailnet.js';

/** 密钥短于这个长度就报警（跟 link-lan 同一条线） */
const MIN_SECRET = 12;

/**
 * 一次 discovery 最多探几台。
 *
 * 尾巴网络可能是共享的、可能有几十台设备。全都探一遍既慢又像在扫人家网。
 * 个人的尾巴网络通常两三台，这个上限只是防意外。
 */
const MAX_PROBE = 32;

interface TailscaleLinkConfig {
  secret: string;
  binary: string;
  port: number;
  ownOnly: boolean;
  cacheMs: number;
  cliTimeoutMs: number;
  pingTimeoutMs: number;
  idleTimeoutMs: number;
  /** 配对收下的设备记在哪个文件。空串 = 用尾巴网络那份默认名册 */
  peersFile: string;
  pairTimeoutMs: number;
}

/** 一个管家节点怎么找到 */
interface Found {
  address: string;
  alias: string;
  os: string;
  capabilities: string[];
  /** 它是**哪个尾巴设备**报上来的。用来判断"两台机器是不是撞名了"。配对收下的没有 */
  tailId: string;
  /** 这台自己的密钥（配对时它交出来的）。探全网探到的那些没有 */
  secret?: string;
  /** 它听哪个端口。配对时它自己报的；探全网探到的那些按链路的默认端口算 */
  port?: number;
}

export class TailscaleLink extends LinkService {
  static Config = z.object({
    secret: z.string().default(''),
    binary: z.string().default('tailscale'),
    port: z.number().default(41338),
    ownOnly: z.boolean().default(true),
    cacheMs: z.number().default(5000),
    cliTimeoutMs: z.number().default(4000),
    pingTimeoutMs: z.number().default(800),
    idleTimeoutMs: z.number().default(120_000),
    peersFile: z.string().default(''),
    pairTimeoutMs: z.number().default(5000),
  });

  readonly config: TailscaleLinkConfig;
  readonly id = 'tailscale';

  private readonly sessions = new Map<string, LanSession>();
  /** 见过的管家节点。**进程内保留**，这样关机了也还能显示"离线" */
  private readonly known = new Map<string, Found>();
  /** 最后一次听到某台设备的时间 */
  private readonly lastSeenAt = new Map<string, number>();
  private cache: { at: number; byId: Map<string, Found>; answered: Set<string> } | null = null;
  /** **配对收下的**那些。从名册文件读进来，收新的就写回去 */
  private readonly adopted = new Map<string, StoredPeer>();
  /** 名册文件在哪 */
  private readonly peersFile: string;

  constructor(ctx: Context, config: TailscaleLinkConfig) {
    super(ctx);
    // 这里**故意不拦空密钥**：一句话都不配就起来是合法的第一步 —— 设备是后来在微信里
    // 「配对」收进来的，每台带一把自己的密钥（节点自己生成的那把）。
    // 真的什么都没配时，check() 会说清楚下一步该做什么，而不是让人对着一个起不来的进程。
    this.config = config;
    this.peersFile = config.peersFile || defaultPeersFile('tailscale-peers.json');
    // 读不动会抛（见 link-lan/peers.ts 的说明：读不动不许当成空名册）
    for (const peer of loadPeers(this.peersFile)) this.adopted.set(peer.id, peer);
  }

  /**
   * 现在看得见哪些设备。
   *
   * 跟 `link-lan` 的语义差别在这一句：**答得上来的才算管家**。
   * 尾巴网络里有打印机、有 NAS、有同事的电脑 —— 它们不是"离线的节点"，
   * 它们根本不是节点，所以不会被列出来。
   */
  async discover(): Promise<DeviceInfo[]> {
    const { byId, answered } = await this.survey();
    return [...byId.entries()].map(([id, f]) => ({
      id,
      alias: f.alias,
      os: f.os,
      capabilities: f.capabilities,
      lastSeen: this.lastSeenAt.get(id) ?? null,
      online: answered.has(id),
      link: this.id,
    } satisfies DeviceInfo));
  }

  /**
   * 连一台设备。
   *
   * 先握手再返回会话：**连不上就当场抛**（跟 `link-lan` 同一条承诺）。
   */
  async connect(deviceId: string): Promise<LinkSession> {
    const { byId } = await this.survey();
    const found = byId.get(deviceId);
    if (!found) {
      const known = [...byId.values()].map((f) => f.alias).join('、') || '一台都没有';
      throw new Error(
        `不认识这台设备：${deviceId}。尾巴网络里现在看得见的管家是：${known}`,
      );
    }

    // ⚠️ 端口必须按**那台机器自己报的**来：配对时它交了自己的端口，
    // 链路的 `port` 只是"探全网"那个模式下的缺省（当年写死成 config.port，
    // 结果节点只要不在 41338 上，配对成功了也连不上）
    const port = found.port ?? this.config.port;
    const ping = await pingNode({
      secret: this.secretFor(found),
      host: found.address,
      port,
      timeoutMs: this.config.pingTimeoutMs,
    });
    if (!ping) {
      const seen = this.lastSeenAt.get(deviceId) ?? null;
      throw new Error(
        `连不上${found.alias}${seen ? `（最后在线 ${new Date(seen).toLocaleString('zh-CN')}）` : ''}。` +
        '它可能关机了，或者那台电脑上的 Tailscale 没连上',
      );
    }
    this.lastSeenAt.set(deviceId, Date.now());

    // 缓存放在验活之后 —— 跟 link-lan 同一个理由：不能返回一个已经死了的会话
    const cached = this.sessions.get(deviceId);
    if (cached && !cached.isClosed) return cached;

    const session = new LanSession(deviceId, `http://${found.address}:${port}`, this.secretFor(found), {
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
    session.onClose(() => this.sessions.delete(deviceId));
    this.sessions.set(deviceId, session);
    return session;
  }

  /**
   * **收下一台新设备**（配对）。
   *
   * 跟局域网那条走的是**同一套握手、同一个协议**（`link-lan` 的 `x-butler-pair`
   * + `link.pair`），差别只在"地址从哪来"：那边通常是同网段的 IP，这边是尾巴地址。
   * 密钥只在这一条链路上从节点流向中枢，**微信那边自始至终没看见过它**。
   *
   * 收下之后立刻落盘：用户配过一次的关系，不该因为中枢重启就没了。
   */
  override async pair(target: PairTarget): Promise<DeviceInfo> {
    const host = String(target?.host ?? '').trim();
    if (!host) {
      throw new Error('配对要知道那台电脑的地址。那台电脑上 butler node 起来之后会打出一行，照着发就行');
    }

    const code = normalizePairCode(target?.code ?? '');
    if (code.length !== 6) {
      throw new Error('配对码是 6 位（形如 4A7-K2M）。对着那台电脑屏幕上的那一串再抄一次');
    }

    const port = target.port ?? this.config.port;
    const got = await pairWithNode({ host, port, code, timeoutMs: this.config.pairTimeoutMs });

    const peer: StoredPeer = { id: got.id, alias: got.alias, host, port, secret: got.secret };
    // 之前配过同一台（换了地址、或者重配了一次）：换掉旧的，别留两份
    for (const [id, old] of this.adopted) {
      if (id !== peer.id && old.host === peer.host && old.port === peer.port) this.adopted.delete(id);
    }
    this.adopted.set(peer.id, peer);
    this.persist();

    // 名册变了：缓存作废，旧会话也作废（密钥可能是上一把）
    this.cache = null;
    this.dropSession(peer.id);

    return {
      id: peer.id,
      alias: peer.alias,
      os: got.os,
      capabilities: got.capabilities,
      lastSeen: Date.now(),
      online: true,
      link: this.id,
    };
  }

  /**
   * 忘掉一台设备。返回的是一个**结论**，人话由调用处拼。
   *
   * 只有**配对收下的**能忘。尾巴网络里探到的那些本来就没存下来（它的名册在
   * Tailscale 手里），说成 `unknown` 比假装忘掉了更诚实。
   */
  override async forget(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'> {
    if (!this.adopted.has(deviceId)) {
      return this.known.has(deviceId) ? 'static' : 'unknown';
    }
    this.adopted.delete(deviceId);
    this.persist();
    this.cache = null;
    this.dropSession(deviceId);
    this.known.delete(deviceId);
    this.lastSeenAt.delete(deviceId);
    return 'forgotten';
  }

  /** 把名册写回文件 */
  private persist(): void {
    savePeers(this.peersFile, [...this.adopted.values()]);
  }

  /** 这台设备用哪把密钥：它自己那把（配对来的），或者配置里那把共享的 */
  private secretFor(found: Found): string {
    return found.secret || this.config.secret;
  }

  /** 让某台设备的缓存会话作废（密钥换了、设备忘了） */
  private dropSession(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    this.sessions.delete(deviceId);
    if (session && !session.isClosed) void session.close().catch(() => { /* 已经断了 */ });
  }

  /**
   * 自检。
   *
   * 这条链路要问一下 CLI，所以是异步的（`ctx.link` 的 `check()` 本来就允许
   * `Promise | 同步` 两可 —— 这里的结论是：**不用改 seam**）。
   *
   * **故意不探节点**，跟 `link-lan` 一致：那台电脑没开是"你没开电脑"，
   * 不是"配置错了"。doctor 要回答的是后者。
   */
  override async check(): Promise<HealthCheck[]> {
    const items: HealthCheck[] = [];

    // 密钥不再是必填：配对是推荐路径。所以这里只在**确实配了**的时候看它够不够长，
    // 没配不是错误 —— 那只是"还没收设备"（下面那条会说下一步做什么）
    const weak = this.config.secret.length > 0 && this.config.secret.length < MIN_SECRET;
    items.push({
      name: '共享密钥',
      ok: !weak,
      detail: weak
        ? `只有 ${this.config.secret.length} 位，太短了（建议至少 ${MIN_SECRET} 位）`
        : this.config.secret
          ? `已配置（${this.config.secret.length} 位）`
          : '没配。**配对收设备的方式不需要它** —— 那台电脑自己的密钥会在配对时交给中枢',
      fix: weak ? '换一个长一点的随机串：`openssl rand -hex 16`' : undefined,
    });

    // 一台设备都没有时说清楚第一步，而不是让人对着空列表猜
    items.push({
      name: '配对过的设备',
      ok: this.adopted.size > 0 || this.config.secret.length > 0,
      detail: this.adopted.size > 0
        ? `${this.adopted.size} 台（记在 ${this.peersFile}，重启还在）`
        : this.config.secret.length > 0
          ? '没有配对的，但配了共享密钥 —— 现在按"探全网"的方式找节点'
          : '还没有。去那台电脑上跑 `butler node`，它会打出一行「地址 配对码」，把那一行发到微信里就行',
      fix: this.adopted.size === 0 && this.config.secret.length === 0
        ? '在微信里发：配对 <那台电脑打出来的地址> <配对码>'
        : undefined,
    });

    let net: Tailnet | null = null;
    try {
      net = await readTailnet({ binary: this.config.binary, timeoutMs: this.config.cliTimeoutMs });
    } catch (error) {
      items.push({
        name: '尾巴网络',
        ok: false,
        detail: (error as Error).message,
        fix: '装好 Tailscale 并登录，或者改用局域网链路（@butler/link-lan）',
      });
    }

    if (net) {
      const bad = explainState(net.backendState);
      items.push({
        name: '尾巴网络',
        ok: !bad,
        detail: bad ?? `在跑。${this.config.ownOnly ? '你自己的' : ''}设备有 ${net.peers.length} 台`
          + `（管家节点要连上才知道，自检不打扰它们）`,
        fix: bad ? '在那台电脑上把 Tailscale 打开、登录' : undefined,
      });
    }

    return items;
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 问一次尾巴网络 + 探一遍候选。
   *
   * 结果缓存 `cacheMs`：微信里每说一句 `@那台机器` 都要认一次路，
   * 每次都去 fork 一个 CLI 太浪费。缓存只在"找机器"这一层，
   * `connect()` 仍然会当场握手 ✅。
   */
  private async survey(): Promise<{ byId: Map<string, Found>; answered: Set<string> }> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < this.config.cacheMs) return cached;

    const now = Date.now();
    const answered = new Set<string>();

    // ① 配对收下的：地址和密钥都是它自己给的，**不依赖尾巴网络读不读得动**
    await Promise.all([...this.adopted.values()].map(async (peer) => {
      const before = this.known.get(peer.id);
      const ping = await pingNode({
        secret: peer.secret ?? this.config.secret,
        host: peer.host,
        port: peer.port,
        timeoutMs: this.config.pingTimeoutMs,
      });
      // 关机的也留在名册里（显示离线），但**不许**把它的地址和密钥覆盖掉 ——
      // 那两样是配对时它自己给的，比探活更有权威
      this.known.set(peer.id, {
        address: peer.host,
        alias: ping?.alias || peer.alias,
        os: ping?.os ?? before?.os ?? 'unknown',
        capabilities: ping?.capabilities ?? before?.capabilities ?? [],
        tailId: before?.tailId ?? '',
        secret: peer.secret,
        port: peer.port,
      });
      if (ping) {
        this.lastSeenAt.set(peer.id, now);
        answered.add(peer.id);
      }
    }));

    // ② 尾巴网络里探到的那些。**没配共享密钥就不探** —— 拿一把空密钥去敲一整张网
    //    既是白费力气，也像在扫人家网。配对收下的那些（①）不受这里影响。
    let net: Tailnet | null = null;
    if (this.config.secret) {
      try {
        net = await readTailnet({ binary: this.config.binary, timeoutMs: this.config.cliTimeoutMs });
        const bad = explainState(net.backendState);
        if (bad) throw new Error(bad);
      } catch (error) {
        // 一台配对过的都没有时，"尾巴网络读不动"就是这个功能的全部答案 —— 抛出去，
        // 让 doctor 和微信看见真正的原因。手里有配对过的，就先把它们列出来
        // （网络那件事由 check() 去说，不在这儿把人堵死）
        if (this.adopted.size === 0) throw error;
      }
    }

    if (net) await Promise.all(net.peers.slice(0, MAX_PROBE).map(async (peer) => {
      if (!peer.address) return;      // 没有 IPv4 尾巴地址的跳过，见 tailnet.ts 的说明

      const ping = await pingNode({
        secret: this.config.secret,
        host: peer.address,
        port: this.config.port,
        timeoutMs: this.config.pingTimeoutMs,
      });
      if (!ping) return;

      // 两台**不同的尾巴设备**报了同一个管家 id —— 这是配置错误，
      // 而且会安静地指错机器，必须在发现的时候就说。
      //
      // 判据用的是"尾巴设备 id"，不是地址：地址只是"怎么够得着"，
      // 换个网段、换个 IP 都是同一台机器；而尾巴设备 id 才代表一台机器。
      const clash = this.known.get(ping.id);
      if (clash && clash.tailId !== peer.id) {
        throw new Error(
          `有两台电脑的节点 id 都是「${ping.id}」（${clash.alias} 和 ${peer.hostName || peer.address}）。` +
          '去其中一台的配置里把 id 改成不一样的，否则你 @ 的时候可能指到另一台去',
        );
      }

      this.known.set(ping.id, {
        address: peer.address,
        alias: ping.alias || peer.hostName,
        os: ping.os,
        capabilities: ping.capabilities,
        tailId: peer.id,
      });
      this.lastSeenAt.set(ping.id, now);
      answered.add(ping.id);
    }));

    this.cache = { at: now, byId: this.known, answered };
    return this.cache;
  }
}

export default TailscaleLink;
