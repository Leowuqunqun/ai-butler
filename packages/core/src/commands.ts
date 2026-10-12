/**
 * 微信里的**命令** —— 跟 agent 请求走在同一条收件通道上。
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────
 *
 * 有一类事**不该交给 agent**："把这台电脑收进来"、"现在认识哪些电脑"。
 * 交给 agent 的话，它得能改自己的设备名册 —— 那是把用户的一句自然语言
 * 直接变成权限变更，而我们连"它做对了没有"都说不清。
 *
 * 所以这几件事在**进 agent 之前**就被认出来，由内核自己干，
 * 动作明确、结果明确。
 *
 * ── 不认得就当普通消息（这条最重要）────────────────────────────
 *
 * `parseCommand` 返回 `null` 时，那句话**原样**交给原来的流程 ——
 * 加了这一层之后，用户说别的话的行为一点没变。
 *
 * 为了做到这一点，判定故意收得很紧：
 *   - `设备` / `命令` 必须**整句**就是这两个字（"设备都没了"不是命令）
 *   - `配对` 后面得真的像地址或配对码（"配对一下我的耳机"不是命令）
 * 宁可漏认（用户会看到 agent 的回复，再发一次就行），也不要错认
 * （错认的代价是用户一句正常的话被管家当命令执行）。
 *
 * @module @butler/core/commands
 */

import type { DeviceInfo } from '@butler/seam-link';
import { WELCOME_WORDS } from './welcome.js';

export type Command =
  /** 收下一台新设备。`host`/`code` 缺哪个，回话里就点哪个 */
  | { kind: 'pair'; host: string; port: number | null; code: string }
  /** 现在认识哪些设备 */
  | { kind: 'devices' }
  /** 忘掉一台设备 */
  | { kind: 'forget'; name: string }
  /** 记住一件事（主人明说） */
  | { kind: 'remember'; text: string }
  /** 我现在记得什么 */
  | { kind: 'memory' }
  /** 忘掉第 N 条（编号来自「记忆」列出来的那份） */
  | { kind: 'forgetMemory'; index: number }
  /** 我会哪几句 */
  | { kind: 'allow'; index: number | null }
  | { kind: 'deny'; index: number | null }
  | { kind: 'pending' }
  /** 「以后这类都行 2」——长期授权（见 grants.ts 的长注释） */
  | { kind: 'always'; index: number | null; window?: string }
  /** 「授权」——看看给过哪些长期授权 */
  | { kind: 'grants' }
  /** 「取消授权 1」——收回第 N 条 */
  | { kind: 'revokeGrant'; index: number }
  /** 「你能干什么」——再看一遍开场白那段 */
  /** 「自检」——让它自己查一遍，人话报告 */
  | { kind: 'selfcheck' }
  | { kind: 'welcome' }
  | { kind: 'help' };

const PAIR_WORDS = ['配对', 'pair'];
const DEVICE_WORDS = ['设备', 'devices'];
const FORGET_WORDS = ['忘掉', 'forget', '删掉'];
const HELP_WORDS = ['命令', '帮助', 'help', '?', '？'];
const REMEMBER_WORDS = ['记住', 'remember'];
const MEMORY_WORDS = ['记忆', 'memory'];
const ALLOW_WORDS = ['允许', '同意', '可以', 'allow'];
const DENY_WORDS = ['不许', '拒绝', '不行', 'deny'];
const PENDING_WORDS = ['待批', '审批', 'pending'];
/**
 * 「自检」——**整句**才算（"自检一下那个文件"是给 agent 的活）。
 *
 * 故意不收光秃秃的「检查」：那一句太像正常请求了（"检查"两个字也能是在派活）。
 * 认错这一句的代价不大（顶多多回一份体检报告），但没必要冒。
 */
const CHECK_WORDS = ['自检', '体检', '你还好吗'];

/**
 * `忘掉第 2 条` / `忘掉 第2条` / `删掉第3条`。
 *
 * 必须**整句**匹配，而且必须带"第…条"：`忘掉 家里那台` 是设备那条命令，
 * 这里要是放宽了，一句"忘掉第 2 条"就会被当成一台叫「第 2 条」的设备。
 */
const FORGET_MEMORY_RE = /^(?:忘掉|删掉|forget)\s*第\s*(\d+)\s*条$/i;

/**
 * `记住 X` —— **`记住` 后面必须有个分隔符**（空格 / 冒号 / 逗号）才算命令。
 *
 * 少了这一条，`记住这件事很重要` 会被当成"主人在交代一条偏好"存下来 ——
 * 而那句话其实是在跟 agent 说话。宁可漏认（他会看到 agent 的回复，再发一次
 * 「记住 …」就行），也不要错认。
 */
const REMEMBER_RE = /^(?:记住|remember)[\s:：,，、]+(.+)$/i;

/**
 * 「允许」/「不许」—— 可以带编号，也可以不带。
 *
 *   · 不带编号（`允许`）：只有**恰好一件**在等主人时才作数，
 *     多于一件就让主人明说是哪一件（见 index.ts）—— 审批这件事上，
 *     猜错一件的代价是"允许了一次本来没打算允许的操作"。
 *   · `好` / `行` / `可以吧` 这类**故意不收**：它们太像正常说话了，
 *     宁可漏认（主人再打一次"允许"），也不要让一句随口的话变成授权。
 */
