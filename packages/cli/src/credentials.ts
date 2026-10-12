/**
 * 凭据：**一个引用名 → 一个密钥**，存在 DSH 认得的那份文件里。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────
 *
 * 「用户自备模型 key」这句话，对不懂技术的人来说曾经等于：
 * 打开 YAML、找到 `apiKeyEnv`、理解引用名是什么、再找到凭据文件、
 * 按它的格式写一行。**这一步他做不了**，而且做错了不会有人告诉他。
 *
 * 所以：**key 由程序问一次、写进去，用户永远看不到文件格式。**
 *
 * ── 它在哪、长什么样 ─────────────────────────────────────────────
 *
 * DSH 自己的 `dsh-credentials-local` 把它放在 `<DSH_HOME>/.credentials.yaml`，
 * 结构是（`version` 必填，`refs`/`records` 都可以没有）：
 *
 * ```yaml
 * version: 1
 * refs:
 *   DEEPSEEK_API_KEY: sk-…
 * records:            # 别的凭据形态，不关我们的事
 *   deepseek-official: { … }
 * ```
 *
 * 我们只做**一件事**：往 `refs` 里放一行（或者改一行）。
 * 别的一律**原样保留** —— 包括 `records`、注释、缩进风格。
 *
 * ⚠️ 这里没有 YAML 解析器，也不打算有。我们只认这一种文件、这一种结构，
 * 认不动的时候**报错并说清怎么办**，而不是猜着改坏它。
 *
 * @module @butler/cli/credentials
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 我们的补丁模板里钉的那个引用名（见 `@butler/agent-dsh` 的 `default.patch.yml`） */
export const DEFAULT_KEY_REF = 'DEEPSEEK_API_KEY';

/** 管家私有的凭据文件 —— 和 `defaultDshHome()` 是同一个假设 */
export function credentialsFileOf(dshHome: string): string {
  return join(dshHome, '.credentials.yaml');
}

/**
 * 补丁里那个 `apiKeyEnv` 写的是哪个引用名。
 *
 * 默认的模板钉的是 `DEEPSEEK_API_KEY`；但用户要是自己换了 provider，
 * 这里读到的就是他换的那个名字 —— 于是我们写进凭据库的也是那个名字。
 * 找的是**第一处** `apiKeyEnv:`（模板里模型通道就在最前面）。
 */
export function keyRefOf(patchText: string, fallback: string = DEFAULT_KEY_REF): string {
  const match = /^[ \t]*-?[ \t]*apiKeyEnv:[ \t]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?[ \t]*$/m.exec(patchText);
  return match?.[1] ?? fallback;
}

/** 这个 key 现在是什么状态 */
export type KeyState =
  /** 启动环境里就有 —— 按 DSH 的优先级它**赢**，别再去写文件（写了也不生效） */
  | 'env'
  /** 凭据文件里有 */
  | 'stored'
  /** 没有，得问用户要 */
  | 'missing';

export function keyState(file: string, ref: string, env: NodeJS.ProcessEnv = process.env): KeyState {
  if ((env[ref] ?? '') !== '') return 'env';
  if (!existsSync(file)) return 'missing';
  return refsOf(readText(file)).has(ref) ? 'stored' : 'missing';
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    // 读不动（权限/坏文件）就当没有 —— 后面写的时候会重新报错，不用在这儿猜
    return '';
  }
}

/**
 * 文件里**顶层** `refs` 段有哪些引用名。
 *
 * 只认这一种结构：顶层 `refs:` 起一段，段内每一行是 `名字: 值`。
 * 段里更深一层的东西（比如某个值是个映射）不算引用名。
 *
 * 另外认一种历史形态：**没有 `version`/`refs`、整份文件就是一层 `名字: 值`**
 * （DSH 早期版本这么存，它自己能就地升级）。那种情况下顶层每一行都是引用名。
 */
