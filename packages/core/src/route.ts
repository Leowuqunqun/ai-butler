/**
 * 设备别名路由 —— **"这句话是发给谁的"**。
 *
 * ── 为什么只认 `@`，不做"话里提到就送过去" ──────────────────────
 *
 * 产品上已经定死：**默认目标是中枢所在的那台，显式指定才跨设备，不做隐式猜测**。
 * 隐式猜测在这里不是"聪明"，是**危险**：主人说一句"家里那台好像坏了"，
 * 隐式匹配会把这句**话**当成**命令**发到那台机器上去执行。
 *
 * 所以只有一种触发方式：**某一行以 `@` 开头**。
 * 没有 `@` 就一个字都不多想，直接在本机办 —— 这条路上零网络开销。
 *
 * ── 名字怎么切出来 ──────────────────────────────────────────────
 *
 * 中文句子常常不加空格（`@家里那台把桌面理理`），所以**先用已知别名做最长匹配**，
 * 匹配不上再退回"`@` 后面第一个词"。这样：
 *
 *   `@家里那台 把桌面理一理`        → 名字 = 家里那台，正文 = 把桌面理一理
 *   `@家里那台把桌面理一理`          → 一样（靠别名匹配切的）
 *   `@家里那台：把桌面理一理`        → 一样（别名匹配，冒号留在正文里）
 *   `@同事的电脑 你好`              → 名字 = 同事的电脑，known = false → 报"没这台设备"
 *
 * ── 为什么扫所有行，而不只看开头 ────────────────────────────────
 *
 * 用户会写多行（微信里换行就是换行），称呼不一定在第一行：
 *
 *     帮我看下这个
 *     @家里那台 顺便把桌面理理
 *
 * ⚠️ 注意**只扫正文**。用户引用某条消息时，被引用的那句话走
 * `InboundMessage.quote`，**不在** `text` 里 —— 否则引用里出现 `@某台设备`
 * 会让这条消息被送到那台设备上去执行，而用户只是在引用自己以前说过的话。
 *
 * @module @butler/core/route
 */

/** 一句话里认出来的收件人 */
export interface Address {
  /** 用户打的那个名字（**原样**，用来回话："你想让「家里那台」做什么？"） */
  name: string;
  /** 这个名字在已知设备里吗 */
  known: boolean;
  /** 去掉 `@名字` 之后的正文（其余行原样保留） */
  text: string;
}

/** `@` 后面那个词（匹配不上已知别名时的退路）。顺手剥掉尾巴上的标点 */
function firstToken(s: string): string {
  return (s.split(/\s/)[0] ?? '').replace(/[：:，,、。.!！?？]+$/, '');
}

/** 已知别名里，能在 `s` 开头匹配上的**最长**那个 */
function longestAlias(s: string, aliases: readonly string[]): string | null {
  let hit: string | null = null;
  for (const alias of aliases) {
    if (!alias || !s.startsWith(alias)) continue;
    if (hit === null || alias.length > hit.length) hit = alias;
  }
  return hit;
}

/**
 * 认出这句话在叫谁。
 *
 * `aliases` 传空数组时，这个函数就是**廉价的预检**：
 * 非 `null` 说明"这句像是在叫人"，才值得去问一遍设备列表。
 * 不是 `null` 也**不代表**这个名字真的存在 —— 那是 `known` 的事。
 */
export function parseAddress(text: string, aliases: readonly string[] = []): Address | null {
  const lines = String(text ?? '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('@')) continue;

    const afterAt = trimmed.slice(1);
    const name = longestAlias(afterAt, aliases) ?? firstToken(afterAt);
    if (!name) return null;            // 光一个 `@`，不算在叫人

    const indent = line.slice(0, line.length - trimmed.length);
    const rest = lines.slice();
    rest[i] = indent + afterAt.slice(name.length);
    return { name, known: aliases.includes(name), text: rest.join('\n') };
  }

  return null;
}

/** 把设备列表说成人话，用在"没有叫这个名字的设备，我知道的是……" */
export function describeDevices(devices: readonly { alias: string; online: boolean }[]): string {
  if (!devices.length) return '（一台都还没有 —— 那台电脑上得先跑起节点）';
  return devices
    .map((d) => `${d.alias || '(没起名)'}${d.online ? '' : '（不在线）'}`)
    .join('、');
}
