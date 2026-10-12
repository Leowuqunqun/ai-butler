#!/usr/bin/env node
/**
 * 文档体检：把 markdown 里的链接和图片都检查一遍。
 *
 *   node scripts/check-docs.mjs
 *
 * 查三件事 —— 第三件才是真正会漏的：
 *
 *   1. **断链**：指向的文件不存在（改名/挪目录后忘了改）
 *   2. **锚点**：`#小节` 在本文件里找不到对应标题
 *   3. **被 gitignore 的文件**：本地明明存在、检查也过得去，
 *      但没进版本库 —— 别人 clone 下来就是裂图/死链
 *
 * 第 3 条是踩出来的：根 README 曾经引用 `docs/diagrams/*.png` 当配图，
 * 而 `.gitignore` 里恰好有 `docs/diagrams/*.png`（那张图只该在聊天里看）。
 * 本地一切正常，推到 GitHub 上配图全裂。所以这个检查必须带上 gitignore 判定。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
};

/**
 * 所有 markdown（排除依赖与构建产物）。
 *
 * ⚠️ `dist/` 必须排除：分发包里会**拷一份** `docs/GETTING-STARTED.md` 进去
 *   （它得跟着包一起走，收到包的人要照着做）。那份副本在自己的位置上，
 *   相对链接（`ARCH-product.md` 之类）当然断 —— 拿构建产物来判"断链"是误报，
 *   而且一打 bundle 就红一次。构建产物不是文档，别检查它。
 */
const files = execFileSync(
  'find',
  ['.', '-name', '*.md', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.git/*',
    '-not', '-path', '*/lib/*', '-not', '-path', '*/.build/*', '-not', '-path', '*/dist/*'],
  { cwd: ROOT, encoding: 'utf8' },
).trim().split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, '')).sort();

/** 该路径是否被 .gitignore 挡住（check-ignore 退出码 0 = 被忽略） */
const isIgnored = (p) => {
  try {
    execFileSync('git', ['check-ignore', '--quiet', p], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** 标题 → 锚点（GitHub 的规则：小写、去标点、空格转 -） */
function anchorsOf(text) {
  const out = new Set();
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
    out.add(
      m[1].toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-'),
    );
  }
  return out;
}

let broken = 0, ignored = 0, badAnchor = 0, checked = 0, oddFence = 0;
const problems = [];

/** 代码块围栏的条数。多到 3 个空格缩进也算（markdown 允许） */
const fenceCount = (text) => (text.match(/^ {0,3}```/gm) ?? []).length;

for (const file of files) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  const ownAnchors = anchorsOf(text);

  // ⓪ 代码块围栏成对。
  //    这条是**从真实事故里补的**：ARCH-technical 少了一个开围栏（27 条，奇数），
  //    于是下一个 `### 标题` 和小节全被吞进代码块 —— 本地看 markdown 源文件毫无异常，
  //    只有渲染出来才看得见。这种"只有推上去才裂"的问题，正是本脚本存在的理由。
  if (fenceCount(text) % 2 !== 0) {
    problems.push(
      `❌ 代码块围栏没配对  ${file}\n` +
      `       → 有 ${fenceCount(text)} 条 \`\`\`（应该是偶数）\n` +
      '       （多出来那条会把后面的标题吞进代码块，本地看源文件看不出来）',
    );
    oddFence++;
  }

  // 同时抓 [文字](目标) 和 ![alt](目标)
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:)/.test(raw)) continue;

    const [pathPart, anchor] = raw.split('#');
    const clean = pathPart ? decodeURIComponent(pathPart) : '';
    checked++;

    // ① 断链 / 裂图
    if (clean) {
      const abs = resolve(ROOT, dirname(file), clean);
      if (!existsSync(abs)) {
        problems.push(`❌ 断链  ${file}\n       → ${raw}`);
        broken++;
        continue;
      }
      // ③ 本地存在但没进版本库 —— 别人 clone 下来就是裂的
      const rel = relative(ROOT, abs);
      if (isIgnored(rel)) {
        problems.push(`❌ 引用了被 gitignore 的文件  ${file}\n       → ${raw}\n       （${rel} 不会进版本库，推到 GitHub 就是裂图/死链）`);
        ignored++;
        continue;
      }
    }

    // ② 锚点
    if (anchor) {
      const targetText = clean ? readFileSync(resolve(ROOT, dirname(file), clean), 'utf8') : text;
      const pool = clean ? anchorsOf(targetText) : ownAnchors;
      if (!pool.has(anchor.toLowerCase())) {
        problems.push(`❌ 锚点不存在  ${file}\n       → ${raw}`);
        badAnchor++;
      }
    }
  }
}

// ───────────────────────── 双语结构守卫 ─────────────────────────
//
// 第 4 条检查，也是唯一一条跟"内容"有关的：**中文版和英文版的结构要对得上**。
//
// 翻译最容易坏的地方不是译错词，是**一边加了新章节、另一边忘了**。
// 这种漂移没人会主动发现 —— 英文读者看到的是半年前的文档，还以为是最新的。
//
// 能自动查的只有结构：二级标题的**数量**（语言不同，标题文字没法比）。
// 它拦不住"改了内容忘了改另一边"，但能拦住"整节漏掉"这个最要命的情况。
//
// ⚠️ **试过比"数字"，放弃了。** 想法很自然："同一份文档的两种语言，数字必须一样"，
// 这能顺带查出改了一个数字忘了改另一边。实际跑下来噪声太大：
//   - 分词差异：`1280。` / `1280.`、`## 1.`（编号）会被当成两个不同的"数字"
//   - 合法差异：中文示例对话后面加的英文注里，会**天然再出现一次**同样的数字
//     （`32 张图` + `(32 images …)`），译文因此合理地比原文多
// 一个会误报的守卫比没有守卫更糟 —— 红灯响几次之后，所有人都会开始无视它。
// 所以这里只查结构。**内容是否同步，只能靠人。**
//
// 配对表不写在这里 —— 写在 `docs/GLOSSARY.md` 的「语言之锚」表里，
// 免得同一个事实有两个人维护。

const glossaryPath = resolve(ROOT, 'docs/GLOSSARY.md');
const pairs = [];
if (existsSync(glossaryPath)) {
  for (const line of readFileSync(glossaryPath, 'utf8').split('\n')) {
    // | 项目首页 | [`README.md`](../README.md) | [`README.en.md`](../README.en.md) |
    const m = /^\|\s*(.+?)\s*\|\s*\[[^\]]+\]\(([^)]+\.md)\)\s*\|\s*\[[^\]]+\]\(([^)]+\.md)\)\s*\|$/.exec(line);
    if (!m) continue;
    pairs.push({
      label: m[1],
      cn: resolve(dirname(glossaryPath), m[2]),
      en: resolve(dirname(glossaryPath), m[3]),
    });
  }
}

