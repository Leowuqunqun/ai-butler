/**
 * 局域网链路 —— `ctx.link` 的第一个真实现。
 *
 * ── 这个包同时给了两半 ──────────────────────────────────────────
 *
 *   - **中枢侧**：`LanLink`，一个 cordis 插件，注册成 `ctx.link`
 *   - **节点侧**：`LanNode`，跑在被遥控的那台电脑上，听 HTTP、派发方法
 *
 * 两半放一个包，因为它们共用线协议（`protocol.ts`）——
 * 拆开就得再抽一个协议包，收益不抵成本。
 *
 * ── 为什么局域网这一条先做 ──────────────────────────────────────
 *
 * 它是**唯一不需要任何外部依赖**的链路：不用装 Tailscale、不用开端口、
 * 不用注册任何账号。两台机器连同一个 WiFi 就能跑通。
 * 先用它把 `ctx.link` 的契约验证扎实，Tailscale 那条照着实现就行。
 *
 * ── 安全边界（重要）─────────────────────────────────────────────
 *
 * 局域网是**共享介质**。同一个咖啡馆 WiFi 上，任何人都在同一个广播域里，
 * 都能扫到这个端口。所以：
 *
 *   - `secret` **必填**，没有它这个插件根本起不来；
 *   - 认证在**读第一个字节之前**完成（见 `server.ts`）；
 *   - 密钥比较用常量时间（防逐字节试探）。
 *
 * 别把 `secret` 设成 `'123'`。自检里有一条会专门为此报警。
 *
 * @module @butler/link-lan
 */

import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import { LinkService } from '@butler/seam-link';
import type { DeviceInfo, HealthCheck, LinkSession, PairTarget } from '@butler/seam-link';

import { LanSession } from './client.js';
import { defaultPeersFile, normalizePairCode } from './identity.js';
import { pairWithNode } from './pair.js';
import type { StoredPeer } from './peers.js';
import { loadPeers, savePeers } from './peers.js';
import { pingNode } from './ping.js';
import { LanNode } from './server.js';
import type { PingResult } from './server.js';

export * from './protocol.js';
export { LanNode } from './server.js';
export type { CallContext, LanNodeOptions, MethodHandler, PingResult } from './server.js';
export { LanSession } from './client.js';
export type { LanSessionOptions } from './client.js';
export { pingNode } from './ping.js';
export type { PingOptions } from './ping.js';
export { pairWithNode } from './pair.js';
export type { PairOptions, PairPayload } from './pair.js';
export { loadPeers, savePeers } from './peers.js';
export type { StoredPeer } from './peers.js';
export {
  defaultIdentityFile, defaultPeersFile, defaultStateDir,
  isUsableInterface, loadIdentity, localAddresses, newPairCode, newNodeId, newSecret,
  normalizePairCode, samePairCode, saveIdentity,
} from './identity.js';
export type { NodeIdentity } from './identity.js';

/**
 * 一个已登记的节点。
 *
 * 两条来路：**你手写在配置里的**，和**配对收下的**（存在名册文件里）。
 * 同 id 时配对收下的那份赢 —— 因为它是那台机器当下真实的样子。
 */
export interface PeerConfig extends StoredPeer {
  /** 中枢这台机器自己的标记（可选）。给了就会在自检里显示 */
  note?: string;
}

/**
 * 单台节点的 schema。
 *
 * ⚠️ **类型必须显式写出来**（`z<{...}>`），不能靠推断。理由：
 * 嵌套对象（`z.array(z.object({...}))`）的推断类型会引用到 schemastery 内部的
 * cosmokit 类型，而 `.d.ts` 里没法给那个类型起名字 —— TS2742：
 * "The inferred type of 'Config' cannot be named without a reference to cosmokit"。
 * 本项目其他包的 Config 都是平铺的，所以只有这里撞上了。
 */

const PeerSchema: z<{ id: string; alias: string; host: string; port: number; secret: string; note: string }> = z.object({
  id: z.string().default(''),
  alias: z.string().default(''),
  host: z.string().default(''),
  port: z.number().default(41338),
  secret: z.string().default(''),
  note: z.string().default(''),
});

