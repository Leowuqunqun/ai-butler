/**
 * 自检 —— 让主人**在微信里**就能问一句"你还活着吗"。
 *
 * ── 为什么这件事必须在对话里 ────────────────────────────────────
 *
 * `butler doctor` 早就能查这些，它问的就是同一个 `check()`。但那要开终端、
 * 要会抄命令 —— 而**恰恰是出事的时候**，一个不懂技术的主人是没有终端可用的，
 * 他手上只有微信。"发了消息没反应"这种时候，他能做的第一件事应该是：
 * 回一句「自检」，然后照着回话里写的那样去改。
 *
 * ── 一条不许变的规矩：**不许报假的绿** ──────────────────────────
 *
 * 这一层最容易犯的错，是把"没查成"当成"没问题"：某个插件抛了异常，
 * 就悄悄跳过它 —— 报告会因此**看起来更干净**。可主人正是拿这份报告判断
 * "要不要找人帮忙"。所以：
 *
 *   · `check()` 抛了        → 显成**没过**（原文照抄给他，那是插件的 bug）
 *   · 返回的不是一份清单    → 显成**没测出来**，也算没过
 *   · 压根没有 `check()`    → 如实写"这位没上来"，不假装查过
 *
 * ── 为什么不承诺"这段可以安全转发" ──────────────────────────────
 *
 * `detail` 是**各插件自己写的**，内核管不了它写了什么。今天这几个实现都只写
 * 路径和程序名，但明天装上一个新插件就可能不是了。所以这里只说"要找人帮忙
 * 就整段发给他"，**绝不**替别人承诺这段里没有敏感东西。
 *
 * @module @butler/core/selfcheck
 */

import type { HealthCheck } from '@butler/seam-channel';

/** 一个可以被问自检的能力位（或者内核自己） */
export interface Checkable {
  /** 给人看的短名字。报告里每条前面挂它，也是"在岗"那行的名字 */
  label: string;
  /**
   * 服务实例。**故意是 `unknown`**：有没有 `check()` 得运行时才知道 ——
   * 它是 seam 上的**可选**成员，而且 `ctx.memory` / `ctx.approval` 这两层
   * 压根没声明它。写成具体类型只会逼着调用处去骗编译器。
   */
  instance?: unknown;
  /** 这一位没上岗会怎样 —— 不写的话主人不知道要不要管它 */
  missing?: string;
}

/** 一条检查结果。`where` 是它属于哪一位 */
export interface SelfCheckItem extends HealthCheck {
  where: string;
}

/** 一位能力位在不在岗 */
export interface OnDuty {
  label: string;
  present: boolean;
  missing?: string;
}

export interface SelfCheckReport {
  items: SelfCheckItem[];
  onDuty: OnDuty[];
}

/** seam 上的那个可选成员 —— 有、而且是个函数，才问它 */
type CheckLike = { check?: () => unknown };

function checkOf(instance: unknown): (() => unknown) | undefined {
  const c = (instance as CheckLike | null | undefined)?.check;
  return typeof c === 'function' ? c : undefined;
}

/** 「没测出来」这一类失败的兜底话术。它的意思很准确：我们不知道它是好是坏 */
const UNKNOWN_FIX = '这是这一层自己的毛病，不是你的操作问题 —— 把原文照抄给我';

/**
 * 问每一位自己要自检。**同步抛、异步抛、返回垃圾都收得住** ——
 * 收不住的话，一个坏插件就能让主人什么都看不到。
 */
async function askOne(target: Checkable): Promise<SelfCheckItem[]> {
  const check = checkOf(target.instance);
  if (!check) return [];
  try {
    const got = await check.call(target.instance);   // 有些实现要用自己的 config，得留住 this
    if (!Array.isArray(got)) {
      return [{
        where: target.label,
        name: '自检没测出来',
        ok: false,
        detail: `这一层的自检返回的不是一份检查清单（拿到的是 ${typeof got}）`,
        fix: UNKNOWN_FIX,
      }];
    }
    return got.map((c) => ({ ...(c as HealthCheck), where: target.label }));
  } catch (error) {
    return [{
      where: target.label,
      name: '自检本身出错了',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: UNKNOWN_FIX,
    }];
  }
}

/** 把这一圈能力位挨个问一遍。顺序就是传进来的顺序（报告每次都长一样） */
export async function collectSelfCheck(targets: readonly Checkable[]): Promise<SelfCheckReport> {
  const items: SelfCheckItem[] = [];
  const onDuty: OnDuty[] = [];
  for (const t of targets) {
    onDuty.push({ label: t.label, present: !!t.instance, ...(t.missing ? { missing: t.missing } : {}) });
    items.push(...(await askOne(t)));
  }
  return { items, onDuty };
}

/**
 * 结论必须是**一个动作**，不是一句状态 ——
 * "有 2 项没过，照下面写的改"比"自检未通过"有用得多。
 *
 * `total === 0` 是第三种情况，而且必须单独说：**一项都没查**跟"都正常"
 * 是两回事。把前者说成后者，正是这份报告最坏的一种错法。
 */
export function selfCheckVerdict(bad: number, total: number): string {
  if (total === 0) return '什么都没查到 —— 这一圈没有任何一层提供自检，所以这份报告**说明不了"没问题"**。';
  if (bad === 0) return '都正常 —— 能收能答。';
  return `有 ${bad} 项没过 —— 照下面写的那样改，改完再回一次「自检」。`;
}

/** 主人看的这份。**只有没过的那几条带"怎么办"**，免得报告长到没人看 */
export function formatSelfCheck(report: SelfCheckReport): string {
  const bad = report.items.filter((i) => !i.ok);
  const lines: string[] = ['AI 管家自检', '', selfCheckVerdict(bad.length, report.items.length), ''];

  for (const i of report.items) {
    lines.push(`  ${i.ok ? '✓' : '✗'} ${i.where} · ${i.name}${i.detail ? `：${i.detail}` : ''}`);
    if (!i.ok && i.fix) lines.push(`     → ${i.fix}`);
  }

  lines.push('', '【在岗】');
  lines.push(`  ${report.onDuty.map((d) => `${d.label} ${d.present ? '✓' : '✗'}`).join('　')}`);
  for (const d of report.onDuty) {
    if (!d.present && d.missing) lines.push(`  ${d.label} ✗ —— ${d.missing}`);
  }

  lines.push('', '要找人帮忙的话，把这一整段发给他。');
  return lines.join('\n');
}

/** 整个自检自己挂了 —— 也必须说成话。**这种情况下绝不说"都正常"** */
export function formatSelfCheckBroke(why: string): string {
  return [
    '我这份自检没跑起来：',
    why,
    '',
    '所以**现在什么结论都不能给你** —— 别把它当成"没问题"。',
    '把上面那句原文发给我，我看一眼。',
  ].join('\n');
}
