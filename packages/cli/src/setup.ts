/**
 * 第一件事：把「家」安好。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────
 *
 * 这个产品要卖给**完全不懂技术的人**，而在他动手之前，我们以前要求他：
 * 找到 `~/.butler/`、新建一个 JSON、把插件名字拼对、把三个路径都填成绝对路径。
 * **那一步就是终点** —— 拼错一个字符的表现是"装不上"，而且猜不出为什么。
 *
 * 所以：**配置由程序写，不由用户写。** `butler init` 一次把这几个文件写好，
 * 而且**只写缺的那些**：已经存在的文件一个字节都不动（用户改过的、后来加过设备
 * 的名册，都不能被一次"初始化"抹掉）。
 *
 * ── 生成了什么 ────────────────────────────────────────────────────
 *
 *   ~/.butler/config.json        装哪几个插件（四个：通道 / agent / 内核 / 链路）
 *   ~/.butler/dsh.patch.yml      给 agent 用的补丁：模型通道 + **人格**
 *   ~/.butler/dsh-home/          管家私有的 DSH 数据目录（不含密钥，运行时才建）
 *
 * 人格那份是**产品契约**，不是示例：微信里发出去的是纯文本、发文件走
 * `[[file:…]]` 那一行、不许拿截图模拟鼠标去点界面。这些约定写在
 * `@butler/agent-dsh` 的模板里，每次 init 都照抄一份 —— 用户**不需要**理解它，
 * 但少了它，用户会天天收到 Markdown 表格。
 *
 * @module @butler/cli/setup
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 什么都还没配的时候，配置在哪。`--config` 不给就用这个 */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.butler', 'config.json');

/** 管家自己的家。放在用户 home 下，但只归它用 */
export function butlerHome(): string {
  return join(homedir(), '.butler');
}

export function defaultPatchPath(): string {
  return join(butlerHome(), 'dsh.patch.yml');
}

export function defaultDshHome(): string {
  return join(butlerHome(), 'dsh-home');
}

/**
 * 读不到模板时的兜底。**不该发生**，但初始化失败比人格缺失更糟。
 *
 * 它必须和 `@butler/agent-dsh/templates/default.patch.yml` 的**插件行**保持一致
 * （注释可以不同）—— `test/setup.mjs` 里有一条对账的用例盯着这件事。
 */
export const FALLBACK_PATCH = `# 模型通道（默认 DeepSeek，不用改；key 由引导页写进凭据库）
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-flash

# 人格：输出会原样发进微信，禁止 Markdown
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    personaPrefix: >-
      你是一个通过微信被远程遥控的私人助理，运行在用户自己的机器上。
      输出会被原样发进微信：禁止 Markdown（表格、代码围栏、# 标题、** 粗体都不要），
      用纯文本短句，结论先行，默认 200 字以内。
      要发文件就单独写一行 [[file:/绝对/路径]]，写之前先确认文件真实存在。
      碰到**长期有用**的事（主人的偏好、常用路径、习惯、怎么称呼他），
      就在回复的**最后单独一行**写 [[记住: 一句话]]；一次最多写一条，
      拿不准就**别写**——记错了比没记住更糟。一次性的东西（这次的任务、这次的结果）不要写。
      破坏性操作先问一句再动手。
    personaSuffix: 你的工作目录是 {{cwd}}。

# 碰到敏感操作先问一声：应答者把问题问进微信，**到点没人答就是不许**。
# （没有应答者也不怕：dsh 的兜底是 unavailable，调用方 fail-closed，不会卡住。）
- id: approval
  config:
    policy: ask

# 兜底里只能写包名。真模板由 butler init 在末尾追加一行指向实际安装路径
- id: approval-answerer
  name: '@butler/approval-im/answerer'
`;

/**
 * 管家给 DSH 的那份补丁模板（含人格）。模板跟着 `@butler/agent-dsh` 走 ——
 * 人格是 agent 那一侧的契约，所以它归那个包管，这里只是抄一份到用户家里。
 */
export function patchTemplate(): string {
  let base: string;
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve('@butler/agent-dsh/templates/default.patch.yml');
    base = readFileSync(file, 'utf8');
  } catch {
    base = FALLBACK_PATCH;
  }
  const answerer = answererRow();
  return answerer === null ? base : `${base.trimEnd()}\n\n${answerer}\n`;
}

