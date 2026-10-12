/**
 * 读尾巴网络（Tailscale）的名册。
 *
 * 这里只做两件事：**问 CLI 要 JSON**、**把 JSON 解析成我们认的形状**。
 * 不碰网络、不碰 cordis —— 所以它可以拿真实输出当夹具直接测。
 *
 * ── 为什么用 `tailscale status --json` 而不是自己扫网段 ──────────
 *
 * 尾巴网络自己就有一份**权威名册**：谁在这个网络里、谁在线、
 * 上次什么时候在线、是什么系统。自己扫网段要猜地址、要等超时，
 * 还得处理 DHCP 换 IP —— 而这份名册是现成的、准的。
 *
 * ── 一个刻意的选择：只用 IPv4 的尾巴地址 ────────────────────────
 *
 * `TailscaleIPs` 里通常同时有 `100.x.y.z` 和 `fd7a:…` 两条。
 * 我们只用前者：IPv6 那条在 fetch 里要加方括号、还可能被本机的
 * IPv6 路由策略影响，多一类失败原因不值得。**纯 IPv6 的尾巴网络现在不支持**
 * —— 这种网络很少见，真遇到了会在这里说清楚，而不是留一个诡异的超时。
 *
 * @module @butler/link-tailscale/tailnet
 */

import { execFile } from 'node:child_process';

/** 尾巴网络里的一台设备 */
export interface TailPeer {
  /** Tailscale 的稳定设备 ID（换 IP、改名都不变） */
  id: string;
  /** 用户在 Tailscale 里给这台机器起的名字 */
  hostName: string;
  /** MagicDNS 名，比如 `home.tail435adc.ts.net`（末尾的点已经去掉）。**只用来显示** */
  dnsName: string;
  os: string;
  /** IPv4 的尾巴地址（100.x.y.z）。没找到就是空串 */
  address: string;
  online: boolean;
  /** 上次在线（毫秒时间戳）。从没在线过是 null */
  lastSeen: number | null;
}

export interface Tailnet {
  /** `Running` 才是能用。别的一律按"还没准备好"处理 */
  backendState: string;
  /** 这台机器自己的 Tailscale 用户 ID —— 用来只挑**主人自己的**设备 */
  selfUserId: string;
  selfDnsName: string;
  peers: TailPeer[];
}

/** 这台机器在尾巴网络里的状态是不是"能用" */
export function isRunning(state: string): boolean {
  return state === 'Running';
}

/**
 * 状态码 → 一句人话。能用就返回 null。
 *
 * 这些字符串是给**完全不懂技术的人**看的：不该出现 "BackendState: NeedsLogin"。
 */
export function explainState(state: string): string | null {
  if (state === 'Running') return null;
  if (state === 'NeedsLogin') return 'Tailscale 还没登录 —— 在那台电脑上打开 Tailscale 登一下';
  if (state === 'NeedsMachineAuth') return '这台电脑还没被批准加入尾巴网络 —— 去 Tailscale 后台点一下批准';
  if (state === 'Stopped') return 'Tailscale 没在跑 —— 把它打开';
  if (state === 'Starting') return 'Tailscale 正在启动，稍等一下再试';
  return `Tailscale 现在用不了（状态是 ${state}）`;
}

/**
 * 把 `tailscale status --json` 的输出解析成名册。
 *
 * `ownOnly` 默认开着：**只认主人自己的设备**。
 * 公司尾巴网络里可能有几十台同事的机器 —— 全都探一遍是骚扰，
 * 而且把同事的电脑列进"我的设备"更是错的。
 */
export function parseTailnet(raw: unknown, ownOnly = true): Tailnet {
  const d = (raw ?? {}) as {
    BackendState?: unknown;
    Self?: { UserID?: unknown; DNSName?: unknown };
    Peer?: Record<string, unknown>;
  };

  const selfUserId = d.Self?.UserID === undefined ? '' : String(d.Self.UserID);
  const selfDnsName = trimDot(typeof d.Self?.DNSName === 'string' ? d.Self.DNSName : '');

  const peers: TailPeer[] = [];
  for (const [key, value] of Object.entries(d.Peer ?? {})) {
    const p = (value ?? {}) as {
      ID?: unknown; UserID?: unknown; HostName?: unknown; DNSName?: unknown;
      OS?: unknown; TailscaleIPs?: unknown; Online?: unknown; LastSeen?: unknown;
    };

    // 别人的设备：跳过（除非配置里明说要全都看）
    if (ownOnly && selfUserId && p.UserID !== undefined && String(p.UserID) !== selfUserId) continue;

    const lastSeen = typeof p.LastSeen === 'string' ? Date.parse(p.LastSeen) : NaN;
    peers.push({
      id: typeof p.ID === 'string' && p.ID ? p.ID : key,
      hostName: typeof p.HostName === 'string' ? p.HostName : '',
      dnsName: trimDot(typeof p.DNSName === 'string' ? p.DNSName : ''),
      os: typeof p.OS === 'string' ? p.OS : 'unknown',
      address: firstIPv4(p.TailscaleIPs),
      online: p.Online === true,
      lastSeen: Number.isFinite(lastSeen) ? lastSeen : null,
    });
  }

  // 名字稳定一点：设备多的时候列表别每次都换顺序
  peers.sort((a, b) => a.hostName.localeCompare(b.hostName));

  return {
    backendState: typeof d.BackendState === 'string' ? d.BackendState : 'Unknown',
    selfUserId,
    selfDnsName,
    peers,
  };
}

export interface ReadTailnetOptions {
  /** CLI 可执行文件。默认 `tailscale`，测试里指向一个假 CLI */
  binary?: string;
  timeoutMs?: number;
}

/**
 * 问 CLI 要名册。
 *
 * 失败一律抛**人话**：找不到命令、没登录、超时、输出看不懂，
 * 四种情况用户要做的事完全不同，不能都糊成"链路不可用"。
 */
export async function readTailnet(options: ReadTailnetOptions = {}): Promise<Tailnet> {
  const binary = options.binary || 'tailscale';
  const timeoutMs = options.timeoutMs ?? 4000;
  const out = await run(binary, ['status', '--json'], timeoutMs);

  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    throw new Error(`${binary} status --json 的输出看不懂（可能版本差太多）。升级一下 Tailscale 再试`);
  }
  return parseTailnet(raw);
}

/** 跑一下 CLI，把 stdout 拿回来。所有失败都翻成人话 */
function run(binary: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);

      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return reject(new Error(
          `找不到 ${binary} 命令。这台电脑上得先装好 Tailscale 并登录；` +
          '已经装了的话，把配置里的 binary 指到它的完整路径',
        ));
      }
      if ((error as { killed?: boolean }).killed) {
        return reject(new Error(`${binary} status 卡住了（超过 ${Math.round(timeoutMs / 1000)} 秒没回应）`));
      }
      const why = String(stderr || '').trim().split('\n')[0];
      return reject(new Error(`${binary} status 失败了${why ? `：${why}` : `（退出码 ${(error as { code?: number }).code ?? '?'}）`}`));
    });
  });
}

/** 尾巴地址里挑出 IPv4 那条。见文件头：IPv6 现在不用 */
function firstIPv4(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const ip of value) {
    if (typeof ip === 'string' && ip.includes('.') && !ip.includes(':')) return ip;
  }
  return '';
}

const trimDot = (s: string): string => s.replace(/\.$/, '');