const ALLOW_RE = /^(?:允许|同意|可以|allow)\s*第?\s*(\d+)?\s*条?$/i;
const DENY_RE = /^(?:不许|拒绝|不行|deny)\s*第?\s*(\d+)?\s*条?$/i;

/**
 * 「以后这类都行」—— **长期**授权。
 *
 * 只认主人**自己打出**的这几种说法，而且整行匹配（`$` 收尾）。
 * 认错这一句的代价是"这一类以后都不再问"，比漏认严重得多 ——
 * 宁可让他再说一遍，也不能替他做主。（「都行」两个字单独出现不算：那多半是在聊天。）
 */
const ALWAYS_RE = /^(?:以后(?:这类)?(?:都行|不用问了?|不必问了?)|这类不用问了?)\s*第?\s*(\d+)?\s*条?(?:\s*[，,、]?\s*((?:半|一|两|二|三|\d+(?:\.\d+)?)\s*(?:分钟|小时|天)\S*))?$/;
/** 「授权」/「哪些不用问了」（整行才算） */
const GRANTS_RE = /^(?:授权|哪些不用问了|以后不用问的有哪些)$/;
/** 「取消授权 1」（编号必填：不知道收哪条就别收） */
const REVOKE_RE = /^(?:取消授权|收回授权)\s*第?\s*(\d+)\s*条?$/;

/** 像地址吗：带 `.` 或 `:`。节点打给用户的一行里永远是 `IP:端口` */
const looksLikeAddress = (t: string): boolean => /[.:]/.test(t);

/** 像配对码吗：`4A7K2M` 或 `4A7-K2M` */
const looksLikeCode = (t: string): boolean => /^[0-9A-Za-z]{3}-?[0-9A-Za-z]{3}$/.test(t);

/**
 * 认一句命令。**认不出来就返回 `null`**，那句话走原来的路。
 */
export function parseCommand(text: string): Command | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const [word = '', ...rest] = raw.split(/\s+/);
  const w = word.toLowerCase();

  // 整句就是这两个字的才算 —— "设备都没了"是在跟 agent 说话
  if (rest.length === 0 && HELP_WORDS.includes(w)) return { kind: 'help' };
  if (rest.length === 0 && DEVICE_WORDS.includes(w)) return { kind: 'devices' };
  if (rest.length === 0 && WELCOME_WORDS.includes(w)) return { kind: 'welcome' };
  if (rest.length === 0 && CHECK_WORDS.includes(w)) return { kind: 'selfcheck' };

  if (PAIR_WORDS.includes(w)) {
    const addr = rest.find(looksLikeAddress);
    const code = rest.find((t) => !looksLikeAddress(t) && looksLikeCode(t));
    // 后面既没有地址也没有码 —— 当成普通消息（"配对一下我的耳机"）
    if (!addr && !code) return null;
    const { host, port } = splitHost(addr ?? '');
    return { kind: 'pair', host, port, code: code ?? '' };
  }

  // 审批这三条：整行匹配（`$` 收尾），所以「允许我解释一下」不会被认成命令
  const allow = ALLOW_RE.exec(raw);
  if (allow) return { kind: 'allow', index: allow[1] === undefined ? null : Number(allow[1]) };
  const deny = DENY_RE.exec(raw);
  if (deny) return { kind: 'deny', index: deny[1] === undefined ? null : Number(deny[1]) };
  if (rest.length === 0 && PENDING_WORDS.includes(w)) return { kind: 'pending' };
  // 长期授权这三条也整行匹配。排在 allow/deny 之后：它们互不重叠
  const always = ALWAYS_RE.exec(raw);
  if (always) {
    // 尾巴只有在**像一段时间**时才会被这里收进来（见 ALWAYS_RE）——
    // 所以「以后这类都行 2，谢谢」照旧是聊天，不会被当成一条读不懂的授权。
    const window = always[2]?.trim();
    return {
      kind: 'always',
      index: always[1] === undefined ? null : Number(always[1]),
      ...(window ? { window } : {}),
    };
  }
  const revoke = REVOKE_RE.exec(raw);
  if (revoke) return { kind: 'revokeGrant', index: Number(revoke[1]) };
  if (GRANTS_RE.test(raw)) return { kind: 'grants' };

  // 「忘掉第 2 条」要排在设备那条**前面**（见 FORGET_MEMORY_RE 的注释）
  const forgetMemory = FORGET_MEMORY_RE.exec(raw);
  if (forgetMemory) return { kind: 'forgetMemory', index: Number(forgetMemory[1]) };

  const remember = REMEMBER_RE.exec(raw);
  if (remember) return { kind: 'remember', text: (remember[1] ?? '').trim() };

  // 整句就是这两个字的才算 —— 跟「设备」同一条规矩
  if (rest.length === 0 && MEMORY_WORDS.includes(w)) return { kind: 'memory' };

  if (FORGET_WORDS.includes(w) && rest.length) return { kind: 'forget', name: rest.join(' ') };

  return null;
}