/**
 * 审批应答者那一行（追加在补丁末尾）。
 *
 * **必须写绝对路径。** 子进程里的 dsh 是从它自己的模块位置去 import 插件的，
 * 而 `@butler/...` 这种包名能不能解析，取决于安装布局（两者在同一个
 * node_modules 树下才行）。绝对路径没有这个不确定性 —— 这一行就是
 * "要动你的电脑"能不能问出来的那根线。
 *
 * 解析不到就不加这一行：那一侧退化成"问了没人答"，也就是一律不许 ——
 * 安全，只是管家干不了敏感的事。绝不因为装不上就把闸门放开。
 */
function answererRow(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const file = require.resolve('@butler/approval-im/answerer');
    return [
      '# 审批应答者：把"要动你的电脑"问进对话里（这一行由 butler init 生成）',
      '# 没有它，dsh 对敏感操作的处理是"问了没人答"→ 一律不许。',
      '- id: approval-answerer',
      `  name: '${file}'`,
      '  config:',
      `    home: '${butlerHome()}'`,
    ].join('\n');
  } catch {
    return null;
  }
}

/** 这一台怎么找到别的机器：同一个 WiFi（lan），还是尾巴网络（tailscale） */
export type LinkName = 'lan' | 'tailscale';

export const LINK_NAMES: LinkName[] = ['lan', 'tailscale'];

export interface DefaultConfigOptions {
  /**
   * 用哪条链路找别的机器。
   *
   * 默认 `lan`（老行为一个字没变）。选 `tailscale` 时**不写共享密钥** ——
   * 那条路靠「配对」把设备一台台收进来，每台带一把自己的密钥，
   * 用户不需要在两台机器上把同一串东西抄对。
   */
  link?: LinkName;
  /** 让它管哪个目录。默认就是你的家目录 */
  workspace?: string;
  /** 给 agent 用的补丁文件 */
  /**
   * 管家目录（登录态、收到的文件、通道的 state 都在这儿）。
   *
   * 不传就按 `~/.butler` 算。`--config` 指到别处时由 init 传进来 ——
   * 不然通道的 state 会落在 `~/.butler`，而配置在别处，两边对不上。
   */
  home?: string;
  patchFile?: string;
  /** 管家私有的 DSH 数据目录 */
  dshHome?: string;
  /**
   * 这台是「被遥控的那台」（节点）吗。
   *
   * 节点那份**没有通道、也没有内核** —— 它不登录微信。而且这是硬性的：
   * 同一个微信号被两个进程同时收信，消息会随机分到两边，看起来就是"时好时坏"。
   */
  node?: boolean;
  /**
   * 用哪个 IM 收信。
   *
   * **一次只能上一个**：`ctx.channel` 只有一个位置（seam 的注释里写着：
   * 加载第二个通道实现会抛错）。所以这不是"多选"，是"你打算用哪个"。
   */
  im?: ImName;
}

/** 支持的 IM。加一个就是加一行 —— **核心层不需要知道有这个东西存在** */
export type ImName = 'wechat' | 'telegram' | 'feishu';

export const IM_NAMES: ImName[] = ['wechat', 'telegram', 'feishu'];

/**
 * 通道那一行长什么样。
 *
 * 这是"换一个 IM 要改的全部"：一行配置的 `name`。核心层、doctor、
 * `butler run` 都只认 `ctx.channel`，谁实现的它们不关心。
 */
function channelRow(im: ImName, home: string): { id: string; name: string; config: Record<string, unknown> } {
  if (im === 'telegram') {
    // token 留空：doctor 会说"还没有填 bot token"，并指到 @BotFather。
    // 留一行空值在这里，用户至少知道**该往哪儿填**。
    return { id: 'channel', name: '@butler/channel-telegram', config: { home, botToken: '' } };
  }
  if (im === 'feishu') {
    // 两个值都留空（和 Telegram 同一个道理）：doctor 会说缺什么，
    // 引导页会挨个问。**真值只会进 `state/secrets.json`，不进这个文件** ——
    // 这份 config.json 是引导用户去读的，凭据进去等于鼓励泄露。
    return { id: 'channel', name: '@butler/channel-feishu', config: { home, appId: '', appSecret: '' } };
  }
  return { id: 'channel', name: 'wechat-agent-bridge/plugin', config: { home } };
}

/**
 * 后来才加上去的"能力行"。
 *
 * 补行**只补这几样**：它们的配置全都能从 home 推出来，不含任何用户的选择。
 * 通道 / agent / 内核那三行**故意不补** —— 那里面有工作目录、有他选的 IM、
 * 有他自己挑的 agent；替他猜一个默认值，等于悄悄改了他的东西。
 */