/** 密钥短于这个长度就报警。局域网里暴力猜一个 4 位串是几分钟的事 */
const MIN_SECRET = 12;

/**
 * 中枢侧没有"端口"这个概念（每台设备自己带一个），
 * 所以配对时用户只写了地址的话，按节点的默认端口来。
 * 节点打给用户的那一行里永远是 `IP:端口`，所以这条只是兜底。
 */
const DEFAULT_PORT = 41338;

interface LanLinkConfig {
  secret: string;
  peers: PeerConfig[];
  /** 配对收下的设备记在哪个文件。空串 = 不落盘（重启就忘） */
  peersFile: string;
  idleTimeoutMs: number;
  pingTimeoutMs: number;
  pairTimeoutMs: number;
}

export class LanLink extends LinkService {
  // 全部给 default、不用 .required() —— 这是本项目的既定写法：
  // static Config **拦不住漏填**（实测，见 ARCH-technical §5），所以必填在构造函数里拦。
  // 另外 .required() 会让静态推断出来的类型引用到 cosmokit 内部类型（TS2742），给 default 就没这问题。
  static Config = z.object({
    secret: z.string().default(''),
    peers: z.array(PeerSchema).default([]),
    peersFile: z.string().default(''),
    idleTimeoutMs: z.number().default(120_000),
    pingTimeoutMs: z.number().default(800),
    pairTimeoutMs: z.number().default(5000),
  });

  readonly config: LanLinkConfig;
  readonly id = 'lan';

  /** 手写在配置里的那些设备 */
  private readonly staticPeers: PeerConfig[];
  /** **配对收下的**那些。从名册文件读进来，收新的就写回去 */
  private readonly adopted = new Map<string, StoredPeer>();
  /** 名册文件在哪（空串 = 用默认位置） */
  private readonly peersFile: string;

  /** 每条会话缓存着复用：反复 connect 同一台不该反复握手 */
  private readonly sessions = new Map<string, LanSession>();
  /** 最后一次听到某台设备的时间。**跨调用保留** —— 用户要的是"最后在线 3 小时前" */
  private readonly lastSeen = new Map<string, number>();

  constructor(ctx: Context, config: LanLinkConfig) {
    super(ctx);
    // 节点清单里缺 id / 别名 / 地址，都是"配置写错了"。当场说清楚，
    // 比之后在微信里显示一台叫「」、地址是空的设备要好得多。
    const broken = config.peers.filter((p) => !p.id || !p.alias || !p.host);
    if (broken.length) {
      throw new Error(
        `配置里有 ${broken.length} 台节点缺了 id、别名或地址：` +
        `${broken.map((p) => p.id || '(没写 id)').join('、')}。三样都得写，别名就是你在微信里叫它的名字`,
      );
    }

    // 密钥的规矩跟着配对变了：**中枢可以一把都不配** —— 设备是配对收上来的，
    // 每台带一把自己的密钥（节点自己生成的那把）。
    //
    // 但**手写在配置里的**设备必须有个密钥来源：它自己没带，配置里也没有，
    // 那连上去只会得到一个 401，而用户从现象里看不出是为什么。
    const naked = config.peers.filter((p) => !p.secret && !config.secret);
    if (naked.length) {
      throw new Error(
        `配置里有 ${naked.length} 台设备没给密钥（${naked.map((p) => p.alias).join('、')}），` +
        '配置里也没有共享密钥（secret）。局域网里同一网络的任何人都够得着这个端口 —— ' +
        '要么给它们各配一把 secret，要么别手写，改用微信里的「配对」把它们收进来。',
      );
    }

    this.config = config;
    this.staticPeers = config.peers;
    this.peersFile = config.peersFile || defaultPeersFile();
    // 配对收下的那些：进程一起来就把名册读回来。读不动会抛（见 peers.ts 的说明）
    for (const peer of loadPeers(this.peersFile)) this.adopted.set(peer.id, peer);
  }

  // ───────────────────────── 名册 ─────────────────────────