export function refsOf(text: string): Set<string> {
  const out = new Set<string>();
  const lines = text.split('\n');
  const hasVersion = lines.some((l) => /^version\s*:/.test(l));
  let inRefs = false;
  let blockIndent = -1;

  for (const raw of lines) {
    const body = raw.trim();
    if (body === '' || body.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;

    if (!inRefs) {
      if (indent !== 0) continue;
      const section = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(body);
      if (!section) continue;
      const [, name, rest] = section as unknown as [string, string, string];
      if (name === 'refs') {
        const inline = rest.trim();
        if (inline !== '' && inline !== '{}') {
          // 写成一行了（`refs: {A: 1}`）—— 认得出名字就行，改它的时候会另说
          for (const m of inline.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) out.add(m[1]!);
        } else {
          inRefs = true;
          blockIndent = -1;
        }
        continue;
      }
      // 老布局：没有 version、也没有 refs，顶层全是引用名
      if (!hasVersion) out.add(name);
      continue;
    }

    if (indent === 0) {
      inRefs = false;
      continue;
    }
    if (blockIndent === -1) blockIndent = indent;
    if (indent !== blockIndent) continue;
    const name = keyNameOf(body);
    if (name) out.add(name);
  }

  return out;
}

/** 一行 `名字: 值` 里的名字；不是这种行就返回 null */
function keyNameOf(line: string): string | null {
  const match = /^\s*([^:\s#][^:]*?)\s*:/.exec(line);
  return match ? match[1]!.trim().replace(/^["']|["']$/g, '') : null;
}

/** 值要当 YAML 里的双引号字符串写 —— 这样任何字符（含 `:`、`#`、引号）都安全 */
function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * 把 `ref: value` 放进这份文本里，**其余一个字符都不动**。纯函数，好测。
 *
 * 认不动的情况（`refs` 写成了带内容的一行、或者文件根本不是这个结构）
 * 直接抛 —— 让调用方去说人话，而不是我们瞎改。
 */
export function renderKeyRef(text: string, ref: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error('这个 key 是空的');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('这个 key 里有换行或控制字符，多半没复制完整');

  const lines = text.split('\n');
  if (text.trim() === '') return `version: 1\nrefs:\n  ${ref}: ${quote(trimmed)}\n`;

  const hasVersion = lines.some((l) => /^version\s*:/.test(l));
  const refsAt = lines.findIndex((l) => /^refs\s*:/.test(l));

  // ── 有 refs 段：插进那一段里（或者改掉已有的那一行）──
  if (refsAt >= 0) {
    const rest = lines[refsAt]!.slice(lines[refsAt]!.indexOf(':') + 1).trim();
    if (rest !== '' && rest !== '{}') {
      throw new Error(
        `凭据文件里的 refs 写成了一行（refs: ${rest}），这个我们自己不动。`
        + `请手动加一行：${ref}: ${quote(trimmed)}`,
      );
    }

    // 这一段的边界：从 refs: 往下，第一个回到顶层的行就是下一段
    const indentOf = (line: string): number => line.length - line.trimStart().length;
    let end = lines.length;
    let indent = '  ';
    for (let i = refsAt + 1; i < lines.length; i += 1) {
      const body = lines[i]!.trim();
      if (body === '' || body.startsWith('#')) continue;
      if (indentOf(lines[i]!) === 0) {
        end = i;
        break;
      }
      indent = lines[i]!.slice(0, indentOf(lines[i]!)); // 段内第一行的缩进就是这一段缩进
      break;
    }

    // 段内已有这个引用名 —— 就地改值。**不能插第二行**：YAML 重复键会让 DSH 起不来
    const existing = lines.findIndex((line, i) => i > refsAt && i < end && keyNameOf(line) === ref);

    if (existing >= 0) {
      lines[existing] = `${indent}${ref}: ${quote(trimmed)}`;
      return lines.join('\n');
    }
    lines.splice(refsAt + 1, 0, `${indent}${ref}: ${quote(trimmed)}`);
    return lines.join('\n');
  }

  // ── 有 version 但没有 refs 段：补一段 ──
  const tail = text.endsWith('\n') ? '' : '\n';
  if (hasVersion) return `${text}${tail}refs:\n  ${ref}: ${quote(trimmed)}\n`;

  // ── 老布局（整份就是一层 名字: 值）：加一行就够了，DSH 自己会升级它 ──
  return `${text}${tail}${ref}: ${quote(trimmed)}\n`;
}

/**
 * 写进去。**原子**：同目录写临时文件 → `rename`，中途断电也不会留半份文件。
 *
 * 0600 / 目录 0700 跟 DSH 自己写这个文件时的权限一模一样 ——
 * DSH 读到一份组可读或人人可读的凭据文件会**直接拒绝启动**，所以这不是讲究。
 */
export function saveKeyRef(file: string, ref: string, value: string): void {
  const before = existsSync(file) ? readText(file) : '';
  const after = renderKeyRef(before, ref, value);

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, after, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
