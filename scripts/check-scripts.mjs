// ============================================================================
// 脚本自检：别让"标题里的反引号"再咬人一次。
//
//   pnpm check:scripts
//   node scripts/check-scripts.mjs --self-test   （只验规则本身，扫仓库那步跳过）
//
// 为什么要有它：`step "… `butler run` …"` 这行看起来人畜无害，但那对反引号在**双引号**里 ——
// shell 会在**拼这行标题的时候**把它当**命令替换**，于是命令**真的被跑一遍**（还没重定向、
// 还没人来收它）。这个仓库被咬过两次：
//
//   · 一次在 `install.sh` 的 heredoc 里（漏转义一个反引号），教训记在 make-installer-bundle.sh；
//   · 一次在 scripts/verify-upgrade.sh：第 ⑧ 步标题里写了 `butler run`，脚本于是卡在命令替换里
//     等一个没人管的 butler run（实测挂了 27 分钟，ps 里看起来像"后台起进程的壳有问题"，
//     误导了整整两轮）。
//
// 第 49 轮把这条规则从"三个写死的函数名"改成"**从脚本里认出来**"，因为写死的名单有两个洞：
//
//   ① 显示函数不止 `step`/`ok`/`bad` —— `install.sh` 用的是 `say`/`die`（`die` 又调 `say`），
//      `make-installer-bundle.sh` 也有 `say`。这些名字以前**一个都不查**；
//   ② 抬头自己写着"一次咬在 heredoc 里"，而原规则**根本没看 heredoc** ——
//      `make-installer-bundle.sh:95` 那行"管家自己知道 \`butler\` 在哪"正是那次留下的疤，
//      转义还在，可谁要是删掉那个反斜杠，**没有任何东西会喊**。
//
// 现在的判断是两半，都是从源码里算出来的（**不靠维护者记得加名字**）：
//
//   ① **会印字的函数**：体内直接出现 `printf`/`echo` 的，以及调了这些函数的（传递闭包）。
//      再拦"这些函数 + 第一个双引号参数里含反引号"—— `URL=$(… | head -1)` 这种不在此列，
//      那是**有意**展开。转义的 `\`` 也拦：这里想要的是「」，不是"写对转义"。
//   ② **不带引号的 heredoc**：`<<EOF`（不带引号）体内会展开，裸反引号就是命令替换；
//      `<<'EOF'` 不展开，整段跳过。⚠️ heredoc 体内 `#` 开头的行**不是注释**（那里没有注释这回事），
//      所以照查。
//
// 注释里的反引号不执行，所以普通行的整行注释跳过（heredoc 体内除外，理由见上）。
// ============================================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 要查的文件：仓库里的 shell 脚本（install.sh + scripts/*.sh）。 */
function shellScripts() {
  const files = [];
  const install = join(root, 'install.sh');
  if (existsSync(install)) files.push('install.sh');
  const dir = join(root, 'scripts');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.sh')) files.push(join('scripts', name));
    }
  }
  return files;
}

// ───────────────────────── ① 会印字的函数 ─────────────────────────