function abilityRows(home: string, link: LinkName = 'lan'): { id: string; name: string; config: Record<string, unknown> }[] {
  return [
    // 记忆这一行**默认就带着**：主人说过的偏好都记在 `home/state/memory.json` 里。
    // 没有它，管家每句话都是第一次见你。
    // 只挂在**中枢**这份配置上 —— 记忆是主人的，不是某一台机器的。
    { id: 'memory', name: '@butler/memory-file', config: { home } },
    // 审批这一行也**默认带着**：dsh 那侧在做敏感操作之前会问一声，问题经这里
    // 转成一条消息问进对话里 —— **到点没人答就是不许**。
    // 没有这一行，子进程里的策略是"一律拒绝"：安全，但管家什么也干不了。
    { id: 'approval', name: '@butler/approval-im', config: { home } },
    // 链路这一行**默认就带着**：它本身不监听任何端口（只有节点那侧才监听），
    // 留着它，用户以后想在微信里「配对」第二台电脑时不用回来改配置。
    //
    // 尾巴网络那条**要把名册路径钉在这儿**：不钉就落到"当前的 butler 家"里，
    // 而用户用 `--config` 把家搬到别处时，名册会悄悄落回 ~/.butler —— 跟配置对不上。
    link === 'tailscale'
      ? { id: 'link', name: '@butler/link-tailscale', config: { peersFile: join(home, 'state', 'tailscale-peers.json') } }
      : { id: 'link', name: '@butler/link-lan', config: {} },
  ];
}

/** 默认配置。**一行一个插件**，每个值都是现成的，用户不用填任何东西 */
export function defaultConfigText(opts: DefaultConfigOptions = {}): string {
  const workspace = opts.workspace ?? homedir();
  const butlerHomeDir = opts.home ?? butlerHome();
  const patchFile = opts.patchFile ?? defaultPatchPath();
  const dshHome = opts.dshHome ?? defaultDshHome();

  // 注意：agent 那一行**不带 workspace** —— 工作目录是内核的事（它把 cwd 传给 agent），
  // 而且 agent-dsh 的 Config 里根本没有这个字段，塞进去是自找的。
  const agent = {
    id: 'agent',
    name: '@butler/agent-dsh',
    config: { patchFile, home: dshHome },
  };

  const rows = opts.node
    ? [agent, { id: 'node', name: '@butler/link-lan/node', config: { alias: aliasFor(workspace), port: 41338, cwd: workspace } }]
    : [
        // 登录态、收到的文件都在这个目录下（`home/state/`）。
        // **必须钉住**：不写它就落在"当前工作目录"，用户在哪个目录敲的 butler
        // 就在哪儿 —— 换个目录启动就得重新扫码，而且没人会想到是这个原因。
        channelRow(opts.im ?? 'wechat', butlerHomeDir),
        agent,
        { id: 'core', name: '@butler/core', config: { workspace } },
        ...abilityRows(butlerHomeDir, opts.link ?? 'lan'),
      ];

  return `${JSON.stringify({ plugins: rows }, null, 2)}\n`;
}

/** 节点在微信里叫什么。用户随时可以改，但总得有个能说出口的默认值 */
function aliasFor(workspace: string): string {
  const base = workspace.split(/[\\/]/).filter(Boolean).pop();
  return base ? `这台（${base}）` : '这台电脑';
}

export interface InitResult {
  configPath: string;
  /**
   * 这一台**最终**用哪个 IM 收信。
   *
   * `--im` 没给 = 沿用配置里原来那个（用户只是重跑一次 init，不该被悄悄切回微信）——
   * 所以调用方要按这个值出引导文案，别看自己传了什么。
   */
  im: ImName;
  /** 通道行是从哪个包换过来的（没换就没有这个字段） */
  switchedFrom?: string;
  /** 这次写下去的文件 */
  written: string[];
  /** 已经存在、没有整份重写的文件 */
  kept: string[];
  /**
   * 这次给**老配置补上**的能力行 id（升级时新加的记忆/审批/链路）。
   *
   * 空数组 = 什么都没补（新装的、或者早就补齐了）。
   */
  added: string[];
  /** 想补却没敢动的原因（配置坏了之类）—— 要如实说出来，不能装没事 */
  topUpSkipped?: string;
}

export interface InitOptions extends DefaultConfigOptions {
  configPath?: string;
  /** 连配置一起重写。**默认 false**：用户改过的东西不能被我抹掉 */
  force?: boolean;
}

