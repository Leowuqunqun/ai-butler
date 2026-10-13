/**
 * `butler doctor` —— 出问题的时候，**替用户把他自己查不出来的事查出来**。
 *
 * ── 为什么它值得单独做一个 ────────────────────────────────────
 *
 * 这个产品最坏的用户体验不是报错，是**没反应**。"我发了消息，它不理我" ——
 * 用户没有任何线索，只能来问人。而这个场景的原因其实就那几种：
 * 没登录、没配模型、那个程序没装、目录不存在、**换了个微信号说话（没认主）**。
 *
 * 所以 doctor 的目标不是"打印诊断信息"，是**直接告诉他该干什么**。
 * 每一条没过的检查都带一句 `fix`，那句话决定了他能不能自己解决。
 *
 * ── 它建在什么上 ─────────────────────────────────────────────
 *
 * 建在 `boot()` 上（那一个函数已经把"装了什么、哪行没装上"如实汇报了），
 * 再往每一层问它们自己的自检（seam 上的可选 `check()`）——
 * 只有实现自己知道该验什么，让 doctor 从外面猜是层次错误。
 *
 * ⚠️ **doctor 永远不抛错**。它的全部意义就是在一切都坏掉的时候还能说话。
 *
 * @module @butler/cli/doctor
 */

import type { Context } from '@deepseek-ai/cordis';
import type { HealthCheck } from '@butler/seam-channel';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { approvalsDir } from '@butler/approval-im';
import { boot, type BootFailure, type BootOptions } from './boot.js';
import type { PluginRow } from './config.js';
import { keyState, credentialsFileOf, keyRefOf } from './credentials.js';
import { unpluggedChannels, unpluggedHint, type UnpluggedChannel } from './secrets.js';
import { dshAgentHome } from './onboarding.js';

/** 一条检查，外加"是哪一层报的" */
export interface DoctorCheck extends HealthCheck {
  /** `'环境'` / `'配置'` / `'通道'` / `'大脑'` / `'内核'` …… 打出来分组用 */
  from: string;
}

export interface DoctorSlot {
  /** 服务位名字，如 `'channel'` */
  name: string;
  /** 它是干什么的（给用户看的，不是给开发者看的） */
  what: string;
  /** 在不在。**注意是取值判断**，不是 `in` —— 见 boot.ts 里那段注释 */
  present: boolean;
  /**
   * 可选能力位：没有它也照样跑（只管这一台电脑 / 每句话第一次见你），
   * 所以**不算"缺"** —— 但 doctor 要照实报它有没有，不然用户不知道该不该修。
   */
  optional?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  /** 实际读了哪些配置文件 */
  files: string[];
  loaded: PluginRow[];
  disabled: PluginRow[];
  failures: BootFailure[];
  slots: DoctorSlot[];
  /**
   * 盘上凭据齐了、配置里却没这一条通道的那些通道。
   *
   * 空数组是常态；有值就说明用户停在"探针存好了、但没接上"那一步（见 `unpluggedChannels`）。
   */
  unplugged: UnpluggedChannel[];
  /** 一句话结论。永远有值 —— 没结论的自检等于没做 */
  verdict: string;
}

/**
 * 这台机器的"脊梁"。少了任何一条，管家都跑不起来。
 *
 * `ctx.link` / `ctx.memory` **故意不在这里**：它们是可选的 —— 没有链路就只管
 * 这一台电脑，没有记忆就是每句话第一次见你，两种情况都能正常用。它们到底
 * 有没有，由下面「能力位」那一段照实报（`slots` 是装完之后的真实结果）。
 */
const SPINE: readonly { name: string; what: string; optional?: boolean }[] = [
  { name: 'channel', what: '收发消息的通道' },
  { name: 'agent', what: '干活的大脑' },
  { name: 'core', what: '把两头接起来的' },
];

/**
 * 可选能力位 —— 没有也能正常用，所以**不进 `missing`、不影响结论**，
 * 但列出来（用户才知道"我配了记忆，它到底装上没有"）。
 */