/** 二级标题的数量。语言不同没法比文字，只能比数量 */
const h2Count = (text) => (text.match(/^##\s+\S/gm) ?? []).length;

let h2Mismatch = 0, noSwitch = 0;

for (const { label, cn, en } of pairs) {
  if (!existsSync(cn) || !existsSync(en)) {
    problems.push(`❌ 双语配对缺文件  ${label}\n       → ${relative(ROOT, cn)} / ${relative(ROOT, en)}`);
    h2Mismatch++;
    continue;
  }
  const cnText = readFileSync(cn, 'utf8');
  const enText = readFileSync(en, 'utf8');

  // ① 结构对齐
  const a = h2Count(cnText), b = h2Count(enText);
  if (a !== b) {
    problems.push(
      `❌ 双语结构不对齐  ${label}\n` +
      `       → ${relative(ROOT, cn)} 有 ${a} 个二级标题，${relative(ROOT, en)} 有 ${b} 个\n` +
      '       （多半是哪边加了章节忘了另一边）',
    );
    h2Mismatch++;
  }

  // ①b 围栏条数也要一样 —— 一边漏了围栏，另一边没漏，就是渲染不一致
  if (fenceCount(cnText) !== fenceCount(enText)) {
    problems.push(
      `❌ 双语代码块围栏数不一致  ${label}\n` +
      `       → ${relative(ROOT, cn)} 有 ${fenceCount(cnText)} 条，${relative(ROOT, en)} 有 ${fenceCount(enText)} 条`,
    );
    h2Mismatch++;
  }

  // ② 两边的语言切换链接都得在**开头**，否则读者出不去。
  //    只看开头是有意的：正文里随便提一句文件名不算切换链接。
  const HEAD = 12;
  const cnName = relative(ROOT, cn).split('/').pop();
  const enName = relative(ROOT, en).split('/').pop();
  const head = (t) => t.split('\n').slice(0, HEAD).join('\n');
  if (!head(cnText).includes(enName)) {
    problems.push(`❌ 中文版开头没有指向英文版的链接  ${relative(ROOT, cn)}\n       → 前三行加一行「[English](...)」`);
    noSwitch++;
  }
  if (!head(enText).includes(cnName)) {
    problems.push(`❌ 英文版开头没有指向中文版的链接  ${relative(ROOT, en)}\n       → 前三行加一行「[中文](...)」`);
    noSwitch++;
  }
}

if (problems.length) console.log(`${problems.join('\n')}\n`);
console.log(
  `检查 ${files.length} 个 md、${checked} 个链接/图片、${pairs.length} 对双语 → ` +
  (problems.length
    ? `❌ 断链 ${broken}、锚点 ${badAnchor}、被忽略 ${ignored}、围栏 ${oddFence}、结构 ${h2Mismatch}、缺切换链接 ${noSwitch}`
    : '✅ 链接有效、都在版本库里、围栏成对、双语结构对齐'),
);
process.exit(problems.length ? 1 : 0);