  /**
   * 现在认识哪些设备：**配置里手写的 + 配对收下的**。
   *
   * 同一个 id 两边都有时，**配对收下的赢** —— 它是那台机器当下真实的样子
   * （别名、地址、密钥都是它刚报的），而配置里那份可能是很久以前抄的。
   */
  private allPeers(): PeerConfig[] {
    const byId = new Map<string, PeerConfig>();
    for (const p of this.staticPeers) byId.set(p.id, p);
    for (const [id, p] of this.adopted) byId.set(id, p);
    return [...byId.values()];
  }

  /** 这台设备用哪把密钥：它自己的，或者配置里那把共享的 */
  private secretFor(peer: PeerConfig): string {
    return peer.secret || this.config.secret;
  }

  /**
   * **收下一台新设备**（配对）。
   *
   * 凭据是那台电脑屏幕上的一次性配对码 —— 用户抄到微信里发过来，
   * 这里拿它去换回那台机器的身份和密钥。**密钥只在这条链路上走，不进微信**。
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

    const port = target.port ?? DEFAULT_PORT;
    const got = await pairWithNode({ host, port, code, timeoutMs: this.config.pairTimeoutMs });

    const peer: StoredPeer = { id: got.id, alias: got.alias, host, port, secret: got.secret };
    // 之前配过同一台（换了地址、或者重配了一次）：换掉旧的，别留两份
    for (const [id, old] of this.adopted) {
      if (id !== peer.id && old.host === peer.host && old.port === peer.port) this.adopted.delete(id);
    }
    this.adopted.set(peer.id, peer);
    this.persist();

    // 之前缓存着这台机器的旧会话（密钥可能是上一把），得让它作废
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
   * `static` 这一种是刻意的：手写在配置里的设备不该在微信里被"忘掉" ——
   * 那样用户下次重启，它又回来了，只会更困惑。
   */
  override async forget(deviceId: string): Promise<'forgotten' | 'unknown' | 'static'> {
    if (!this.adopted.has(deviceId)) {
      return this.staticPeers.some((p) => p.id === deviceId) ? 'static' : 'unknown';
    }
    this.adopted.delete(deviceId);
    this.persist();
    this.dropSession(deviceId);
    this.lastSeen.delete(deviceId);
    return 'forgotten';
  }

  /** 把名册写回文件。没配文件名就不落盘 */
  private persist(): void {
    savePeers(this.peersFile, [...this.adopted.values()]);
  }

  /** 让某台设备的缓存会话作废（密钥换了、设备忘了） */
  private dropSession(deviceId: string): void {
    const session = this.sessions.get(deviceId);
    this.sessions.delete(deviceId);
    if (session && !session.isClosed) void session.close().catch(() => { /* 已经断了 */ });
  }

  /**
   * 现在看得见哪些设备。
   *
   * **配了几台就报几台**，连不上的也在里面（`online: false`）。
   * 每一台都用一个有时限的握手探活，所以这个调用最多等 `pingTimeoutMs`
   * —— 不会因为某台机器关机就一直卡着。
   */
  async discover(): Promise<DeviceInfo[]> {
    const now = Date.now();
    return Promise.all(this.allPeers().map(async (peer) => {
      const ping = await this.ping(peer);
      if (ping) this.lastSeen.set(peer.id, now);
      const seen = this.lastSeen.get(peer.id) ?? null;
      return {
        id: peer.id,
        alias: peer.alias,
        os: ping?.os ?? 'unknown',
        capabilities: ping?.capabilities ?? [],
        lastSeen: seen,
        online: ping !== null,
        link: this.id,
      } satisfies DeviceInfo;
    }));
  }

