/**
 * 引导页：**第一次跑起来的时候，只问用户那么一两件事** —— 把模型 key 贴进来，
 * 或者（用 Telegram 的时候）把 bot token 贴进来。
 *
 * ── 为什么是网页，不是命令行问答 ──────────────────────────────────
 *
 * 命令行里"贴 key"看着简单，其实每一步都在劝退：回车前会不会被 shell 吃掉、
 * 剪贴板里的换行、看不到自己贴对没有、贴错了怎么改。而**浏览器是我们唯一
 * 能画界面的地方**，也是他手机上就能完成的地方（真的：key 可以先在手机上
 * 复制，再在电脑的浏览器里粘）。
 *
 * 顺带解决一件命令行做不到的事：**告诉他这是什么、去哪儿拿**。
 *
 * ── 一个引擎，两个（以后 N 个）问题 ───────────────────────────────
 *
 * 页面本身是**一模一样**的：一个输入框、保存、跳过。变的是文案和"存到哪"。
 * 所以这里只有一个 `askForSecret(prompt, opts)`，两处用的是它：
 *
 *   - `ensureModelKey`   → 模型 key（存进 DSH 的凭据库）
 *   - `ensureChannelToken` → 通道自己的凭据（存进 `<管家目录>/state/secrets.json`）
 *
 * ⚠️ 别再复制一份服务器代码：一次性随机串、只监听回环、请求体上限这些
 *    是安全相关的，**只能有一份**。
 *
 * ── 安全 ─────────────────────────────────────────────────────────
 *
 * - 只监听 `127.0.0.1`，不对外暴露（外网连不上）。
 * - 地址里带一个**一次性随机串**（`/s/<token>`）：别的网页即使猜到端口，
 *   也发不出能生效的请求 —— 它猜不到那个串。没有串一律 404。
 * - 请求体上限 8 KiB。凭据不会出现在 URL 里，也不会被我们打日志。
 * - 凭据只写进本机**管家自己的**文件（0600），不经过任何网络。
 *
 * @module @butler/cli/onboarding
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { credentialsFileOf, keyState, refsOf, saveKeyRef } from './credentials.js';
import { verifyModelKey, type KeyVerdict } from './model-key.js';
import { channelSecretNeeds, injectChannelSecrets, saveSecret, secretOf, secretsFileOf } from './secrets.js';

/**
 * 配置里的 agent 那一行，如果跑的是 DSH —— 它需要的东西在哪儿。
 *
 * 只有 `@butler/agent-dsh` 需要模型 key（别的 agent 实现不走 DSH 的凭据库），
 * 所以认的是**模块名**：不是它就当没这回事，别去问一个无关的 agent 要 key。
 */
export function dshAgentHome(
  rows: readonly { name: string; config?: Record<string, unknown> | undefined }[],
): { patchFile: string; home: string } | null {
  const row = rows.find((r) => r.name === '@butler/agent-dsh');
  if (!row?.config) return null;
  const patchFile = row.config['patchFile'];
  const home = row.config['home'];
  if (typeof patchFile !== 'string' || typeof home !== 'string') return null;
  return { patchFile, home };
}

/** key 页面默认端口（跟扫码页 8099 错开） */
export const DEFAULT_KEY_PORT = 8137;

/** 等人贴 key 最多等这么久；等到就往后走（没 key 也能先扫码，回头补） */
export const DEFAULT_KEY_TIMEOUT_MS = 10 * 60 * 1000;

/** 存好之后让页面多留一会儿，好让用户看见"✅ 好了" */
const SETTLE_MS = 2500;

const MAX_BODY = 8 * 1024;

export type KeyOutcome =
  /** 已经有 key 了（环境变量或凭据文件里），没起页面 */
  | 'present'
  /** 用户贴了（或从 dsh 复制了） */
  | 'saved'
  /** 没填就过去了（超时/点了跳过/进程被打断） */
  | 'skipped';