const OPTIONAL_SLOTS: readonly { name: string; what: string; optional?: boolean }[] = [
  { name: 'link', what: '够到别的电脑（没有就只管这一台）', optional: true },
  { name: 'memory', what: '记住你说过的事（没有就每句话第一次见你）', optional: true },
  { name: 'approval', what: '要动你电脑之前先问你（没有就一律不动）', optional: true },
];

/** 最低 Node 版本。跟 package.json 的 engines 保持一致 */
const MIN_NODE_MAJOR = 20;

export interface DoctorOptions extends BootOptions {
  /** 覆盖 Node 版本（测试用） */
  nodeVersion?: string;
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const slots: DoctorSlot[] = [];

  // ── ① 环境 ──────────────────────────────────────────────
  const v = options.nodeVersion ?? process.version;
  const major = Number(/^v(\d+)/.exec(v)?.[1] ?? 0);
  checks.push({
    from: '环境',
    name: 'Node 版本',
    ok: major >= MIN_NODE_MAJOR,
    detail: `${v}（需要 ${MIN_NODE_MAJOR} 以上）`,
    fix: major >= MIN_NODE_MAJOR ? undefined : `升级 Node 到 ${MIN_NODE_MAJOR} 以上再试`,
  });

  // ── ② 装载（这一步顺带把配置也读了）──────────────────────
  let loaded: PluginRow[] = [];
  let disabled: PluginRow[] = [];
  let failures: BootFailure[] = [];
  let files: string[] = [];
  let unplugged: UnpluggedChannel[] = [];
  let ctx: Context | null = null;

  try {
    const b = await boot(options);
    loaded = b.loaded;
    disabled = b.disabled;
    failures = b.failures;
    files = b.config.files;
    ctx = b.ctx;

    // 「凭据存好了、配置里却没这条通道」—— 验收路上最容易走进的死胡同。
    // 关掉的行也算"配置里有它"（用户是主动关的，不该再催他 init）。
    unplugged = unpluggedChannels({
      butlerDir: dirname(options.configPath),
      rows: [...b.config.rows, ...b.config.disabled],
    });

    for (const slot of [...SPINE, ...OPTIONAL_SLOTS]) {
      slots.push({
        name: slot.name,
        what: slot.what,
        present: b.has(slot.name),
        ...(slot.optional ? { optional: true } : {}),
      });
    }

    // ── ③ 问每一层自己的自检 ─────────────────────────────
    for (const slot of SPINE) {
      const instance = getSlot(ctx, slot.name) as { check?: () => unknown } | undefined;
      if (!instance?.check) continue;
      checks.push(...(await runCheck(slot.name, instance)));
    }
  } catch (error) {
    // 配置都读不了 —— 那更要说清楚，因为后面全都做不了了
    checks.push({
      from: '配置',
      name: '读配置',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: !options.configPath || existsSync(options.configPath)
        ? '先把这份配置文件修好；`butler run --config <别的文件>` 可以换一份试试'
        : // ⚠️ 文件**根本不存在**时，说"去修好它"等于让人修一份没有的东西。
          //    实测踩到过：安装包刚装完、README 让跑 doctor，出来就是这么一句。
          '还没有配置过。收微信那台跑 `butler init`；被遥控那台跑 `butler init --node`'
          + '（它会把配置写好，你什么都不用填）',
    });
  } finally {
    // 自检是只读的，跑完就把容器卸掉，不留半截状态
    if (ctx) await ctx.fiber.dispose();
  }

  // 文件名本身也是一条有用的信息："它到底看的是哪个文件"
  if (files.length) {
    checks.push({
      from: '配置',
      name: '实际读的文件',
      ok: true,
      detail: files.join('  →  '),
    });
  }

