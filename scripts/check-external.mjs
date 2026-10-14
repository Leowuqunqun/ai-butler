#!/usr/bin/env node
// ============================================================================
// 重读"别人家"的数：把手册第八节那张参考实现表对着 GitHub API 核一遍。
//
//   pnpm check:external                       # 联网核对（4 个仓库，4 次请求）
//   node scripts/check-external.mjs --self-test   # 只验解析器，不联网
//
// 为什么要有它（第 81 轮）：
//
//   第八节那张表的表头写着「Star（2026-10-14 从 GitHub API 读的）」——
//   它**有**日期锚（`check-docs.mjs` 的规则 ⑪ 管着这一条），但**没有**任何东西
//   管得住那几个数本身。第 81 轮照着手册的读法重读了一遍：四个仓库里
//   `lark-coding-agent-bridge` 已经 **2691 → 2692**，而表头那天**就是今天**。
//
//   ⇒ ⭐ 日期锚只保证"当时读过"，不保证"数还是那个数"。
//     这两件事都得有人管，但**管法不一样**：日期锚是**离线**能查的（规则 ⑪），
//     数的对错**必须联网**。所以这一条**不挂进 `check:docs`、也不挂进 CI**。
//
// ⚠️ 为什么刻意不挂 CI：`scripts/check-docs.mjs` 现在是**纯离线**的
//    （全文件 `fetch(` 出现 0 次）。把它变成联网意味着 CI 会受 GitHub API 的
//    可用性和限流摆布（未认证 60 次/小时，按 IP 算，共享 runner 上说不准）——
//    ⭐ 一个会随机误报的守卫，比没有守卫更糟（这是这仓库第 70 轮起的老规矩）。
//    所以这里是"**能手动跑的一条命令 + 一份规程**"，不是一道自动闸门。
//
// 有 `GITHUB_TOKEN` / `GH_TOKEN` 就用（限流放宽到 5000/小时），没有也能跑。
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANUAL = 'docs/CHANNEL-FEISHU.md';

/**
 * 从手册里把第八节那张表的行解析出来。
 *
 * 认的行长这样（列：项目 / Star / 形态）：
 *   | [名字](https://github.com/o/r) | 2691 | TS，`@larksuite/channel` + **WebSocket 长连接** |
 *
 * ⚠️ 解析器是**纯函数**，好让 `--self-test` 能离线喂它 —— 联网那半截不进自检。
 */
export function parseReferenceRows(text) {
  const rows = [];
  // 只在第八节里找：从 `## 八、` 到下一个 `## `。
  // ⚠️ 用 `^## 八、`（多行模式），**不要**写 `'\n## 八、'` ——
  //    后者要求那一行前面有换行，于是"文件正好以这一节开头"时它返回 -1。
  //    ⭐ 第 77 轮给规则 ⑪ 修过同一个坑（`'\n## 十一、'` → `/^## 十一、/m`），
  //    第 81 轮写这个新解析器时又写了一遍，**是自检夹具当场拦下的**。
  //    这就是夹具的用处：它喂的是"以这一节开头"的文本，真人手写时容易漏掉那种情况。
  const start = text.search(/^## 八、/m);
  if (start < 0) return rows;
  const rest = text.slice(start);
  // `rest` 自己就以 `## 八、` 开头，所以**第一个** `\n## ` 就是下一节。
  const end = rest.search(/\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);

  for (const line of section.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.split('|').map((c) => c.trim());
    // split('|') 对 `| a | b | c |` 会产出 ['', 'a', 'b', 'c', '']。
    if (cells.length < 5) continue;
    const [, project, stars, shape] = cells;
    if (project === '项目' || /^-+$/.test(project)) continue;
    const m = /^\[([^\]]+)\]\((https:\/\/github\.com\/[^)]+)\)$/.exec(project);
    if (!m) continue;
    if (!/^\d+$/.test(stars)) continue;
    rows.push({ name: m[1], url: m[2], stars: Number(stars), shape, slug: m[2].replace('https://github.com/', '') });
  }
  return rows;
}