export interface KeyPageOptions {
  /** 管家私有的 DSH_HOME（凭据文件就在它下面） */
  dshHome: string;
  /** 要写哪个引用名（从补丁的 `apiKeyEnv` 读出来的） */
  ref: string;
  log: (line: string) => void;
  /** 换端口（测试用） */
  port?: number;
  timeoutMs?: number;
  /** 打开浏览器；测试里替换掉。失败**不能**影响流程（终端里也打了地址） */
  open?: (url: string) => void;
  /**
   * 允许自动开浏览器吗（默认允许）。
   *
   * `butler run --no-open` 会把它设成 false —— **自启动**场景专用（每次登录都弹一个
   * 页面出来很烦）。设成 false 时终端里**照旧打地址**，只是不替你开。
   */
  autoOpen?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 用户自己那套 dsh 的凭据文件位置（默认 `~/.dsh/.credentials.yaml`） */
  globalCredentialsFile?: string;
  signal?: AbortSignal;
  /**
   * `--again`：**就算已经有 key 也重新问一遍**（想换一把的时候）。
   *
   * ⚠️ 问之前**先不删**旧的：他点"先跳过"、或者页面关掉了，手里那把还得能用。
   */
  force?: boolean;
  /** 测试用：替换掉真去问对方那一步 */
  verifyKey?: (key: string) => Promise<KeyVerdict>;
}

/** 起一个引导页需要的那些东西（和"问什么"无关） */
export interface SecretPageOptions {
  log: (line: string) => void;
  /** 换端口（测试用） */
  port?: number;
  timeoutMs?: number;
  /** 打开浏览器；测试里替换掉。失败**不能**影响流程（终端里也打了地址） */
  open?: (url: string) => void;
  /**
   * 允许自动开浏览器吗（默认允许）。
   *
   * `butler run --no-open` 会把它设成 false —— **自启动**场景专用（每次登录都弹一个
   * 页面出来很烦）。设成 false 时终端里**照旧打地址**，只是不替你开。
   */
  autoOpen?: boolean;
  signal?: AbortSignal;
}

/**
 * 页面上问的**一件事**：所有文案 + 怎么存 + 可选的"顺手从别处搬一把"。
 *
 * 文案放在调用方，是因为它们要贴着**具体那件东西**写（key 去哪拿、token 去哪拿
 * 完全不是一回事）；页面本身一个字都不该知道。
 */
export interface SecretPrompt {
  /** 日志里怎么称呼它（"模型 key" / "Telegram 的 bot token"） */
  name: string;
  /** 页面的 `<title>` */
  title: string;
  /** 大标题 */
  heading: string;
  /** 第一段：这是什么、存到哪个文件（HTML，文件路径用 <code>） */
  lead: string;
  /** 第二段：**去哪儿拿**（HTML） */
  where: string;
  placeholder: string;
  /** 存好之后页面上那句"回到终端" */
  after: string;
  /** 点了"先跳过"之后，页面上说那句 */
  skipText: string;
  /** 日志里"先跳过"后面那句（要说清后果） */
  skipNote: string;
  /** 空着就提交时报的错 */
  emptyError: string;
  /** 真要存的时候调它；抛错就当没存上（错误原样给用户看） */
  save: (value: string) => void;
  /**
   * 可选：**存之前**先验一把。
   *
   * 返回 `blocking` 的错就不存（让他在页面上改）；返回"没法确认"照存但会在
   * 页面上说一句；返回 ok 就正常存。（模型 key 用它 —— 贴错了不会报错，
   * 只会在几小时后表现为"管家不回你"，那是最难自己查出来的一种坏法。）
   */
  verify?: (value: string) => Promise<KeyVerdict>;
  /** 可选：多一个"用我在别处已有的那把"按钮（模型 key 用它搬 dsh 里那把） */
  also?: { label: string; run: () => void; done: string };
}

/**
 * 该问才问：已经有 key 就直接过。
 *
 * 返回 `'skipped'` 时**不要**当成失败 —— 没 key 也能先把微信登上，
 * 用户回头补一句就行（`butler run` 会再问一次）。
 */