  // ── ⑤ 模型 key：管家靠它思考（只有跑 DSH 的 agent 需要）──
  const dsh = dshAgentHome(loaded);
  if (dsh) {
    const ref = keyRefOf(existsSync(dsh.patchFile) ? readFileSync(dsh.patchFile, 'utf8') : '');
    const file = credentialsFileOf(dsh.home);
    const state = keyState(file, ref, process.env);
    checks.push({
      from: '大脑',
      name: '模型 key',
      ok: state !== 'missing',
      // 只给用户看的东西：别把 `.credentials.yaml` 这种内部名字摆到他面前
      detail: state === 'missing'
        ? '还没有 —— 管家要靠它思考'
        : state === 'env' ? `来自启动环境里的 ${ref}` : '已配置',
      fix: state === 'missing'
        ? '跑一次 butler run —— 它会自动打开一个页面让你把 key 贴进去，不用手写文件'
        : 'key 过期了、或者想换一把：跑 butler run --again（会再问你一次，不用找文件）',
    });
  }

  // ── ⑥ 审批那根线：子进程会问吗？问了有人接吗？────────────────
  //    这是**隔着两个进程的一根线**，离线测不到（真跑一次 dsh 才知道），
  //    所以放到这里来查 —— 用户机器上跑一次 doctor 就能确认。
  if (dsh) checks.push(...approvalChecks(dsh.patchFile, loaded, options.configPath ? dirname(options.configPath) : ''));

  const bad = checks.filter((c) => !c.ok);
  // 可选能力位缺了不算"缺" —— 只有脊梁缺了才是真的跑不起来
  const missing = slots.filter((s) => !s.present && !s.optional);
  const ok = bad.length === 0 && missing.length === 0 && failures.length === 0;

  return {
    ok, checks, files, loaded, disabled, failures, slots, unplugged,
    verdict: verdictOf(bad, missing, failures),
  };
}

/**
 * 审批那根线。三件事必须同时成立，管家才真的"问得出来"：
 *
 *   ① 子进程那一侧**会问**（补丁里 `policy: ask`）；
 *   ② 问出来**有人接**（补丁里那行应答者指向一个真的存在的文件）；
 *   ③ 管家这一侧**看得见**（配置里有审批那行）而且**落得下盘**（目录可写）。
 *
 * 任何一条不成立，结局都是**安全但没用**：dsh 那边 fail-closed，敏感操作
 * 一律被拒绝 —— 所以每条 fix 都得把"会一律拒绝"这层后果说清楚。
 */
function approvalChecks(
  patchFile: string,
  rows: readonly PluginRow[],
  fallbackHome: string,
): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  let text = '';
  try {
    text = readFileSync(patchFile, 'utf8');
  } catch {
    // 读不到补丁本身已经有专门那一条在报（"dsh patch 文件"），这里只顺着说一句
  }

  const parsed = text ? patchRows(text) : [];
  const policy = parsed.find((r) => r.id === 'approval');
  const answerer = parsed.find((r) => r.id === 'approval-answerer');
  const ask = policy ? /policy[ \t]*:[ \t]*["']?ask["']?/.test(policy.body) : false;

  if (!text) {
    out.push({
      from: '安全', name: '审批那根线', ok: false,
      detail: '补丁文件读不到，没法确认它会不会问',
      fix: '先修上面"dsh patch 文件"那一条',
    });
  } else if (!ask) {
    out.push({
      from: '安全', name: '审批那根线', ok: false,
      detail: !policy
        ? '补丁里没有审批那一行'
        : policy.body.includes('policy') ? '补丁里写的是"一律拒绝"' : '补丁里没说要不要问（没写 policy: ask）',
      fix: '跑一次 butler init 就会把它补上（没补上之前，敏感操作会被直接拒绝）',
    });
  } else if (!answerer?.name) {
    out.push({
      from: '安全', name: '审批那根线', ok: false,
      detail: '会问，但补丁里没有"谁来接"那一行 —— 问了没人接，到点还是不许',
      fix: '跑一次 butler init 就会把它补上',
    });
  } else if (!isAbsolute(answerer.name) || !existsSync(answerer.name)) {
    out.push({
      from: '安全', name: '审批那根线', ok: false,
      detail: `会问，但接的人不在：${answerer.name}`,
      fix: '多半是装了新版本、或者把目录搬过地方。重跑一次安装器（或 butler init）让它重新指过去',
    });
  } else {
    out.push({ from: '安全', name: '审批那根线', ok: true, detail: '会问，也接得住' });
  }

  // 管家这一侧：问了得有人看见，而且落得下盘
  const row = rows.find((r) => r.id === 'approval');
  if (!row) {
    out.push({
      from: '安全', name: '审批这一侧', ok: false,
      detail: '子进程会问，但管家这边没有审批那一行 —— 问了没人看见，到点一样不许',
      fix: '跑一次 butler init 就会把缺的那行补上',
    });
    return out;
  }

  const dir = approvalsDir({
    home: str(row.config?.['home']) || fallbackHome,
    dir: str(row.config?.['dir']),
  });
  out.push(approvalDirCheck(dir));
  return out;
}

