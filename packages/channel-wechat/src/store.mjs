/**
 * 状态存储 —— 配置、凭据、会话映射、收信游标、流水。
 *
 * 全部落在项目下的 state/ 目录（已在 .gitignore 里）。
 * 其中 token.json **等同微信号登录态**，泄露等于把号交出去。
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 与业务无关的默认值；项目特有的东西（工作目录、模型……）不在这里 */
export const DEFAULTS = {
  /** agent 在哪个目录干活（它看到的根）。null = 用桥自己的目录 */
  workspace: null,
  /**
   * 只回应这些微信 user id。
   * 空数组 + bindFirstSender=true ⇒ **第一条来信自动认主**（方便首次上手，
   * 但也意味着谁先发谁拿走控制权，见 README 的安全一节）。
   */
  allowFrom: [],
  bindFirstSender: true,
  /** 单条消息最大字符数，超出自动分条 */
  maxReplyChars: 1200,
  /** 一次 agent 调用的硬超时，超了就掐掉并如实告知 */
  agentTimeoutMs: 5 * 60 * 1000,
  /** 发"正在输入" */
  typing: true,
  /** 回复开头带一行「↩ 原问题」——连发多条时能对上号 */
  quoteReply: true,
  /** 队列里还有积压时，先回一句"收到，前面还有 N 条" */
  queueAck: true,
  /** 处理中的进度提示间隔（0 = 关） */
  progressIntervalMs: 40_000,
  /** 队列积压上限，超了拒收（防止一次性刷爆） */
  maxQueue: 20,
  /** 入站媒体（微信发来的图片/文件） */
  media: {
    /** 关掉就退回"这条我读不了"，不下载任何东西 */
    enabled: true,
    /** CDN 地址；一般不用改，服务端返回 baseurl 时会覆盖 */
    cdnBaseUrl: null,
    /** 单个文件上限（字节），超过拒收 */
    maxBytes: 100 * 1024 * 1024,
  },
  /** agent 后端 */
  agent: {
    backend: 'echo',
    // backend 为 'dsh' 时用这些：
    dsh: {
      bin: 'dsh',
      profile: 'headless',
      patchFile: null,
      /** 桥专用 DSH_HOME —— 与 dsh web 的会话仓库隔离，详见 README「两个坑」 */
      home: null,
    },
    // backend 为 'exec' 时用这些：
    exec: { argv: [], input: 'arg', timeoutMs: 5 * 60 * 1000, cwd: null },
  },
};

const readJson = (p, fb) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; }
};
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
};

export class Store {
  /** @param {string} root 项目根目录（state/ 会建在它下面） */
  constructor(root) {
    this.root = resolve(root);
    this.dir = join(this.root, 'state');
    mkdirSync(this.dir, { recursive: true });
    this.paths = {
      config: join(this.dir, 'config.json'),
      token: join(this.dir, 'token.json'),
      sessions: join(this.dir, 'sessions.json'),
      cursor: join(this.dir, 'cursor.json'),
      audit: join(this.dir, 'audit.jsonl'),
      /** 收到的图片/文件解密后落在这里，路径会交给 agent */
      inbox: join(this.dir, 'inbox'),
    };
  }

  // ── 配置 ──

  loadConfig() {
    const user = readJson(this.paths.config, {});
    const merged = mergeDeep(DEFAULTS, user);
    if (!existsSync(this.paths.config)) writeJson(this.paths.config, merged);
    // 项目内的相对路径统一解析成绝对路径
    for (const k of ['workspace']) {
      if (merged[k]) merged[k] = resolve(this.root, merged[k]);
    }
    const dsh = merged.agent?.dsh;
    if (dsh) {
      if (!dsh.home) dsh.home = join(this.root, 'dsh-home');
      else dsh.home = resolve(this.root, dsh.home);
      if (dsh.patchFile) dsh.patchFile = resolve(this.root, dsh.patchFile);
    }
    if (merged.agent?.exec?.cwd) merged.agent.exec.cwd = resolve(this.root, merged.agent.exec.cwd);
    this.config = merged;
    return merged;
  }

  saveConfig(cfg) {
    writeJson(this.paths.config, cfg);
  }

  // ── 凭据 ──

  readToken() {
    const t = readJson(this.paths.token, null);
    return t?.botToken ? t : null;
  }

  writeToken(t) {
    writeJson(this.paths.token, { ...t, savedAt: Date.now() });
  }

  clearToken() {
    writeJson(this.paths.token, {});
  }

  // ── 用户 → agent 会话 映射 ──

  readSessions() {
    return readJson(this.paths.sessions, {});
  }

  getSession(userId) {
    return this.readSessions()[userId] ?? null;
  }

  setSession(userId, sessionId) {
    const all = this.readSessions();
    if (sessionId) all[userId] = sessionId;
    else delete all[userId];
    writeJson(this.paths.sessions, all);
  }

  // ── 收信游标 ──

  readCursor() {
    return readJson(this.paths.cursor, { buf: '' }).buf ?? '';
  }

  writeCursor(buf) {
    writeJson(this.paths.cursor, { buf, updatedAt: Date.now() });
  }

  // ── 流水 ──

  audit(entry) {
    try {
      appendFileSync(this.paths.audit, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch { /* 流水失败不能影响主流程 */ }
  }

  /** 最近 n 条流水（倒序） */
  recentAudit(n = 20) {
    try {
      const lines = readFileSync(this.paths.audit, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch {
      return [];
    }
  }
}

/** 深合并：用户配置覆盖默认值，嵌套对象逐层合并（数组整体替换） */
export function mergeDeep(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = (k in base) ? mergeDeep(base[k], v) : v;
  }
  return out;
}