export async function ensureModelKey(opts: KeyPageOptions): Promise<KeyOutcome> {
  const env = opts.env ?? process.env;
  const file = credentialsFileOf(opts.dshHome);
  const state = keyState(file, opts.ref, env);

  if (state === 'env') {
    opts.log(`模型 key：来自启动环境里的 ${opts.ref}（DSH 优先用它，不用再存一份）`);
    // 这一条必须说清楚：这时候存进文件是**不生效**的（DSH 优先读环境变量），
    // 不提醒的话，用户会以为"重新贴了怎么还不行"。
    if (opts.force) {
      opts.log(`  ⚠️ 想换一把的话，先把启动环境里的 ${opts.ref} 去掉 —— 只往文件里存是不生效的。`);
    }
    return 'present';
  }
  if (state === 'stored' && !opts.force) {
    opts.log('模型 key：已经有了 ✓');
    return 'present';
  }
  if (opts.force && state === 'stored') {
    opts.log('模型 key：再问你一次（想换一把）—— 不填就还用原来那把');
  }

  const globalFile = opts.globalCredentialsFile ?? join(homedir(), '.dsh', '.credentials.yaml');
  const canCopyFromDsh = existsSync(globalFile) && refsOf(readText(globalFile)).has(opts.ref);

  return askForSecret(
    {
      name: '模型 key',
      title: '管家 · 填模型 key',
      heading: '填一下模型 key',
      lead: '管家要用<b>你自己的</b>模型 key 才能思考。它只写进这台电脑上的一个文件，\n'
        + `不上传、不经我们的服务器：<br><code>${esc(file)}</code>`,
      where: '去哪儿拿：打开\n'
        + '<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a>\n'
        + '→ API keys → 新建 → 复制（<code>sk-</code> 开头）。手机上复制好，回来粘这里也行。',
      placeholder: 'sk-…（粘贴到这里）',
      after: '回到那个终端窗口就行 —— 接下来会让你用微信扫码。',
      skipText: '好，先跳过。回头再跑一次 butler run 就会再问你。',
      skipNote: '没有它管家答不了话 —— 回头再跑一次 butler run 就会再问你',
      emptyError: '还没填 key 呢',
      save: (value) => saveKeyRef(file, opts.ref, value),
      verify: opts.verifyKey ?? ((value) => verifyModelKey(value)),
      ...(canCopyFromDsh
        ? {
            also: {
              label: '用我在 dsh 里已有的那把',
              run: () => {
                const value = valueOf(readText(globalFile), opts.ref);
                if (value === null) throw new Error('你 dsh 里那把没读出来，还是手动贴一下吧');
                saveKeyRef(file, opts.ref, value);
              },
              done: '✅ 存好了（用的是你 dsh 里那把）',
            },
          }
        : {}),
    },
    opts,
  );
}

export interface ChannelTokenOptions extends SecretPageOptions {
  /** 管家目录：凭据文件在 `<它>/state/secrets.json` */
  butlerDir: string;
  /** 凭据文件里挂在哪个通道下面（`telegram`） */
  channel: string;
  /** 字段名（`botToken`） */
  key: string;
  /** 给用户看的名字（`Telegram 的 bot token`） */
  name: string;
  /** 去哪儿拿（一句话，通常来自 `secrets.ts` 里的 `hint`） */
  hint: string;
  /** `--again`：就算已经存过也重新问一遍（换一串的时候） */
  force?: boolean;
}

/**
 * 通道自己的凭据（现在只有 Telegram 的 bot token）。
 *
 * 为什么不塞进 `config.json`：见 `secrets.ts` 的文件头 —— 那份文件是引导用户
 * 去读的，凭据进去等于鼓励泄露。
 */
export async function ensureChannelToken(opts: ChannelTokenOptions): Promise<KeyOutcome> {
  const file = secretsFileOf(opts.butlerDir);
  const stored = secretOf(file, opts.channel, opts.key);
  if (stored && !opts.force) {
    opts.log(`${opts.name}：已经有了 ✓`);
    return 'present';
  }
  if (opts.force && stored) {
    opts.log(`${opts.name}：再问你一次（想换一串）—— 不填就还用原来那串`);
  }
  const link = linkOf(opts.hint);
  return askForSecret(
    {
      name: opts.name,
      title: `管家 · 填 ${opts.name}`,
      heading: `填一下 ${opts.name}`,
      // 这里**故意不写通道名**（`opts.channel` 是给程序看的 key，长得像 telegram 这种小写）
      // —— 大标题里已经有人话名字了，正文不用再念一遍机器名
      lead: '管家要靠一个聊天机器人收发消息。它只写进这台电脑上的一个文件，\n'
        + `不上传、不经我们的服务器：<br><code>${esc(file)}</code>`,
      where: link === null ? opts.hint : opts.hint.replace(link.text, `<a href="${link.href}" target="_blank" rel="noreferrer">${link.text}</a>`),
      placeholder: '123456:ABC-DEF…（粘贴到这里）',
      after: '回到那个终端窗口就行 —— 它接着就会用这个机器人收发消息。',
      skipText: '好，先跳过。回头再跑一次 butler run 就会再问你。',
      skipNote: '没有它这个通道起不来 —— 回头再跑一次 butler run 就会再问你',
      emptyError: '还没填呢',
      save: (value) => saveSecret(file, opts.channel, opts.key, value),
    },
    opts,
  );
}