/**
 * 审批要落盘才作数。写不进去 = 问题记不下来 = dsh 那边 `unavailable`
 * = **一律按不许处理**：安全，但用户会发现"管家什么也不肯干"。
 */
function approvalDirCheck(dir: string): DoctorCheck {
  const fail = (detail: string): DoctorCheck => ({
    from: '安全', name: '审批落盘', ok: false, detail,
    fix: '写不进去的时候，审批会一律按"不许"处理（安全，但敏感操作全干不了）。把这个目录腾出来，或者改那一行的 dir',
  });

  if (existsSync(dir)) {
    try {
      if (!statSync(dir).isDirectory()) throw new Error('是个文件');
      accessSync(dir, constants.W_OK);
      return { from: '安全', name: '审批落盘', ok: true, detail: '可以写' };
    } catch (error) {
      return fail(`${dir} 用不了（${error instanceof Error ? error.message : '不可写'}）`);
    }
  }

  // 还没建：**往上找到第一个真存在的东西** —— 它必须是个目录而且可写。
  // （只看"父目录可写"是不够的：路上挡着一个文件的时候父目录也可写，
  //   但 mkdir 会 ENOTDIR。实测踩过这一下。）
  let up = dirname(dir);
  while (up !== dirname(up) && !existsSync(up)) up = dirname(up);
  try {
    if (!statSync(up).isDirectory()) throw new Error('是个文件');
    accessSync(up, constants.W_OK);
  } catch (error) {
    return fail(`${up} 挡着，建不出 ${dir}（${error instanceof Error ? error.message : '过不去'}）`);
  }
  return {
    from: '安全', name: '审批落盘', ok: true,
    detail: `还没有，第一次用到时自己建（${up} 可以写）`,
  };
}

/**
 * 把补丁文本切成一行行插件。
 *
 * 只认**顶格**的 `- id: …` —— 模板里注释掉的例子（`# - id: …`）不算，
 * 缩在别人块里的也不算。`name` 取这一块里的第一条。
 */