/**
 * 给已有的配置补上缺的能力行。**只追加、不改已有的行、不重排**。
 *
 * 返回补上的行 id；配置读不动或者不是我们这个形状时，一行都不补，
 * 并用 `skipReason` 说明为什么 —— 猜着改用户的配置比不补更糟。
 */
/** 认出来的一份配置：`plugins` 那串东西 + 里面已经有哪些行 id（`root` 是整份，补行时不能弄丢别的键） */
interface ConfigShape {
  root: Record<string, unknown>;
  plugins: unknown[];
  ids: Set<string>;
}

/**
 * 只读地把配置认一遍。
 *
 * 三种结果：认出来了（`ConfigShape`）/ 是我要的形状但**读不动**（`skipReason`，
 * 这种事要说出来）/ **压根不是这个形状**（`null` —— 那就当没这回事，一个字别动）。
 */
function readConfigShape(configPath: string): ConfigShape | { skipReason: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { skipReason: '这份配置读不出来（不是合法的 JSON）' };
  }
  const root = parsed as Record<string, unknown> | null;
  const plugins = root?.plugins;
  if (!root || !Array.isArray(plugins)) return null;
  const ids = new Set(
    (plugins as { id?: unknown }[]).map((r) => r?.id).filter((id): id is string => typeof id === 'string'),
  );
  return { root, plugins, ids };
}

/**
 * 缺哪几行能力行。**规则只留这一处** —— `init` 的补行和 `run` 的提醒走的
 * 是同一条，两边分家就会出现"run 说缺、init 却说齐了"这种最伤人的矛盾。
 */
function missingIn(shape: ConfigShape | { skipReason: string } | null, home: string): string[] {
  if (!shape || 'skipReason' in shape) return [];
  // 被遥控的那台不需要能力行：它只把本机的 agent 摊给中枢用
  if (shape.ids.has('node')) return [];
  // **认得出这是我生成的那份配置，才管。** 有内核那一行 = 中枢配置。
  // 没有它就别猜：这可能是别的程序的文件、也可能用户故意清空了 ——
  // 替人猜着往里塞东西，比不补更糟。
  if (!shape.ids.has('core')) return [];
  return abilityRows(home).filter((r) => !shape.ids.has(r.id)).map((r) => r.id);
}

/**
 * 这份配置里缺哪些能力行。**只读，一个字节都不写。**
 *
 * 给 `butler run` 用：老配置升上来的时候能力行还没补，那时候管家碰到要动
 * 电脑的事会**一律拒绝**。`run` 不写文件（这是刻意的），但至少要**说一句** ——
 * 不说的话，他只会觉得"这破玩意儿什么也不肯干"。
 */
export function missingAbilityRows(configPath: string): string[] {
  return missingIn(readConfigShape(configPath), dirname(configPath));
}

/** 通道行的包名 → IM 名。三个 IM 的通道行 `id` **都是** `channel`，所以认这一行只看 id。 */
const CHANNEL_PKG: Record<string, ImName> = {
  'wechat-agent-bridge/plugin': 'wechat',
  '@butler/channel-telegram': 'telegram',
  '@butler/channel-feishu': 'feishu',
};

/** 这一台现在用哪个 IM 收信。**只读，一个字节都不写。** 认不出来就是 `undefined`（那就别猜） */
function channelImOf(configPath: string): ImName | undefined {
  const shape = readConfigShape(configPath);
  if (!shape || 'skipReason' in shape) return undefined;
  const row = (shape.plugins as { id?: unknown; name?: unknown }[]).find((r) => r?.id === 'channel');
  return typeof row?.name === 'string' ? CHANNEL_PKG[row.name] : undefined;
}