/** `192.168.1.9:41338` → host + port。没有端口就是 `null`（用实现的默认） */
function splitHost(token: string): { host: string; port: number | null } {
  const at = token.lastIndexOf(':');
  if (at <= 0) return { host: token, port: null };
  const tail = token.slice(at + 1);
  if (!/^\d+$/.test(tail)) return { host: token, port: null };   // 不是端口，整个当主机名
  const port = Number(tail);
  return port > 0 && port <= 65535 ? { host: token.slice(0, at), port } : { host: token, port: null };
}

/** 我会哪几句。**给不懂技术的人看的**，所以每一句都带一个真例子 */
export function commandHelp(): string {
  return [
    '我能听懂这几句（别的话都当普通请求交给 agent）：',
    '',
    '  配对 192.168.1.9:41338 4A7-K2M',
    '      把一台新电脑收进来。那一行在**那台电脑**上跑 butler node 时会打出来，',
    '      照抄发过来就行（配对码只能用一次）。',
    '',
    '  设备',
    '      看看现在认识哪些电脑、在不在线。',
    '',
    '  忘掉 家里那台',
    '      不再管那台电脑。',
    '',
    '  记住 简历都放 Documents/简历/',
    '      记一件事，以后我会照它办。',
    '',
    '  记忆',
    '      看看我现在记得什么（带编号）。',
    '',
    '  忘掉第 2 条',
    '      忘掉「记忆」里的第 2 条。编号就是那份清单上的编号。',
    '',
    '  以后这类都行 2',
    '      **长期**授权：这一类（同一种工具）的事以后都不问你。',
    '      注意这是**这一类全部** —— 包括这一类里删东西、改系统那种。',
    '      随时可以回「授权」看看给过哪些，或者「取消授权 1」收回。',
    '',
    '  授权',
    '      看看你给过哪些长期授权（带编号）。',
    '',
    '  取消授权 1',
    '      收回「授权」里的第 1 条。',
    '',
    '  允许 / 允许 2',
    '      批了那件"要动你电脑"的事。只有一件在等的时候，光说「允许」就行。',
    '',
    '  不许 / 不许 2',
    '      不准。**不答也一样** —— 到点我就当不许，不会先做了再说。',
    '',
    '  待批',
    '      看看现在有哪些事在等你点头。',
    '',
    '  自检',
    '      让我自己查一遍：要用的程序装没装、记不记得住、要动你电脑之前有没有人问你。',
    '      **发了消息没反应的时候，先回这一句。**',
    '',
    '  你能干什么',
    '      再看一遍最开始那段（能让我干什么、我会怎么问你）。',
  ].join('\n');
}

/**
 * 用名字找一台设备。
 *
 * **说不清就不猜**：好几个都能对上时返回 `null`，由调用处问一句"你说的是哪台"。
 * 认错设备的代价是在另一台电脑上干了活，用户还以为是这台。
 */
export function findDevice(name: string, devices: readonly DeviceInfo[]): DeviceInfo | null {
  const q = String(name ?? '').trim();
  if (!q) return null;

  const exact = devices.find((d) => d.alias === q || d.id === q);
  if (exact) return exact;

  const partial = devices.filter((d) => d.alias.includes(q) || d.id.includes(q));
  return partial.length === 1 ? partial[0]! : null;
}

/**
 * 把设备列表说成人话。
 *
 * 离线的那几台**必须带上"最后在线什么时候"** —— 用户看到的是"不在线"，
 * 但他真正想知道的是"我是不是得去把它打开"。
 */
export function describeForUser(devices: readonly DeviceInfo[], now = Date.now()): string {
  if (!devices.length) {
    return [
      '现在一台别的电脑都还不认识。',
      '',
      '在那台电脑上装好、跑起 `butler node`，把它屏幕上打出的那一行',
      '（形如「配对 192.168.1.9:41338 4A7-K2M」）发到这儿来，我就收下它。',
    ].join('\n');
  }

  const lines = devices.map((d) => `  · ${d.alias || d.id}${d.online ? '' : `（不在线，${ago(d.lastSeen, now)}）`}`);
  return [
    `现在认识 ${devices.length} 台电脑：`,
    ...lines,
    '',
    '说「@家里那台 …」就在那台电脑上干活；不说 @ 就在这台上。',
  ].join('\n');
}

/** "最后在线 3 小时前" 里的那半句。`null` = 从来没听到过 */
function ago(seen: number | null, now: number): string {
  if (!seen) return '还没连上过';
  const s = Math.max(0, Math.round((now - seen) / 1000));
  if (s < 60) return '刚刚还在';
  const m = Math.round(s / 60);
  if (m < 60) return `最后在线 ${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `最后在线 ${h} 小时前`;
  return `最后在线 ${Math.round(h / 24)} 天前`;
}

/** `process.platform` → 人话。别跟用户说 "darwin" */
export function osName(os: string): string {
  if (os === 'darwin') return 'macOS';
  if (os === 'win32') return 'Windows';
  if (os === 'linux') return 'Linux';
  return os;
}
