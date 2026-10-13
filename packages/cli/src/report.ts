/**
 * `butler report` —— 出事了，把这一份发给帮你的人就行。
 *
 * 为什么要有它：管家不吭声的时候，用户手里**什么都没有**。他不知道该抄哪一段，
 * 更不知道抄出来的东西里有没有自己的 key —— 于是"求助"这件事就卡在
 * "你能不能把终端里的东西发我看看"上。对一个完全不懂技术的人，这一步就是终点。
 *
 * 两条铁律：
 *
 *   ① **只读。** 除了它自己生成的那一份报告，不改机器上任何东西。
 *   ② **不含任何 key / token / 密钥。** 源头先把"名字看着像密钥"的值标掉，
 *      最后**再拿一个扫描器把整份文本过一遍**（单一出口）—— 两道，不是一道。
 *      隐去的地方会**明说隐去了**，不装作没这回事：装作没有，比漏掉更危险。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, release, type } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { autostartLogFile } from './autostart.js';
import { doctor, formatDoctor } from './doctor.js';

export interface ReportOptions {
  /** `~` 的替代（测试用） */
  home?: string;
  configPath?: string;
  patches?: string[];
  /**
   * 自检那一段。默认真跑 `butler doctor`（它会起容器、看插件能不能装上）。
   * 测试里换掉 —— 不然"生成报告"会变成一件重活。
   */
  selfCheck?: () => Promise<string>;
  /** 日志尾巴留多少行（默认 40） */
  tailLines?: number;
  now?: () => Date;
}

/** 一份报告有多大：太长帮助不大，太短看不出来 */
const PATCH_LINES = 120;

export async function collectReport(opts: ReportOptions = {}): Promise<string> {
  const home = opts.home ?? homedir();
  const configPath = opts.configPath ?? join(home, '.butler', 'config.json');
  // ⚠️ 管家目录 = **配置所在目录** —— 和 `cli.ts` 里 `butlerDir: dirname(args.config)` 是同一条规则。
  //    用 `--config` 把家安在别处的人，报告必须说**那个**家。以前这里写死 `~/.butler`，
  //    于是报告自己跟自己打架：①段在数 `~/.butler` 里的文件，④段的 doctor 读的却是 `--config` 那份。
  const butler = dirname(configPath);
  const at = (opts.now ?? (() => new Date()))();
  const lines: string[] = [];
  const put = (s = ''): void => { lines.push(s); };

  put('管家体检报告');
  put('（把整个文件发给帮你的人就行 —— 里面**没有**你的任何 key）');
  put(`生成时间：${stamp(at)}`);
  put(`butler ${version()}`);
  put(`node ${process.version}`);
  put(`${type()} ${release()} ${process.arch}`);
  put(`管家目录：${butler}`);

  put('\n────────── ① 有哪些文件 ──────────');
  const known: [string, string][] = [
    ['配置', 'config.json'],
    ['补丁', 'dsh.patch.yml'],
    ['链接密钥', 'state/token.json'],
    ['审批待办', 'state/approvals/pending'],
    ['审批账本', 'state/approvals/approvals.jsonl'],
    ['模型 key（只登记存在，**不读内容**）', 'dsh-home/.credentials.yaml'],
    ['通道凭据（只登记存在，**不读内容**）', 'state/secrets.json'],
    ['记忆', 'state/memory.json'],
  ];
  for (const [what, rel] of known) {
    const p = join(butler, rel);
    put(`  ${what}：${describeFile(p)}`);
  }
  // 日志这一条**不跟着管家目录走**：自启动永远写在 `~/.butler/logs`（见 `autostart.ts` 的
  // `autostartLogFile`）。如实说，而不是顺手拼到 `butler` 后面 —— 那样会指一个不存在的文件。
  put(`  自启动日志：${describeFile(autostartLogFile(home))}（这一条不跟着 --config 走）`);

  put('\n────────── ② 配置里有哪些行 ──────────');
  configSection(configPath, put);

  put('\n────────── ③ 补丁（密钥已隐去）──────────');
  const patchFile = opts.patches?.[0] ?? join(butler, 'dsh.patch.yml');
  if (!existsSync(patchFile)) {
    put(`  没有这份补丁：${patchFile}`);
  } else {
    const text = readFileSync(patchFile, 'utf8').split('\n').slice(0, PATCH_LINES).join('\n');
    put(text.trimEnd());
    const total = readFileSync(patchFile, 'utf8').split('\n').length;
    if (total > PATCH_LINES) put(`  …（还有 ${total - PATCH_LINES} 行，太长了没抄）`);
  }

  put('\n────────── ④ 自检说什么（butler doctor）──────────');
  try {
    const selfCheck = opts.selfCheck ?? (async () => formatDoctor(await doctor({ configPath, patches: opts.patches ?? [] })));
    put((await selfCheck()).trimEnd());
  } catch (error) {
    put(`  自检这一步没能跑完：${error instanceof Error ? error.message : String(error)}`);
    put('  （这本身就是要给帮你的人看的信息，别删）');
  }

  put('\n────────── ⑤ 最近的日志尾巴 ──────────');
  const logFile = autostartLogFile(home);  // 同上：日志不跟着 --config 走
  if (!existsSync(logFile)) {
    put('  没有日志文件（没用过自启动，或者刚装上）。');
  } else {
    const all = readFileSync(logFile, 'utf8').split('\n');
    const tail = all.slice(-(opts.tailLines ?? 40));
    put(tail.join('\n').trimEnd());
    if (all.length > (opts.tailLines ?? 40)) put(`  …（前面还有 ${all.length - (opts.tailLines ?? 40)} 行）`);
  }

  put('\n────────── ⑥ 这一份里没有什么 ──────────');
  put('  · 没有你的模型 key、通道 token、链接密钥 —— 它们只会以「已隐去」出现');
  put('  · 没有你和管家的对话内容');
  put('  · 隐去是**按形状**扫的：路径里那些又长又随机的串也会被隐去 —— 读起来断了一截是正常的，不是坏了');
  put('  · 生成这份报告**只读**：除了它自己，没改你机器上的任何东西');

  // 单一出口：整份文本最后过一遍扫描器。两道防线，不是一道。
  return `${redact(lines.join('\n'))}\n`;
}