function topUpRows(
  configPath: string,
  home: string,
  wantedIm: ImName,
): { added: string[]; switchedFrom?: string; skipReason?: string } {
  const shape = readConfigShape(configPath);
  if (shape && 'skipReason' in shape) return { added: [], skipReason: shape.skipReason };
  if (!shape || 'skipReason' in shape) return { added: [] };

  const missing = missingIn(shape, home);
  const rows = shape.plugins as { id?: unknown; name?: unknown }[];

  // 通道那一行：`init --im X` 要把它**原位换成** X。
  //
  // 不换的话是这个下场：用户为飞书敲了 `--im feishu`，配置里那行却还是微信 —— 凭据存着、
  // `doctor` 也不提飞书，他照着手册走到最后，跑起来的还是微信，在飞书里发消息
  // **什么都不会发生**。（第 23 轮实测：以前这里一个字节都不改。）
  //
  // 规矩和补能力行**同一条**：认得出是我生成的那份才动（有内核那行、且不是被遥控的那台），
  // 而且**包名认不出来就不猜**（那可能是他自己接的别的通道）。
  const at = rows.findIndex((r) => r?.id === 'channel');
  const currentName = typeof rows[at]?.name === 'string' ? (rows[at]?.name as string) : '';
  const currentIm = CHANNEL_PKG[currentName];
  const ours = shape.ids.has('core') && !shape.ids.has('node');
  let next: ReturnType<typeof channelRow> | null = null;
  let switchedFrom: string | undefined;
  if (ours) {
    if (at < 0) {
      next = channelRow(wantedIm, home); // 少了通道那行，补上
    } else if (currentIm && currentIm !== wantedIm) {
      next = channelRow(wantedIm, home);
      switchedFrom = currentName;
    }
  }

  if (!missing.length && !next) return { added: [] };

  // 只追加缺的那几行；`root` 原样带着走，**别的键一个都不许丢**
  if (missing.length) {
    (shape.plugins as { id: string }[]).push(...abilityRows(home).filter((r) => missing.includes(r.id)));
  }
  if (next) {
    // **原位**换：不重排，别的行一个都不动
    if (at >= 0) rows[at] = next;
    else rows.push(next);
  }
  writeFileSync(configPath, `${JSON.stringify(shape.root, null, 2)}\n`, { mode: 0o600 });
  return { added: missing, ...(switchedFrom ? { switchedFrom } : {}) };
}

/**
 * 把家安好。**幂等**：跑第二次什么都不写。
 *
 * 只写缺的文件 —— 尤其是配置：用户可能已经在里面加了设备、改了目录，
 * 一次"初始化"把它抹掉是不可接受的。
 */
export function initButlerHome(opts: InitOptions = {}): InitResult {
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  // **家 = 配置文件住的地方。** 所以 `--config /某处/config.json` 意味着
  // 补丁和 dsh-home 也在 /某处/ 下 —— 否则用户把家搬到别处之后，
  // 补丁会悄悄落回 ~/.butler，而配置里写着的是另一个路径，两边对不上。
  const home = dirname(configPath);
  const patchFile = opts.patchFile ?? join(home, 'dsh.patch.yml');
  const dshHome = opts.dshHome ?? join(home, 'dsh-home');
  const written: string[] = [];
  const kept: string[] = [];

  // 只建**真要写东西的那两个目录**，不建别的。
  // 0700：这个目录里会有密钥（node.json）和谁能遥控这台电脑的名册（peers.json）
  for (const dir of new Set([dirname(configPath), dirname(patchFile)])) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const put = (file: string, text: string): void => {
    if (existsSync(file) && !opts.force) {
      kept.push(file);
      return;
    }
    writeFileSync(file, text, { mode: 0o600 });
    written.push(file);
  };

  const existed = existsSync(configPath);
  // `--im` 没给 = **保持这一台现在的样子**。用户把 init 重跑一遍（升级、补行、改链路）
  // 不该被悄悄切回微信 —— 而"他现在用的是哪个"只有配置自己知道。
  const wantedIm = opts.im ?? channelImOf(configPath) ?? 'wechat';
  put(configPath, defaultConfigText({ ...opts, im: wantedIm, home, patchFile, dshHome }));

  // 文件早就在的老用户：把新版本多出来的能力行**补上**，顺手把 `--im` 要的那一行换过去。
  //
  // 没有这一步，`init` 只认"文件在不在" —— 文件早就在了，于是新能力永远补不上，
  // 用户被卡在一个"少了半台管家"的旧配置里，还得自己打开一份 JSON 去改。
  // 完全不懂技术的人就卡死在这里。
  const topUp = existed && !opts.force
    ? topUpRows(configPath, home, wantedIm)
    : { added: [] as string[], ...({} as { switchedFrom?: string; skipReason?: string }) };

  // 节点那台不需要补丁：它不跑 agent 的对话，只是把 agent 摊给中枢用。
  // 但**给它也没坏处**，而且用户以后可能把这台改成中枢 —— 所以照写。
  put(patchFile, patchTemplate());

  return {
    configPath, im: wantedIm, written, kept,
    added: topUp.added,
    ...(topUp.switchedFrom ? { switchedFrom: topUp.switchedFrom } : {}),
    ...(topUp.skipReason ? { topUpSkipped: topUp.skipReason } : {}),
  };
}
