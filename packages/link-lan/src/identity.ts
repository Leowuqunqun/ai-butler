/**
 * 节点的"身份"：**它叫什么、它的密钥是什么** —— 以及配对要用的那串码。
 *
 * ── 为什么密钥是节点自己生成的 ──────────────────────────────────
 *
 * 一开始的设计是"用户在两台机器的配置里各填一个一样的密钥"。
 * 那等于让用户手抄一段随机串到两个文件里 —— 对不懂技术的人来说，
 * 这一步就是终点：抄错了、少了一位、两边不一致，表现出来都是
 * "连不上，但不说为什么"。
 *
 * 所以改成：**节点第一次起来的时候自己生成密钥，存在自己的状态目录里（0600），
 * 然后靠一次性的配对码把它交给中枢。** 用户不用看见密钥，也抄不错。
 *
 * 安全性没有变差，反而更好：
 *   - 每一台机器一把自己的密钥（以前是所有节点共用一把）
 *   - 密钥是 32 位随机串，不是用户手打的 `123456`
 *   - 密钥只在**局域网内部**从节点流向中枢，**从不经过微信**
 *
 * ── 配对码的规矩 ────────────────────────────────────────────────
 *
 * 6 位，字母表去掉了 `0 O 1 I L`（念不清、抄不对），显示成 `4A7-K2M`。
 * 32^6 ≈ 10 亿种，加上下面的"用一次就废 + 错 5 次就废 + 30 分钟过期"，
 * 暴力试是划不来的。
 *
 * @module @butler/link-lan/identity
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 管家自己的文件放哪。
 *
 * 一个目录放所有：节点的身份、中枢记下的设备名册。用户要备份、
 * 要搬家、要"全忘掉重来"，只需要动这一个目录。
 */
export function defaultStateDir(): string {
  return join(homedir(), '.butler');
}

/** 节点身份文件的默认位置 */
export function defaultIdentityFile(): string {
  return join(defaultStateDir(), 'node.json');
}

/** 中枢记下的设备名册（配对配对过的那些） */
/**
 * 名册文件的默认位置。
 *
 * `name` 是给**别的链路实现**留的：`link-tailscale` 跟 `link-lan` 各用一份名册
 * （同一台机器可能两条路都够得着，混在一份文件里会互相覆盖）。
 * 不传就是局域网那份 —— 老行为一个字没变。
 */
export function defaultPeersFile(name = 'peers.json'): string {
  return join(defaultStateDir(), name);
}

export interface NodeIdentity {
  /** 稳定 id，例如 `node-3f9a1c`。**一旦生成就别改** */
  id: string;
  /** 这台机器自己的密钥。跟中枢握手时用它 */
  secret: string;
}

/** 念得出、抄不错的字母表：没有 `0 O 1 I L` */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * 生成一个节点 id。
 *
 * 长得像 `node-3f9a1c`：够短、能念、能一眼看出是"系统给的"而不是人起的名字。
 * 人给的名字是 `alias`，那是中文的。
 */
export function newNodeId(): string {
  return `node-${randomBytes(3).toString('hex')}`;
}

/** 生成一段随机密钥。默认 32 位，用去掉了易混字符的字母表 */
export function newSecret(length = 32): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** 生成一个配对码，已经成型成 `4A7-K2M` */
export function newPairCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/**
 * 把用户抄来的配对码规整一下：**大小写、横线、空格都算数**。
 *
 * 用户是从另一台电脑的屏幕上抄的，中间可能多一个空格、少了横线、
 * 手机输入法还自动大写了首字母 —— 这些都不该导致配对失败。
 */
export function normalizePairCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** 常量时间比较配对码（跟密钥同一条理由：别让人逐位试） */
export function samePairCode(a: string, b: string): boolean {
  const x = Buffer.from(normalizePairCode(a));
  const y = Buffer.from(normalizePairCode(b));
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/** 读身份文件。没有、读不动、形状不对都返回 null（由调用方决定怎么办） */
export function loadIdentity(file: string): NodeIdentity | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeIdentity>;
    if (typeof v?.id !== 'string' || typeof v?.secret !== 'string') return null;
    if (!v.id || !v.secret) return null;
    return { id: v.id, secret: v.secret };
  } catch {
    return null;
  }
}

/**
 * 写身份文件。
 *
 * 目录 `0700`、文件 `0600`：这份文件里躺着一把能遥控这台电脑的密钥，
 * 同机器上的其他用户不该读得到。
 */
export function saveIdentity(file: string, identity: NodeIdentity): void {
  const dir = dirname(file);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  // 文件本来就在的时候，`mode` 不会改已经存在的权限位，补一下
  try { chmodSync(file, 0o600); } catch { /* Windows 上不支持就算了 */ }
}

/**
 * 这台机器上**别人够得着**的 IPv4 地址。
 *
 * 用来在中枢那台电脑上打出"配对 192.168.1.9:41338 4A7-K2M"这一行。
 * 内部地址（127.0.0.1）和虚拟网卡（docker0、utun…）不列出来 ——
 * 列出来只会让用户抄错一个。
 */
/**
 * 这个网卡名下的地址，用户抄得着吗。
 *
 * **容器/网桥的滤掉**（`docker0`、`veth*`、`br-*`、回环）：抄了也没用，
 * 还会让"配对"看起来像是坏了。
 *
 * ⚠️ `utun/tun/tap` **不能滤**：macOS 上 Tailscale 的尾巴地址就在 `utun` 上，
 * 而那正是"中枢和节点不在一个网络里"时**唯一够得着**的地址。当年把它一起滤掉，
 * 结果是节点屏幕上打不出那句能抄的话 —— 跨网配对就没法指路。
 */
export function isUsableInterface(name: string): boolean {
  return !/^(docker|br-|veth|lo)/.test(name);
}

export function localAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!isUsableInterface(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}