/**
 * 把提示里那个 `@BotFather` 变成链接。
 *
 * 只认一条：形如 `@名字` 的那一段。找不到就不动它（宁可没链接，也不要瞎替换）。
 */
function linkOf(hint: string): { text: string; href: string } | null {
  const match = /@([A-Za-z][A-Za-z0-9_]{3,})/.exec(hint);
  if (!match) return null;
  return { text: match[0], href: `https://t.me/${match[1]}` };
}

export interface ChannelSecretsGateOptions {
  /** 管家目录（凭据文件在 `<它>/state/secrets.json`） */
  butlerDir: string;
  log: (line: string) => void;
  port?: number;
  timeoutMs?: number;
  open?: (url: string) => void;
  /**
   * 允许自动开浏览器吗（默认允许）。
   *
   * `butler run --no-open` 会把它设成 false —— **自启动**场景专用（每次登录都弹一个
   * 页面出来很烦）。设成 false 时终端里**照旧打地址**，只是不替你开。
   */
  autoOpen?: boolean;
  signal?: AbortSignal;
  /** `--again`：就算存过也重新问一遍（换一串的时候） */
  force?: boolean;
}

/**
 * 通道凭据那一关：`butler run` 在**装容器之前**调它。
 *
 * 三条优先级，从高到低：
 *
 *   1. **配置里写死了**（`config.botToken` 非空）—— 高级用户手写的那份，我们一个字不改
 *   2. **引导页以前存过的** —— 直接填进行里，不打扰他
 *   3. 都没有 —— 起页面问他一次（跳过了也照常往下走：通道自己会说清缺什么）
 *
 * 返回真填了哪几个字段（空数组 = 这轮没什么可填的）。
 */
/**
 * 把"页面通用选项"原样传下去。
 *
 * ⚠️ 这里原来是**逐个字段手写**转发的 —— 新加 `autoOpen` 时漏了一处，于是守门那条路
 *    （`butler run` 走的正是它）照旧谎称"页面已经自动打开"，而直连页面的用例全绿。
 *    收成这一个函数：以后加字段只改这里一处，不会再出现"接口加了、路没通"。
 */