  /**
   * 连一台设备。
   *
   * 先握手再返回会话：**连不上就当场抛**，不返回一个半死的会话 ——
   * 否则失败会拖到第一次 `request()` 才暴露，中间那段时间调用方以为一切正常。
   */
  async connect(deviceId: string): Promise<LinkSession> {
    const peer = this.allPeers().find((p) => p.id === deviceId);
    if (!peer) {
      const known = this.allPeers().map((p) => `${p.alias}(${p.id})`).join('、') || '一台都没有';
      throw new Error(`不认识这台设备：${deviceId}。现在认识的节点是：${known}`);
    }

    const ping = await this.ping(peer);
    if (!ping) {
      const seen = this.lastSeen.get(peer.id) ?? null;
      throw new Error(
        seen
          ? `连不上${peer.alias}（最后在线 ${new Date(seen).toLocaleString('zh-CN')}）。它可能关机了，或者不在同一个网络里`
          : `连不上${peer.alias}。它可能关机了，或者不在同一个网络里`,
      );
    }
    this.lastSeen.set(peer.id, Date.now());

    // 缓存**放在验活之后**：先复用、不验活的话，节点已经关机时 connect 会
    // 高高兴兴返回一个死会话，失败拖到第一次 request 才暴露 —— 那就违背了
    // "连不上要当场抛"这条承诺，调用方中间那段时间以为自己连上了。
    const cached = this.sessions.get(deviceId);
    if (cached && !cached.isClosed) return cached;

    const session = new LanSession(peer.id, `http://${peer.host}:${peer.port}`, this.secretFor(peer), {
      idleTimeoutMs: this.config.idleTimeoutMs,
    });
    // 会话脱落时把它从缓存里摘掉，下次 connect 会重新握手
    session.onClose(() => this.sessions.delete(peer.id));
    this.sessions.set(peer.id, session);
    return session;
  }

  /**
   * 自检。
   *
   * **故意不去 ping 节点** —— 那是"重活"，而且节点关机的自检结果是
   * "你没开那台电脑"，不是"配置错了"。doctor 要回答的是后者。
   */
  override check(): HealthCheck[] {
    const items: HealthCheck[] = [];
    const peers = this.allPeers();
    const adopted = this.adopted.size;

    // 「一台都没配」不算错 —— 配对是后发生的：管家可以先起来，
    // 用户再到那台电脑上拿配对码。所以这里给的是**下一步做什么**，不是红叉。
    items.push({
      name: '认识的设备',
      ok: true,
      detail: peers.length
        ? `${peers.length} 台：${peers.map((p) => p.alias).join('、')}`
          + (adopted ? `（其中 ${adopted} 台是配对收下的，记在 ${this.peersFile}）` : '')
        : '一台都还没有。管家现在只知道这台电脑',
      fix: peers.length
        ? undefined
        : '在另一台电脑上起 `butler node`，把它屏幕上打出的那一行发到微信里（形如「配对 192.168.1.9:41338 4A7-K2M」）',
    });

    // 密钥：**中枢这边可以一把都不配**（配对收下的设备各自带密钥）。
    // 要查的是"每台是不是都有得用"。
    const missing = peers.filter((p) => !p.secret && !this.config.secret);
    const weak = [this.config.secret, ...peers.map((p) => p.secret ?? '')]
      .filter((x) => x && x.length < MIN_SECRET);
    items.push({
      name: '密钥',
      ok: missing.length === 0 && weak.length === 0,
      detail: missing.length
        ? `${missing.map((p) => p.alias).join('、')} 没密钥可用 —— 连上去也只会被拒`
        : weak.length
          ? `有 ${weak.length} 把太短了（建议至少 ${MIN_SECRET} 位）`
          : this.config.secret
            ? `配置里那把 + ${adopted} 台自带的，都在`
            : `${peers.length} 台设备各自带一把（配对时从那台机器上换回来的）`,
      fix: missing.length
        ? '给这几台各配一把 secret，或者把它们从配置里去掉、改用微信里的「配对」收进来'
        : weak.length
          ? '换一个长一点的随机串：`openssl rand -hex 16`'
          : undefined,
    });

    return items;
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * 有超时的握手。连不上返回 null —— discover 靠它填 `online`。
   *
   * 实现抽在 `ping.ts` 里：`link-tailscale` 也要用同一份（见那个文件的说明）。
   */
  private ping(peer: PeerConfig): Promise<PingResult | null> {
    return pingNode({
      secret: this.secretFor(peer),
      host: peer.host,
      port: peer.port,
      timeoutMs: this.config.pingTimeoutMs,
    });
  }
}

export default LanLink;
