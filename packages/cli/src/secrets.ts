/**
 * 管家自己的凭据（现在只有通道那点东西，比如 Telegram 的 bot token）存在哪。
 *
 * ── 为什么不写进 `config.json` ─────────────────────────────────────
 *
 * `config.json` 是"装哪几个插件"的配置文件：我们**引导用户去读它**（doctor 会把
 * 它的路径打出来），他也很可能截图、贴给别人看。凭据进去等于鼓励泄露。
 * 模型 key 走的是 DSH 自己的凭据库（独立的 0600 文件）—— 同一套道理。
 *
 * ── 形状（`<管家目录>/state/secrets.json`，0600）─────────────────
 *
 *     { "version": 1, "channels": { "telegram": { "botToken": "123:ABC" } } }
 *
 * 读坏了当空 —— 一个坏掉的凭据文件不该让 `butler run` 直接崩：它会当成
 * "还没填"，然后照常问你一次（问一次比崩一次好）。
 *
 * ── 分层的道理 ────────────────────────────────────────────────────
 *
 * `@butler/channel-telegram` **不知道** `~/.butler/state/` 的存在：它只认自己的
 * `config.botToken`。`~/.butler` 是 CLI 的事 —— 所以由 CLI 读出来、填进那一行的
 * config，再交给容器。通道包因此还是"给我 token 我就能跑"，谁给的不关心。
 *
 * @module @butler/cli/secrets
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scanHint } from '@butler/channel-feishu/probe-path';

/** 一个通道要哪一项凭据。**只在这里写一次**（加通道就在这儿加一行） */
export interface ChannelSecretNeed {
  /** 凭据文件里的通道名（`channels.<channel>`） */
  channel: string;
  /** 字段名（`channels.<channel>.<key>`） */
  key: string;
  /** 给用户看的名字（"Telegram"） */
  label: string;
  /** 日志和页面标题里怎么称呼它（"Telegram 的 bot token"） */
  name: string;
  /**
   * 这个字段为空时，去哪儿让用户拿到它（一句话，带 @BotFather）。
   *
   * 是**函数**而不是字符串：飞书那条提示里嵌着"照着敲"的探针命令，而那条命令要不要带
   * `--home=` 取决于**这个家的位置**（用 `--config` 安在别处就必须带，不然探针会把凭据
   * 存到另一个目录，用户看到"探针说存好了、`butler run` 却说还没有 app_id"）。
   * 写成常量的话，它在**模块加载时**就定型了 —— 那时候家在哪还不知道。
   */
  hint: (butlerDir: string) => string;
}

/**
 * 一个包要的凭据，**可能不止一项**。
 *
 * 多数通道只要一个 token（Telegram）；飞书要两个（app_id + app_secret）。
 * 所以这里是数组而不是一项 —— 引导页会挨个问，但**已经存过的那项不会重问**。
 */
const NEEDS: Record<string, ChannelSecretNeed[]> = {
  '@butler/channel-telegram': [{
    channel: 'telegram',
    key: 'botToken',
    label: 'Telegram',
    name: 'Telegram 的 bot token',
    hint: () => '在 Telegram 里找 @BotFather 发 /newbot 建一个机器人，把它给你的那串 token 贴进来',
  }],
  '@butler/channel-feishu': [
    {
      channel: 'feishu',
      key: 'appId',
      label: '飞书',
      name: '飞书应用的 app_id',
      hint: (butlerDir) => `两种办法（挑一个）：① ${scanHint(butlerDir)}，`
        + '它不需要开发者后台、不需要公网 IP，扫完直接把两个值存进这台电脑；'
        + '② 或去 open.feishu.cn 建一个「企业自建应用」，在「凭证与基础信息」里抄下 app_id',
    },
    {
      channel: 'feishu',
      key: 'appSecret',
      label: '飞书',
      name: '飞书应用的 app_secret',
      hint: () => '和 app_id 在同一页（「凭证与基础信息」）。扫码那条路会自动填好，不用手抄',
    },
  ],
};

/** 这一行插件需要哪些凭据？不需要就返回空数组 */
/** 盘上凭据齐了、配置里却没这一条通道 —— 见 `unpluggedChannels` */
export interface UnpluggedChannel {
  /** 凭据文件里的通道名（`feishu`） */
  channel: string;
  /** 给用户看的名字（"飞书"） */
  label: string;
  /** `butler init --im <这个>` */
  im: string;
}

/**
 * 「凭据存好了，但配置里没有这条通道」—— 一次验收里最容易走进的那个死胡同。
 *
 * 探针那条路的最后一步是把凭据存进 `state/secrets.json`，而通道要在**配置里有一行**
 * 才会被装载。少跑一次 `butler init --im feishu` 的后果不是报错，是**悄无声息**：
 * `butler doctor` 一片 ✓、`butler run` 正常起来、消息发出去没人应 —— 用户最容易怀疑的
 * 是"是不是我权限没配好"，然后去开发者后台折腾半天（第 44 轮实测复现过：盘上有完整的
 * 飞书凭据时，`doctor` 里「飞书」出现 **0** 次）。
 *
 * 所以：一条通道的凭据**齐了**（每一项都非空），配置里却没有它的行 → 明说下一步。
 * 只认「齐了」—— 扫了一半的凭据不该催他去 init（那时候他手上的事还没做完）。
 */