function patchRows(text: string): { id: string; name: string; body: string }[] {
  const out: { id: string; name: string; body: string }[] = [];
  let cur: { id: string; name: string; body: string } | null = null;
  for (const line of text.split('\n')) {
    const head = /^-{1,2}[ \t]*id[ \t]*:[ \t]*(\S+)[ \t]*$/.exec(line);
    if (head) {
      if (cur) out.push(cur);
      cur = { id: head[1]!, name: '', body: `${line}\n` };
      continue;
    }
    if (!cur) continue;
    cur.body += `${line}\n`;
    const nm = /^[ \t]+name[ \t]*:[ \t]*["']?(.+?)["']?[ \t]*$/.exec(line);
    if (!cur.name && nm?.[1]) cur.name = nm[1];
  }
  if (cur) out.push(cur);
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 结论必须是一个动作，不是一句状态。「有 2 项没过」比「自检未通过」有用得多 */
function verdictOf(bad: DoctorCheck[], missing: DoctorSlot[], failures: BootFailure[]): string {
  const parts: string[] = [];
  if (failures.length) parts.push(`${failures.length} 个插件没装上来`);
  if (missing.length) parts.push(`少了 ${missing.map((s) => s.name).join('、')}`);
  if (bad.length) parts.push(`${bad.length} 项自检没过`);

  if (!parts.length) return '一切正常。可以 `butler run` 了。';
  return `${parts.join('，')}。按下面标 ✗ 的那几条改，改完再跑一次 doctor。`;
}

/** 把实现抛出来的意外收成一条"没过"，别让整个自检挂掉 */
async function runCheck(from: string, instance: { check?: () => unknown }): Promise<DoctorCheck[]> {
  try {
    const got = await instance.check!();
    if (!Array.isArray(got)) return [];
    return got.map((c) => ({ ...(c as HealthCheck), from }));
  } catch (error) {
    return [{
      from,
      name: '自检本身出错了',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: '这是这个插件自己的问题，先把上面那句原文发出来',
    }];
  }
}

/** 服务位取值。类型上说一定在，运行时不一定 —— 所以这里如实返回 undefined */
function getSlot(ctx: Context, name: string): unknown {
  return (ctx as unknown as Record<string, unknown>)[name];
}

// ───────────────────────── 打印 ─────────────────────────

const TICK = '✓';
const CROSS = '✗';

export function formatDoctor(r: DoctorReport): string {
  const lines: string[] = ['', 'AI 管家自检'];

  const section = (title: string): void => { lines.push('', title); };

  // 自检按"是哪一层"分组，但保持首次出现的顺序
  const order: string[] = [];
  for (const c of r.checks) if (!order.includes(c.from)) order.push(c.from);

  section('环境');
  for (const c of r.checks.filter((c) => c.from === '环境')) lines.push(line(c));

  section('配置');
  for (const f of r.failures) {
    lines.push(`  ${CROSS}  ${f.id}  ${f.name}`);
    lines.push(`      ${f.message}`);
  }
  for (const c of r.checks.filter((c) => c.from === '配置')) lines.push(line(c));

  section('装载');
  for (const row of r.disabled) lines.push(`  ·  ${row.id}  ${row.name}（配置里关掉了）`);
  for (const row of r.loaded) lines.push(`  ${TICK}  ${row.id}  ${row.name}`);
  if (!r.loaded.length && !r.disabled.length) lines.push('  （配置里一行都没有）');
  for (const u of r.unplugged) lines.push(`  ⚠️  ${unpluggedHint(u)}`);

  section('能力位');
  for (const s of r.slots) {
    // 可选的那些缺了画 `·` 而不是 `✗`：`✗` 会让用户以为这台机器坏了
    const mark = s.present ? TICK : (s.optional ? '·' : CROSS);
    lines.push(`  ${mark}  ctx.${s.name}  ${s.what}`);
    if (!s.present) {
      lines.push(s.optional
        ? '      没有也能用，想让它在就把配置里那一行加上'
        : '      缺这个就跑不起来。看上面「装载」里哪一行没装上');
    }
  }

  const rest = order.filter((f) => f !== '环境' && f !== '配置');
  if (rest.length) {
    section('自检');
    for (const from of rest) {
      for (const c of r.checks.filter((x) => x.from === from)) lines.push(line(c));
    }
  }

  lines.push('', r.verdict, '');
  return lines.join('\n');
}

/** 一排检查项的第二列从第几列开始 */
const COL = 24;

function line(c: DoctorCheck): string {
  const out = [`  ${c.ok ? TICK : CROSS}  ${pad(c.name, COL)}${c.detail ?? ''}`];
  if (!c.ok && c.fix) out.push(`      → ${c.fix}`);
  return out.join('\n');
}

/**
 * 按**终端显示宽度**补齐，不是按字符数。
 *
 * ⚠️ `String.prototype.padEnd` 把汉字算 1 个字符，但终端里它占 2 列 ——
 * 直接用 padEnd，中文界面的表格一定是歪的。（这是实测调出来的，别改回去。）
 *
 * ⚠️ 最少留两格：名字**比这一列还宽**时（比如「管家自己找得到 butler 吗」
 * 正好 24 列），不留的话它会和后面的详情粘成一个词（`吗找得到：…`）。
 * 名字短的行一个字节都没变 —— 它们的空格本来就比两格多。
 */
function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(2, width - displayWidth(s)));
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    // CJK 及全角区段：两个终端列
    w += (c >= 0x1100 && (
      c <= 0x115f
      || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f)
      || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}