function configSection(configPath: string, put: (s?: string) => void): void {
  if (!existsSync(configPath)) { put(`  没有这份配置：${configPath}`); return; }
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    put('  这份配置读不出来（不是合法的 JSON）—— 这件事本身要告诉帮你的人');
    return;
  }
  const plugins = (doc as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) { put('  配置里没有 plugins 这一段。'); return; }
  for (const raw of plugins as Record<string, unknown>[]) {
    put(`  · id=${show(raw.id)}  name=${show(raw.name)}${raw.disabled ? '  ←这一行被关了' : ''}`);
    const cfg = raw.config;
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
        put(`      ${k}: ${showValue(k, v)}`);
      }
    }
  }
}

/** 名字看着像密钥的，值就不抄 —— 这是第一道防线 */
const SECRET_KEY = /token|secret|pass|key|credential|code/i;

function showValue(key: string, value: unknown): string {
  if (SECRET_KEY.test(key)) return '（已隐去）';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return truncate(s ?? String(value), 160);
}

/**
 * 第二道防线：把整份文本过一遍。
 *
 * 宁可多隐一点 —— 少抄一段话，帮助有限；漏一串 key，是事故。
 */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-（已隐去）')
    .replace(/(bearer\s+)[^\s"',]{6,}/gi, '$1（已隐去）')
    .replace(
      /((?:token|secret|password|api[_-]?key|apikey|credential)s?"?\s*[:=]\s*"?)([^\s"',]{4,})/gi,
      '$1（已隐去）',
    )
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '（长串已隐去）')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '（长串已隐去）');
}

function describeFile(p: string): string {
  if (!existsSync(p)) return '没有';
  const st = statSync(p);
  const kind = st.isDirectory() ? '目录' : `${st.size} 字节`;
  return `有（${kind}，权限 ${(st.mode & 0o777).toString(8)}）`;
}

export function reportFilePath(opts: { home?: string; now?: Date } = {}): string {
  const home = opts.home ?? homedir();
  const d = opts.now ?? new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const name = `report-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
  return join(home, '.butler', name);
}

/** 写到哪儿、权限多少：跟凭据一个待遇（0600）—— 它虽然脱过敏，也不是给全机看的 */
export function writeReport(text: string, opts: { home?: string; out?: string; now?: Date } = {}): string {
  const file = opts.out ?? reportFilePath(opts);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function version(): string {
  try {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '未知';
  }
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));
const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…（后面还有）` : s);