// ── 自检：解析器（离线，不联网） ────────────────────────────────────────────
const PARSE_TEST = [
  {
    why: '正常一行能被解析出来（名字 / slug / 数 / 形态都要对）',
    text: '## 八、参考实现\n\n| 项目 | Star | 形态 |\n| --- | --- | --- |\n'
      + '| [a](https://github.com/o/a) | 123 | TS，官方 sdk |\n',
    want: [{ name: 'a', slug: 'o/a', stars: 123, shape: 'TS，官方 sdk' }],
  },
  {
    why: '⭐ 表头那行（`| 项目 | Star（…） | 形态 |`）本身不能被当成数据行',
    text: '## 八、参考实现\n\n| 项目 | Star（2026-10-14 从 GitHub API 读的） | 形态 |\n| --- | --- | --- |\n',
    want: [],
  },
  {
    why: '分隔行 `| --- | --- | --- |` 不能被当成数据行',
    text: '## 八、参考实现\n\n| 项目 | Star | 形态 |\n| --- | --- | --- |\n| [a](https://github.com/o/a) | 1 | x |\n',
    want: [{ name: 'a', slug: 'o/a', stars: 1, shape: 'x' }],
  },
  {
    why: '⭐ Star 那格不是纯数字（写成"约 2.7k"）⇒ 这一行被跳过，而不是解析出个 NaN',
    text: '## 八、参考实现\n\n| 项目 | Star | 形态 |\n| --- | --- | --- |\n| [a](https://github.com/o/a) | 约 2.7k | x |\n',
    want: [],
  },
  {
    why: '⭐ 第八节**之外**的表格（别的节也有 `| [x](github…) | 1 | y |` 形状）不归它管',
    text: '## 八、参考实现\n\n没有表。\n\n## 九、别的\n\n| [a](https://github.com/o/a) | 1 | x |\n',
    want: [],
  },
  {
    why: '⭐ 项目那格不是"链接包裹"的（裸名字）⇒ 跳过：这样它就不会把一段普通的表格误当成参考实现',
    text: '## 八、参考实现\n\n| 项目 | Star | 形态 |\n| --- | --- | --- |\n| 裸名字 | 1 | x |\n',
    want: [],
  },
  {
    why: '多行都认，且顺序保持（自上而下）',
    text: '## 八、参考实现\n\n| 项目 | Star | 形态 |\n| --- | --- | --- |\n'
      + '| [a](https://github.com/o/a) | 1 | x |\n| [b](https://github.com/o/b) | 2 | y |\n',
    want: [{ name: 'a', slug: 'o/a', stars: 1, shape: 'x' }, { name: 'b', slug: 'o/b', stars: 2, shape: 'y' }],
  },
];

function runSelfTest() {
  let bad = 0;
  for (const c of PARSE_TEST) {
    const got = parseReferenceRows(c.text);
    const norm = (rs) => rs.map((r) => `${r.name}|${r.slug}|${r.stars}|${r.shape}`).join(' ;; ');
    const a = norm(got);
    const b = norm(c.want);
    if (a !== b) {
      bad++;
      console.error(`❌ ${c.why}\n     期望：${b || '（空）'}\n     实际：${a || '（空）'}`);
    }
  }
  if (bad > 0) {
    console.error(`\n解析器自检 ${PARSE_TEST.length} 条 → ❌ ${bad} 条不对`);
    console.error('改法：这不是手册的问题，是 scripts/check-external.mjs 里的解析器被改动了。');
    process.exit(1);
  }
  console.log(`解析器自检 ${PARSE_TEST.length} 条 → ✅ 规则本身是好的`);
}

// ── 联网那半截 ──────────────────────────────────────────────────────────────
async function readStars(slug, token) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ai-butler-check-external' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/repos/${slug}`, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return d.stargazers_count;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return runSelfTest();

  const abs = resolve(ROOT, MANUAL);
  if (!existsSync(abs)) {
    console.error(`❌ 找不到 ${MANUAL}`);
    process.exit(1);
  }
  const rows = parseReferenceRows(readFileSync(abs, 'utf8'));
  if (rows.length === 0) {
    console.error(`❌ ${MANUAL} 第八节那张表一行都没解析出来 —— 是表被改了，还是解析器坏了？`);
    console.error('   （先跑 `node scripts/check-external.mjs --self-test` 分清是哪一边。）');
    process.exit(1);
  }

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  console.log(`重读 ${MANUAL} 第八节：${rows.length} 个仓库${token ? '（带 token）' : '（不带 token，限流 60 次/小时）'}\n`);

  let drift = 0;
  let unreachable = 0;
  for (const row of rows) {
    let live;
    try {
      live = await readStars(row.slug, token);
    } catch (e) {
      unreachable++;
      console.log(`  ⚠ ${row.name.padEnd(28)} 读不到（${e.message}）—— 这次不算数`);
      continue;
    }
    if (live === row.stars) {
      console.log(`  ✓ ${row.name.padEnd(28)} ${row.stars}（手册与 GitHub 一致）`);
    } else {
      drift++;
      console.log(`  ✗ ${row.name.padEnd(28)} 手册 ${row.stars} → GitHub ${live}`);
    }
  }

  console.log('');
  if (unreachable > 0 && drift === 0) {
    console.log(`⚠ 有 ${unreachable} 个仓库这次没读到 —— 读完之前不能说"全都对得上"。`);
    process.exit(2);
  }
  if (drift > 0) {
    console.log(`❌ ${drift} 处漂了。改法：把手册第八节那几个数改成新值；`);
    console.log('   ⚠️ 表头那个日期说的是"**上一次读是哪天**"，不是"今天"——');
    console.log('      你真在今天重读了，就把它改成今天（它多半是对的，别条件反射地动它）；');
    console.log('      数变了、日期没变，才是真正骗人的那种。');
    process.exit(1);
  }
  console.log('✅ 手册第八节的 Star 数就是 GitHub 现在的值。');
  console.log('   ⚠️ 但表头那个日期**不用**改：它说的是"上次读是哪天"，不是"今天"。今天真读了才改。');
}

main().catch((e) => {
  console.error(`❌ ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
