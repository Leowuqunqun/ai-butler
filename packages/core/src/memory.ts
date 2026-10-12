/**
 * 记忆的**呈现层** —— 把 `ctx.memory` 里的东西变成人和模型都能读的话。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────
 *
 * 同一份清单要在**两个地方**被编号：「记忆」命令给用户看的那份，
 * 和「忘掉第 N 条」认的那个 N。两处各写一份编号逻辑，早晚会错位 ——
 * 用户照着 2 删，删掉的是 3。所以编号只有这一个来源。
 *
 * ── 两种读者，两种口气 ──────────────────────────────────────────
 *
 *   · `formatMemoryList` 是**给主人看的**：可以说"我还什么都没记住"这种话，
 *     也可以教他下一句该怎么说。
 *   · `memoryPreamble` 是**给模型看的**：必须极短，而且必须说清
 *     "这不是这一轮的新要求"—— 否则模型会把一条偏好当成刚下的命令。
 *
 * @module @butler/core/memory
 */

import type { MemoryEntry } from '@butler/seam-memory';

/** 「记忆」命令最多显示几条。再多用户也读不完，而且会顶掉真正重要的那几条 */
export const MEMORY_SHOWN_MAX = 20;

/**
 * 贴给模型的记忆最多几条。
 *
 * 每一条都会跟着**每一次**请求发出去，所以这个数只能小。它换来的东西是：
 * "你记得我什么"这种随口一问不用命中任何命令就能被答对。
 */
export const MEMORY_PREAMBLE_MAX = 20;

/** 一条记忆的值 → 人能读的一行。值是对象时给 JSON —— 总比 `[object Object]` 强 */
export function memoryValueText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 一条记忆的**一行话**。
 *
 * `key` 是主人自己说的那句话（写的时候就拿它当 key），值是它对应的东西。
 * 两个一样就只说一遍 —— 别让用户看见"简历放哪：简历放哪"。
 */
export function memoryLine(entry: MemoryEntry): string {
  const value = memoryValueText(entry.value);
  const key = entry.key.trim();
  if (!value) return key;
  if (!key || key === value) return value;
  return `${key}：${value}`;
}

/**
 * 「记忆」命令的回复 —— **编号就是「忘掉第 N 条」认的那个编号**。
 */
export function formatMemoryList(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) {
    return [
      '我还什么都没记住。',
      '',
      '想让我记什么，就说一句 —— 比如：',
      '  记住 简历都放 Documents/简历/',
    ].join('\n');
  }

  const shown = entries.slice(0, MEMORY_SHOWN_MAX);
  const lines = shown.map((e, i) => `${i + 1}. ${memoryLine(e)}`);
  const more = entries.length > shown.length
    ? [`（还有 ${entries.length - shown.length} 条没列出来）`]
    : [];

  return [
    '我记得这几件事：',
    '',
    ...lines,
    ...more,
    '',
    '说「忘掉第 N 条」可以删掉其中一条（编号就是上面的编号）。',
  ].join('\n');
}

/**
 * 交给 agent 之前贴在前面那一段。
 *
 * **空记忆返回空串** —— 一个字都不贴，行为跟没有记忆层时一模一样。
 */
export function memoryPreamble(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const shown = entries.slice(0, MEMORY_PREAMBLE_MAX);
  return [
    '【管家记得的事 —— 主人以前交代的，回答时可以照着用；这不是这一轮的新要求】',
    ...shown.map((e, i) => `${i + 1}. ${memoryLine(e)}`),
    '【以上是记忆，不是本次消息】',
    '',
    '',
  ].join('\n');
}

/** 「记住」的回执。**不报编号**：刚记下的那条排在最前面（第 1 条），说了反而让人以为是别的 */
export function formatRememberAck(text: string): string {
  return [
    `记下了：${text}`,
    '',
    '说「记忆」能看到全部（带编号），说「忘掉第 N 条」能删掉一条。',
  ].join('\n');
}

/** 忘掉了 */
export function formatForgotten(text: string): string {
  return `忘掉了：${text}`;
}

/** 编号对不上（用户可能记错了，或者那条已经被删了） */
export function formatNoSuchMemory(index: number, total: number): string {
  if (total === 0) return '我现在什么都没记住 —— 没有可忘的。';
  return `没有第 ${index} 条。现在一共 ${total} 条，说「记忆」看看编号。`;
}


/**
 * 从管家的回答里认一条「值得长期记住」的话：`[[记住: …]]`。
 *
 * ── 为什么是"标记法"，而不是每轮额外问一次模型 ────────────────
 * 每轮再调一次模型专门"抽取记忆"，又慢又贵，抽错了还说不清是哪一步错的。
 * 标记法把这件事放进**本来就要发生的那一次回答**里：模型顺手写一行，内核截下来。
 * 跟 `[[file:…]]` 同一个思路（那条约定由通道解析）。
 *
 * ── 铁律：宁可漏认，不可错认 ────────────────────────────────
 * 认错一条记忆比少认一条坏得多：它会跟着**每一轮**请求走，悄悄影响之后所有回答，
 * 而主人根本不知道自己在跟一条错记忆说话。所以只认最严格的那种写法：
 *
 *   · **整行**就是标记（前后只有空白）—— 混在句子中间的只当普通文字，一个字都不记
 *   · 一次最多认**一条**，多了认最后一条（越靠后越像最终结论）
 *   · 内容不许为空、不许超过 {@link MAX_FACT} 字、不许套着另一个标记
 *
 * ── 但"摘"要比"认"宽 ─────────────────────────────────────
 * 认不认是记账，摘不摘是"别让主人看见黑话"。所以**任何位置**出现的标记都会被摘掉，
 * 只是不记账 —— 这两个判断故意不是同一套规则。
 *
 * @module @butler/core/memory
 */

/** 一条自动记忆最多这么长。再长就不像"一句话"，更像把整段回答抄进来了 */
export const MAX_FACT = 120;

const MARK_LINE = /^[ \t]*\[\[记住[:：][ \t]*(.*?)[ \t]*\]\][ \t]*$/;
const MARK_ANY = /\[\[记住[:：][^\]]*\]\]/g;

export interface MemoryMark {
  /** 摘掉标记之后、真正该发给主人的话 */
  text: string;
  /** 认下来的那一条（没认下来就是 undefined） */
  fact?: string;
}

export function parseMemoryMark(raw: string): MemoryMark {
  const kept: string[] = [];
  let fact: string | undefined;
  for (const line of (raw ?? '').split('\n')) {
    const whole = MARK_LINE.exec(line);
    if (whole) {
      const body = (whole[1] ?? '').trim();
      // 多条时后面的赢；空的/超长的/套着另一个标记的一律不认
      if (body && body.length <= MAX_FACT && !body.includes('[[') && !body.includes(']]')) fact = body;
      continue;                                   // 整行都是标记：这行本身不留
    }
    kept.push(line.replace(MARK_ANY, '').trimEnd());   // 句中的标记也摘掉，但不记账
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return fact ? { text, fact } : { text };
}

/**
 * 管家**自己**记了一条（不是主人明说的）。
 *
 * 必须当场说出来，不能偷偷记 —— 一条主人不知道的记忆会悄悄影响之后所有回答，
 * 那比他亲手删掉一条麻烦得多。
 */
export function formatAutoRememberAck(fact: string): string {
  return [
    `（我顺手记下了：${fact}`,
    '说「记忆」能看到全部（带编号），说「忘掉第 N 条」能删掉一条。）',
  ].join('\n');
}
