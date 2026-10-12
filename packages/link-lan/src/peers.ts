/**
 * 中枢记下的设备名册 —— **配对收下的那些，落盘**。
 *
 * 不落盘的话，"配过了"这件事只活在进程内存里：中枢一重启，
 * 用户配过的设备就全没了，还得再配一次 —— 那这个功能就没意义了。
 *
 * 文件里有密钥，所以目录 `0700`、文件 `0600`。
 *
 * ── 为什么"读不动"要拦下来，而不是当空的 ────────────────────────
 *
 * 静默当成空的话，用户看到的现象是"我配过的设备都不见了"，
 * 而且没有任何线索 —— 比直接起不来还难查。所以宁可不启动，
 * 也要把那句话说出来：**哪个文件、怎么修**。
 *
 * @module @butler/link-lan/peers
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 名册里的一台设备。名字叫 host 而不是 address：它可以是 IP，也可以是主机名 */
export interface StoredPeer {
  id: string;
  alias: string;
  host: string;
  port: number;
  /**
   * 这台设备自己的密钥。
   *
   * 以前所有节点共用一把（配置里那个 `secret`），现在每台一把 ——
   * 配对时由节点交给中枢。**一台泄漏不等于全都泄漏**，
   * 而且用户根本不需要知道它存在。
   */
  secret?: string;
}

/**
 * 读名册。文件不存在就是空名册（还没配过任何设备）。
 *
 * ⚠️ **文件存在但读不动**（坏了、权限不对、形状不对）会抛 —— 见文件头。
 */
export function loadPeers(file: string): StoredPeer[] {
  if (!file || !existsSync(file)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(
      `设备名册读不动：${file} 不是合法的 JSON。` +
      `删掉这个文件管家会重新开始，但配过的设备要重新配一次。`,
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error(
      `设备名册读不动：${file} 里应该是一个数组。` +
      `删掉这个文件管家会重新开始，但配过的设备要重新配一次。`,
    );
  }

  const out: StoredPeer[] = [];
  for (const item of raw) {
    const p = (item ?? {}) as Partial<StoredPeer>;
    // 残缺的一条只跳过它自己 —— 一条坏的记录不该让整台管家起不来
    if (typeof p.id !== 'string' || !p.id) continue;
    if (typeof p.host !== 'string' || !p.host) continue;
    out.push({
      id: p.id,
      alias: typeof p.alias === 'string' && p.alias ? p.alias : p.id,
      host: p.host,
      port: typeof p.port === 'number' && p.port ? p.port : 41338,
      ...(typeof p.secret === 'string' && p.secret ? { secret: p.secret } : {}),
    });
  }
  return out;
}

/** 写名册。同样的：里面躺着能遥控那几台电脑的密钥 */
export function savePeers(file: string, peers: StoredPeer[]): void {
  if (!file) return;                       // 配置里明说"不落盘"就不落
  const dir = dirname(file);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(peers, null, 2)}\n`, { mode: 0o600 });
  // 文件本来就在的时候，`mode` 不会改已经存在的权限位，补一下
  try { chmodSync(file, 0o600); } catch { /* Windows 上不支持就算了 */ }
}