function pageOptionsOf(opts: SecretPageOptions): Omit<SecretPageOptions, 'log'> {
  return {
    ...(opts.port === undefined ? {} : { port: opts.port }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.open === undefined ? {} : { open: opts.open }),
    ...(opts.autoOpen === undefined ? {} : { autoOpen: opts.autoOpen }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };
}

export async function ensureChannelSecrets(
  rows: readonly { name: string; config?: Record<string, unknown> | undefined }[],
  opts: ChannelSecretsGateOptions,
): Promise<string[]> {
  for (const row of rows) {
    const needs = channelSecretNeeds(row);
    if (needs.length === 0) continue;

    const file = secretsFileOf(opts.butlerDir);
    // ① 配置里写了的那几项，听他的 —— 一个通道要两项时可能只写死了一项，
    //    所以筛的是"缺少的项"，不是"这个通道有没有配过"
    const missing = needs.filter((n) => {
      const current = row.config?.[n.key];
      return !(typeof current === 'string' && current.trim() !== '');
    });
    if (missing.length === 0) continue;

    const storedAll = missing.every((n) => secretOf(file, n.channel, n.key));
    if (storedAll && !opts.force) {
      const filled = injectChannelSecrets(rows, file);
      opts.log(`通道凭据：填上了你上次存的那串（${missing.map((n) => n.name).join('、')}）✓`);
      return filled;
    }

    // 缺哪项问哪项：存过的那项不重问（除非 --again）
    const outcomes: KeyOutcome[] = [];
    for (const need of missing) {
      // 上面按了 Ctrl-C：剩下的别再问了 —— 不然会为下一项再开一个页面、再等一轮
      if (opts.signal?.aborted) break;
      if (!opts.force && secretOf(file, need.channel, need.key)) continue;
      outcomes.push(await ensureChannelToken({
        butlerDir: opts.butlerDir,
        channel: need.channel,
        key: need.key,
        name: need.name,
        hint: need.hint(opts.butlerDir),
        log: opts.log,
        ...pageOptionsOf(opts),
        ...(opts.force === undefined ? {} : { force: opts.force }),
      }));
    }
    // ⚠️ 不管存没存上，都再注入一次：他点了"先跳过"的话，原来那串必须还在行里
    //   （`--again` 是"再问一次"，不是"清空重来"）
    const filled = injectChannelSecrets(rows, file);
    if (filled.length > 0 && outcomes.includes('saved')) {
      opts.log('✅ 填好了（那个文件是 0600，只有这台电脑上你的账号能读）。');
    } else if (filled.length > 0 && outcomes.includes('skipped')) {
      opts.log('（还是用你原来那串）');
    }
    // 跳过不拦路：通道自己的 check / start 会说清缺什么，doctor 也会
    return filled;
  }
  return [];
}

/**
 * 页面引擎本体。两种问法共用它 —— **安全相关的代码只能有一份**。
 */
export async function askForSecret(prompt: SecretPrompt, opts: SecretPageOptions): Promise<KeyOutcome> {
  const token = randomBytes(16).toString('hex');
  const port = await listen(opts.port ?? DEFAULT_KEY_PORT);
  const server = port.server;
  // ⚠️ 结尾这个斜杠不能少：页面里的 fetch('key') 是**相对路径**，
  //    少了它基址就成了 /s/，请求会打到 /s/key 上（404）
  const base = `/s/${token}/`;
  const url = `http://127.0.0.1:${port.actual}${base}`;

  let settle: (outcome: KeyOutcome) => void = () => {};
  const done = new Promise<KeyOutcome>((resolve) => { settle = resolve; });

  server.on('request', (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('出错了');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0]!;
    // 没有那一串随机数就当没这个页面 —— 别的网页猜不到它
    if (!path.startsWith(base)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('没有这个页面');
      return;
    }
    const route = path.slice(base.length);

    if (req.method === 'GET' && route === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(prompt));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('不支持');
      return;
    }

    if (route === 'skip') {
      json(res, { ok: true });
      settle('skipped');
      return;
    }

    if (route === 'from-dsh' && prompt.also) {
      try {
        prompt.also.run();
      } catch (error) {
        json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
      json(res, { ok: true, source: 'dsh' });
      settle('saved');
      return;
    }

    if (route === 'key') {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        json(res, { ok: false, error: '提交的内容太大了' }, 413);
        return;
      }
      let key: unknown;
      let force = false;
      try {
        const parsed = JSON.parse(body) as { key?: unknown; force?: unknown };
        key = parsed.key;
        // "我知道，就要存这一把" —— 校验是**替人把关**，不是**替人做主**。
        // （换了别的模型服务商的人，会在这里被判 401；他得有路过去。）
        force = parsed.force === true;
      } catch {
        json(res, { ok: false, error: '没读懂提交的内容' }, 400);
        return;
      }
      if (typeof key !== 'string' || key.trim() === '') {
        json(res, { ok: false, error: prompt.emptyError }, 400);
        return;
      }
      // **先验一把再存**：贴错了要当场说，不能等到几小时后表现为"管家不回你"
      const verdict = prompt.verify && !force ? await prompt.verify(key) : null;
      if (verdict && !verdict.ok && verdict.blocking) {
        json(res, {
          ok: false,
          error: verdict.why,
          ...(verdict.hint ? { hint: verdict.hint } : {}),
          // 页面上据此多给一个按钮 —— 绝不把人堵死在这一步
          allowAnyway: true,
        }, 400);
        return;
      }
      try {
        prompt.save(key);
      } catch (error) {
        json(res, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        return;
      }
      json(res, {
        ok: true,
        source: 'typed',
        // 没法确认（网络不通之类）：**照存**，但要说出来 —— 不然他会以为验过了
        ...(verdict && !verdict.ok ? { warning: verdict.why } : {}),
      });
      settle('saved');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('没有这个页面');
  }

  const timeout = setTimeout(() => settle('skipped'), opts.timeoutMs ?? DEFAULT_KEY_TIMEOUT_MS);
  timeout.unref?.();
  const onAbort = (): void => settle('skipped');
  // ⚠️ 已经中断过的信号，listener **不会再响**（那件事早就发生完了）—— 不查这一下，
  //    飞书这种要两项凭据的通道在 Ctrl-C 之后会为第二项**再等满一个 timeout**，
  //    在终端里看起来就是"卡住了"（实测：4.2 秒，正好是超时）。
  if (opts.signal?.aborted) settle('skipped');
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  opts.log(`${prompt.name}：还没有，起了一个本地页面让你贴`);
  opts.log(`  ${url}`);

  // **先真的试着开，再照实说**。以前这里无论开没开都打"页面已经自动打开" ——
  // 而 `--no-open`（自启动走的就是它）恰好是不开的，用户会去等一个永远不出现的窗口。
  // 现在连"开了但失败"（服务器上没有 xdg-open / open）也照实说：只有真开成了才说开成了。
  let opened = false;
  if (opts.autoOpen !== false) {
    // ⚠️ 打开浏览器**在这里面**：它要是同步抛（PATH 里没那个命令），
    //   页面不能被我们弄丢 —— 而且下面 finally 必须照样把服务器关掉
    try {
      (opts.open ?? openBrowser)(url);
      opened = true;
    } catch {
      // 打不开就算了：地址已经打在终端里，用户自己点也行
    }
  }
  opts.log(opened
    ? '（页面已经自动打开；在手机上复制、到这台电脑的浏览器里粘贴也行）'
    : '（这次没自动开浏览器 —— 把上面这个地址复制到浏览器里打开就行）');

  let outcome: KeyOutcome = 'skipped';
  try {
    outcome = await done;
    if (outcome === 'saved') await sleep(SETTLE_MS); // 让"✅ 好了"在页面上看得见
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
    await close(server);
  }

  if (outcome === 'saved') opts.log(`${prompt.name}：存好了 ✓（下次不用再贴）`);
  else if (outcome === 'skipped') {
    opts.log(`${prompt.name}：先跳过。${prompt.skipNote}`);
  }
  return outcome;
}

/** 起一个只监听回环的服务器；端口被占就往后找一个（跟扫码页同一套脾气） */
async function listen(preferred: number): Promise<{ server: Server; actual: number }> {
  for (let i = 0; i < 12; i += 1) {
    const port = preferred + i;
    const server = createServer();
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, actual: port };
    server.close();
  }
  throw new Error(`从 ${preferred} 往后 12 个端口都被占了，起不了引导页`);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // ⚠️ 必须先掐断活着的连接：浏览器的 keep-alive 会让 close() 的回调**永远不触发**
    //   （实测把跑测试的进程挂了五分钟）。这里不图优雅，图的是能退出。
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 从一份凭据文本里取出某个引用名的值（只认我们写的那种结构） */
function valueOf(text: string, ref: string): string | null {
  const lines = text.split('\n');
  const refsAt = lines.findIndex((l) => /^refs\s*:/.test(l));
  const scope = refsAt >= 0 ? lines.slice(refsAt + 1) : lines;
  for (const line of scope) {
    const body = line.trim();
    if (refsAt >= 0 && body !== '' && line.length - line.trimStart().length === 0) break;
    const match = new RegExp(`^\\s*${ref}\\s*:\\s*(.*)$`).exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return null;
      }
    }
    return raw === '' ? null : raw;
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        // 不 destroy：让 handler 有机会把 413 写回去（掐掉 socket 客户端只会看到网络错误）
        reject(new Error('too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 用系统的方式打开浏览器。**失败不影响流程**：地址在终端里已经打了 */
export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* 没有浏览器/打不开：无所谓 */ });
    child.unref();
  } catch {
    // 同步抛（比如 PATH 里根本没有那个命令）也不算事
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

/** JS 字符串字面量（文案里有引号也不会把页面写坏） */
function js(text: string): string {
  return JSON.stringify(text).replace(/</g, '\\u003c');
}

/**
 * 页面本身。**故意做得极简**：一个字都不多问，就一个输入框。
 * 没有外链样式、没有字体、没有统计 —— 它只在 127.0.0.1 上活几分钟。
 */
function page(prompt: SecretPrompt): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(prompt.title)}</title>
<style>
  :root { color-scheme: light dark }
  body { font: 16px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; padding: 40px 20px; display: flex; justify-content: center }
  main { max-width: 560px; width: 100% }
  h1 { font-size: 22px; margin: 0 0 4px }
  p { margin: 12px 0; opacity: .85 }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 4px; font-size: 13px }
  input { width: 100%; box-sizing: border-box; font-size: 16px; padding: 12px 14px;
          border: 1px solid rgba(127,127,127,.5); border-radius: 10px; background: transparent; color: inherit }
  button { font-size: 16px; padding: 11px 18px; border-radius: 10px; border: 0;
           background: #2b6cff; color: #fff; cursor: pointer }
  button.plain { background: transparent; color: inherit; border: 1px solid rgba(127,127,127,.5) }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap }
  .muted { font-size: 14px; opacity: .7 }
  #msg { margin-top: 14px; min-height: 22px }
  .ok { color: #12894a } .bad { color: #c62828 }
</style></head><body><main>
<h1>${esc(prompt.heading)}</h1>
<p>${prompt.lead}</p>
<p class="muted">${prompt.where}</p>

<form id="f">
  <input id="key" type="password" autocomplete="off" spellcheck="false"
         placeholder="${esc(prompt.placeholder)}" autofocus>
  <div class="row">
    <button type="submit">保存</button>
    ${prompt.also ? `<button type="button" class="plain" id="copy">${esc(prompt.also.label)}</button>` : ''}
    <button type="button" class="plain" id="skip">先跳过</button>
  </div>
</form>
<div id="msg"></div>
<p class="muted" id="after" hidden>${esc(prompt.after)}</p>
<script>
  const msg = document.getElementById('msg');
  const after = document.getElementById('after');
  function say(text, cls) { msg.textContent = text; msg.className = cls || ''; }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
                                 body: JSON.stringify(body || {}) });
    return r.json().catch(() => ({ ok: false, error: '服务没有回应' }));
  }
  function done(text) { say(text, 'ok'); after.hidden = false; document.getElementById('f').hidden = true; }
  /** 校验没过的出口：**我们不替人做主**，但要说清"这是你自己确认的" */
  function allowAnyway(key) {
    if (document.getElementById('force')) return;
    const b = document.createElement('button');
    b.id = 'force'; b.type = 'button'; b.className = 'plain';
    b.textContent = '我知道，就要存这一把';
    b.addEventListener('click', async () => {
      const r2 = await post('key', { key, force: true });
      if (r2.ok) done('✅ 存好了（你自己确认过的）'); else say(r2.error || '还是没存上', 'bad');
    });
    msg.after(b);
  }
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = document.getElementById('key').value;
    if (!key.trim()) return say(${js(prompt.emptyError)}, 'bad');
    say('存着…（顺便问一句这把 key 能不能用）');
    const r = await post('key', { key });
    if (r.ok) done('✅ 存好了' + (r.warning ? '（' + r.warning + '）' : ''));
    else {
      say((r.error || '没存上') + (r.hint ? ' —— ' + r.hint : ''), 'bad');
      if (r.allowAnyway) allowAnyway(key);
    }
  });
  const copy = document.getElementById('copy');
  if (copy) copy.addEventListener('click', async () => {
    say('读你 dsh 里那把…');
    const r = await post('from-dsh');
    if (r.ok) done(${js(prompt.also ? prompt.also.done : '✅ 存好了')}); else say(r.error || '没读出来', 'bad');
  });
  document.getElementById('skip').addEventListener('click', async () => {
    // 跳过也得让服务端知道，否则它会一直等
    await post('skip');
    say(${js(prompt.skipText)});
    after.hidden = false;
    document.getElementById('f').hidden = true;
  });
</script>
</main></body></html>
`;
}