/** 取出 `name() { … }` 的函数体（单行 `say() { …; }` 和多行都认；哨兵 `}` 在行首） */
function functionBodies(text) {
  const bodies = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{/.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    let body = lines[i];
    // 单行写完就完事；多行的按**花括号深度**收到归零为止。
    // ⚠️ 别用"行首的 }"当结尾：`sha()` 那种多行函数收尾的 `}` 可能缩进，会一路吞掉后面几个函数
    // （实测吞掉过 verify-upgrade.sh 的 perm / butler / doctor —— 是下面那条对账守卫抓出来的）。
    // `${VAR}` 和 awk 的 `{print}` 里花括号都成对，所以只数个数就够用。
    const braces = (s) => (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;
    let depth = braces(lines[i]);
    if (depth > 0) {
      for (let j = i + 1; j < lines.length; j++) {
        body += '\n' + lines[j];
        depth += braces(lines[j]);
        if (depth <= 0) {
          i = j;
          break;
        }
      }
    }
    bodies.set(name, body);
  }
  return bodies;
}

/**
 * 哪些函数会印东西？直接印的（`printf`/`echo`）＋ 调了它们的（传递到不动点）。
 *
 * ⚠️ 传递很要紧：`die() { say "❌ $*" >&2; exit 1; }` 自己一个 `printf` 都没有，
 * 但它显然是给人看的。
 */
function printingFunctions(text) {
  const bodies = functionBodies(text);
  const prints = new Set();
  for (const [name, body] of bodies) if (/\b(printf|echo)\b/.test(body)) prints.add(name);

  for (let round = 0; round < bodies.size; round++) {
    let grew = false;
    for (const [name, body] of bodies) {
      if (prints.has(name)) continue;
      for (const other of prints) {
        if (new RegExp(`(^|[^A-Za-z0-9_])${other}([^A-Za-z0-9_]|$)`).test(body)) {
          prints.add(name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  return prints;
}

/** 这些函数的标题里含反引号 → 命中（注释行跳过） */
function scanTitles(text, names) {
  if (!names.length) return [];
  // ⚠️ 用单引号拼：模板字符串里要写"一个字面反引号"得 `\``，很容易把自己关掉（这轮就先写错了一次）
  const offender = new RegExp('^[ \\t]*(' + names.join('|') + ')[ \\t]+"[^"]*`');
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (/^[ \t]*#/.test(line)) return; // 注释里的反引号不执行
    if (offender.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

// ───────────────────────── ② 不带引号的 heredoc ─────────────────────────

/** `<<EOF`（不带引号）体内会展开：裸反引号就是命令替换；`<<'EOF'` 整段跳过 */
function scanHeredocs(text) {
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(lines[i]);
    if (!m) continue;
    const quoted = m[1] !== '';
    const word = m[2];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== word) {
      if (!quoted) {
        // 先把转义的拿掉再看：`\`` 是字面量，剩下的裸反引号才会真执行
        if (lines[j].replace(/\\`/g, '').includes('`')) {
          hits.push({ line: j + 1, text: lines[j].trim() });
        }
      }
      j++;
    }
    i = j;
  }
  return hits;
}

/** 扫一份脚本：两半一起查。真扫描和规则自检走的是**同一条路** */
function scanScript(text) {
  return [
    ...scanTitles(text, [...printingFunctions(text)].sort()),
    ...scanHeredocs(text),
  ];
}

// ───────────────────────── 规则自检（每次跑都验一遍） ─────────────────────────

/**
 * 这些是**规则自己的承诺**。手跑一次记在文档里的反向验证，不会在别人改坏规则时喊疼 ——
 * 所以每跑一次 `check:scripts` 就验一次（`--self-test` 可以只跑这部分）。
 *
 * ⚠️ 改规则时把这里一起改：改不了就说明你改的是**承诺**，那该在文档里写清楚。
 */
const SELF_TEST = [
  { why: 'step 标题里的裸反引号', code: 'step "跑 `butler run` 看看"', want: 1 },
  { why: 'say 这种另一个显示函数（第 49 轮放宽前不查）', code: 'say "跑 `butler run` 看看"', want: 1 },
  { why: '传递的也算：die 自己没 printf，但它调 say', code: 'die "见 `x`"' , want: 1 },
  { why: '转义的也拦（这里想要的是「」，不是"转义写对了"）', code: 'step "跑 \\`butler run\\` 看看"', want: 1 },
  { why: '不是显示函数的行不查（有意展开）', code: 'URL=$(curl -s x | head -1)', want: 0 },
  { why: '普通行的整行注释不算', code: '# step "`x`"', want: 0 },
  { why: '不带引号的 heredoc 体内裸反引号会真执行', code: 'cat > f <<EOF\n见 `butler` 在哪\nEOF', want: 1 },
  { why: '同一处转义了就没事（这就是 make-installer-bundle 里那行）', code: 'cat > f <<EOF\n见 \\`butler\\` 在哪\nEOF', want: 0 },
  { why: '带引号的 heredoc 不展开，体内反引号无害', code: "cat > f <<'EOF'\n见 `butler`\nEOF", want: 0 },
  { why: 'heredoc 体内 `#` 开头的行**不是**注释，照样查', code: 'cat > f <<EOF\n# 见 `butler`\nEOF', want: 1 },
].map((c) => ({ ...c, script: c.script ?? 'step() { printf \'%s\\n\' "$*"; }\nsay() { printf \'%s\\n\' "$*"; }\ndie() { say "❌ $*" >&2; exit 1; }' }));

/**
 * 规则跑一遍要能认出"会印字的函数"，否则说明取函数体那步坏了。
 *
 * ⚠️ 这里有个**自己咬到自己**的教训（第 49 轮实测）：最初的守卫只看"取到的函数体里有没有会印字的",
 * 于是"这个脚本真的没定义函数"（render-diagrams.sh）和"取函数体那步坏了"**长得一模一样** ——
 * 把 functionBodies 改坏之后它安安静静地跳过了。现在改成**两条独立观察对账**：一条便宜的
 * （在源码里数 `name() {`），一条是要被验的（functionBodies 取到的那份）。对不上就出声；
 * 对得上、又真的一个函数都没有，才算"这脚本确实没什么可认的"。
 */
function checkRuleIsAlive(rel, text) {
  const declared = new Set(
    (text.match(/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/gm) ?? []).map((s) => s.split('(')[0].trim()),
  );
  const bodies = functionBodies(text);

  const lost = [...declared].filter((n) => !bodies.has(n));
  if (lost.length) {
    console.error(`脚本自检：**在 ${rel} 里取函数体取漏了**（不是仓库里有违规）。`);
    console.error(`  源码里声明了 ${declared.size} 个函数，取到的只有 ${bodies.size} 个；漏掉：${lost.join(' ')}`);
    console.error('  functionBodies 被改坏了？看 scripts/check-scripts.mjs。');
    process.exit(1);
  }
  if (bodies.size && !printingFunctions(text).size) {
    console.error(`脚本自检：**规则在 ${rel} 里认不出任何"会印字的函数"**（不是仓库里有违规）。`);
    console.error(`  这个脚本定义了 ${bodies.size} 个函数（${[...bodies.keys()].join(' ')}），`);
    console.error('  却一个都不像给人看的 —— 传递闭包那一步被改坏了？');
    process.exit(1);
  }
}

function runSelfTest() {
  const bad = SELF_TEST.map((c) => ({ ...c, got: scanScript(c.script + '\n' + c.code).length })).filter(
    (c) => c.got !== c.want,
  );
  if (!bad.length) return;

  console.error('脚本自检：**规则自己坏了**（不是仓库里有违规）。\n');
  for (const c of bad) {
    console.error(`  ${c.why}：应该 ${c.want} 处，实际 ${c.got} 处`);
    console.error(`    ${c.code.split('\n')[0]}`);
  }
  console.error('\n改法：这不是脚本的问题，是 scripts/check-scripts.mjs 里的规则被改动了。');
  console.error('要是故意放宽/收紧，请把 SELF_TEST 一起改，并在 docs/CHANNEL-FEISHU.md 里写清楚为什么。');
  process.exit(1);
}

// ───────────────────────── 主流程 ─────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log(`脚本自检：规则自检 ${SELF_TEST.length} 条 → ✅ 规则本身是好的`);
  process.exit(0);
}

runSelfTest(); // 先确认"这把尺子"是好的，再拿它量仓库

const problems = [];
for (const rel of shellScripts()) {
  const text = readFileSync(join(root, rel), 'utf8');
  checkRuleIsAlive(rel, text); // 认不出"会印字的函数"就出声；真扫描与自检都走 scanScript
  for (const hit of scanScript(text)) problems.push({ rel, ...hit });
}

if (problems.length) {
  console.error('脚本自检没过：会**真执行**的反引号出现在给人看的标题里(或会展开的 heredoc 里)。\n');
  console.error('双引号里的反引号是命令替换 —— 拼这行标题的时候命令就真跑一遍了。\n');
  for (const p of problems) {
    console.error(`  ${p.rel}:${p.line}`);
    console.error(`    ${p.text}`);
  }
  console.error('\n改法：命令名用「」（例如 step "⑥ 升级后「butler init」补能力行…"）；');
  console.error('heredoc 里要么把 ` 转义成 \\`，要么把分隔符加上引号（<<\'EOF\'，那样整段不展开）。');
  process.exit(1);
}

console.log(
  `脚本自检：${shellScripts().length} 个 shell 脚本 → ` +
    `✅ 会印字的函数的标题里没有反引号、不带引号的 heredoc 里也没有 ` +
    `（规则自检 ${SELF_TEST.length} 条通过）`,
);
