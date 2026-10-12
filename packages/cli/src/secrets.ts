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
  /** 这个字段为空时，去哪儿让用户拿到它（一句话，带 @BotFather） */
  hint: string;
}

const NEEDS: Record<string, ChannelSecretNeed> = {
  '@butler/channel-telegram': {
    channel: 'telegram',
    key: 'botToken',
    label: 'Telegram',
    name: 'Telegram 的 bot token',
    hint: '在 Telegram 里找 @BotFather 发 /newbot 建一个机器人，把它给你的那串 token 贴进来',
  },
};

/** 这一行插件需要什么凭据？不需要就返回 `null` */
export function channelSecretNeed(row: { name: string }): ChannelSecretNeed | null {
  return NEEDS[row.name] ?? null;
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
    const need = channelSecretNeed(row);
    if (!need) continue;
    const current = row.config?.[need.key];
    if (typeof current === 'string' && current.trim() !== '') continue;
    const value = secretOf(file, need.channel, need.key);
    if (!value) continue;
    if (!row.config) continue;
    row.config[need.key] = value;
    filled.push(need.key);
  }
  return filled;
}