export function unpluggedChannels(opts: {
  butlerDir: string;
  rows: readonly { name: string }[];
}): UnpluggedChannel[] {
  const file = secretsFileOf(opts.butlerDir);
  const present = new Set(opts.rows.map((r) => r.name));
  const out: UnpluggedChannel[] = [];
  for (const [pkg, needs] of Object.entries(NEEDS)) {
    if (present.has(pkg)) continue;
    // 不是"换个 `--im` 就能接上"的那种通道（比如微信那条插件）就不在这儿瞎指路
    const match = /^@butler\/channel-(.+)$/.exec(pkg);
    const first = needs[0];
    if (!match?.[1] || !first) continue;
    if (!needs.every((n) => secretOf(file, n.channel, n.key))) continue;
    out.push({ channel: first.channel, label: first.label, im: match[1] });
  }
  return out;
}

/**
 * 那句提示 —— **一份文本两处用**（`butler doctor` 和 `butler run` 都要说同一句话）。
 * 抄两遍就迟早有一遍过期，而这句话说错的后果正是它要防的那个死胡同。
 */
export function unpluggedHint(u: UnpluggedChannel): string {
  return `盘上已经有${u.label}的凭据，配置里却没有那一条通道 —— 跑一次 `
    + `butler init --im ${u.im} 把它接上（凭据不用重扫）。`;
}

export function channelSecretNeeds(row: { name: string }): ChannelSecretNeed[] {
  return NEEDS[row.name] ?? [];
}

/** 只要第一项（日志里想简短地称呼这个通道时用） */
export function channelSecretNeed(row: { name: string }): ChannelSecretNeed | null {
  return channelSecretNeeds(row)[0] ?? null;
}

/** 凭据文件在哪：`<管家目录>/state/secrets.json` */
export function secretsFileOf(butlerDir: string): string {
  return join(butlerDir, 'state', 'secrets.json');
}

interface SecretsFile {
  version: number;
  channels: Record<string, Record<string, string>>;
}

function emptySecrets(): SecretsFile {
  return { version: 1, channels: {} };
}

/** 读。读不到 / 读坏了 / 结构不对 —— 一律当"还没有" */
export function readSecrets(file: string): SecretsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptySecrets();
  }
  if (parsed === null || typeof parsed !== 'object') return emptySecrets();
  const channels = (parsed as { channels?: unknown }).channels;
  if (channels === null || typeof channels !== 'object') return emptySecrets();
  const out: Record<string, Record<string, string>> = {};
  for (const [name, bag] of Object.entries(channels as Record<string, unknown>)) {
    if (bag === null || typeof bag !== 'object') continue;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
      // 只认字符串：别的类型当没写（我们只往里存字符串）
      if (typeof v === 'string' && v.trim() !== '') fields[k] = v;
    }
    if (Object.keys(fields).length) out[name] = fields;
  }
  return { version: 1, channels: out };
}

/** 取一项；没有就 `null` */
export function secretOf(file: string, channel: string, key: string): string | null {
  return readSecrets(file).channels[channel]?.[key] ?? null;
}

/**
 * 存一项（合并写，不动别人的）。
 *
 * ⚠️ 先写同目录的临时文件再 `rename`：万一写到一半断电/被杀，也不会留下一个
 *    半截的 JSON 把之前存好的 token 一起弄丢（rename 是原子的）。
 * ⚠️ 0600：这个文件等同账号密码（能冒充你的机器人发消息）。
 */
export function saveSecret(file: string, channel: string, key: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('空的值不写（那等于没填）');
  const all = readSecrets(file);
  const bag = all.channels[channel] ?? {};
  bag[key] = trimmed;
  all.channels[channel] = bag;

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  // 目标文件原本存在（权限可能更松）时，rename 之后权限是临时文件那套；
  // 但保险起见再钉一次 —— 这个文件不该有第二个读者。
  chmodSync(file, 0o600);
  if (!existsSync(file)) throw new Error(`凭据没写进去：${file}`);
}

/**
 * 把存好的凭据填进对应的插件行（**只填空的**）。
 *
 * 配置里写死的值优先级最高 —— 高级用户手写的那份，我们一个字都不改。
 * 返回真被填了哪几个字段名，好让调用方打一句人话。
 */
export function injectChannelSecrets(
  rows: readonly { name: string; config?: Record<string, unknown> | undefined }[],
  file: string,
): string[] {
  const filled: string[] = [];
  for (const row of rows) {
    // 一个包可能要两项（飞书：app_id + app_secret），所以这里也挨个来
    for (const need of channelSecretNeeds(row)) {
      const current = row.config?.[need.key];
      if (typeof current === 'string' && current.trim() !== '') continue;
      const value = secretOf(file, need.channel, need.key);
      if (!value) continue;
      if (!row.config) continue;
      row.config[need.key] = value;
      filled.push(need.key);
    }
  }
  return filled;
}
