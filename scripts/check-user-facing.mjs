// ============================================================================
// 用户面文案自检：**会打印给用户看**的话里，不许出现仓库内路径。
//
//   pnpm check:user-facing
//
// 为什么要有它：`install.sh` 装出来的机器上**没有** `packages/`、`docs/`、`scripts/`。
// 一句"详细对照表在 docs/CHANNEL-FEISHU.md"对那种用户等于没说 —— 他那儿没这个文件。
// 这个坑咬过三次，每次都是同一句话：**提示里出现的东西，用户手上得真有**。
//
//   · 第 40 轮：探针提示里给的是仓库内路径，装出来的用户打不开；
//   · 第 41 轮：改成完整地址，并写下"手册那个地址指向的文件必须真在仓库里"；
//   · 第 43 轮：包内路径同样中招（`node packages/…/probe/smoke.mjs`）。
//
// 第 41/43 轮把规矩落在**那一个包**的打包产物上，并留下"没做的：没加一个仓库级的静态
// 检查脚本（check:user-facing 之类）"。这就是那个脚本。
//
// ⚠️ 第 46 轮起，判断"会打印"的集合**变大了**：`ctx.logger.*` 以前只进一个没人读的内存
// 缓冲（等于不打印），现在真的会打到终端上，所以它也算"会打印"。
//
// 怎么判断"会打印"：**用语法树，不用正则**。注释里到处都是 `docs/…`（写给人看的），
// 而 `//` 又出现在 `https://…` 里 —— 用正则剥注释一定会剥错。所以拿 TypeScript 的
// parser 认这几类调用：
//
//   · **任何** `.log / .info / .warn / .error / .debug(…)` 调用 —— **不看接收者叫什么**
//     （`console.x`、`ctx.logger.x`、`opts.log`、`this.log` 都算。第 48 轮实测：只认
//     "logger 族名"会漏掉引导页注入进来的 `opts.log`（14 处）和扫码页的裸 `log(…)`）
//   · 裸的 `log(…)`
//   · `process.stdout.write(…)` / `process.stderr.write(…)` —— `.write` **只认这两个**：
//     全仓数过，别的 `.write` 落在 `handle` / `store` / `state` / `res` 上，是写流写盘
//   · `.sh` 里的 echo / printf / step / ok / bad —— 脚本没有 AST，那几行纯文本扫
//
// 这个脚本**每次跑都先自检规则本身**（下面 `SELF_TEST` 那十几条，`--self-test` 可以只跑它）。
// 第 47 轮的六道反向验证是手跑一次、记在文档里的 —— 文档不会在别人改坏规则时喊疼。
//
// `https://…` 里的路径**不算**违规：那正是"够得着"的那一种。
//
// ⚠️ **查哪些文件，是个有意的边界**：只查"会到**装出来的用户**眼前的东西" ——
// `packages/*/src`（CLI 与插件）、`packages/*/probe`（探针跟着包一起发）、`install.sh`
// （用户的第一个入口）。**不查 `scripts/*.sh`**：那是维护者工具，跑它的人手上就有仓库，
// 里面的 `packages/`、`docs/` 是他自己要看的东西（实测：那 5 处命中全在那儿）。
// 圈太大只会逼人写例外，圈太小又拦不住 —— 这条线就是"谁在看这句话"。
//
// 用法：`node scripts/check-user-facing.mjs [文件…]`（不传就查上面那三类）。
// ============================================================================
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库内路径：装出来的机器上没有它们。`https://…` 里的不算（见 maskUrls） */
const BANNED = /(?:packages|docs|scripts)\//;

/** 把 URL 遮掉再判 —— `https://github.com/…/blob/main/docs/CHANNEL-FEISHU.md` 是合法的 */
function maskUrls(text) {
  return text.replace(/https?:\/\/\S+/g, '<url>');
}

function offends(text) {
  return BANNED.test(maskUrls(text));
}

// ───────────────────────── 找要查的文件 ─────────────────────────

/** 递归列出目录下的文件（按后缀过滤）；返回**绝对**路径 */
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'lib' || name === 'test') continue;
      walk(full, exts, out);
    } else if (exts.some((e) => name.endsWith(e))) {
      // ⚠️ 类型声明没有运行时行为，查它没意义 —— 更要紧的是它会让"这个包到底收到文件了吗"
      //    那条守卫**假绿**：`channel-wechat/src/plugin.d.ts` 就真把一个纯 .mjs 的包挡住了
      //    （实测：后缀只留 .ts 时，守卫只点了 dsh-plugin，没点 channel-wechat）。
      if (/\.d\.(ts|mts)$/.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * 源码后缀。⚠️ 要**齐**：这个仓库里有的包源码是 `.ts`，有的直接是 `.mjs`
 * （`channel-wechat`、`dsh-plugin`）。第一版只写了 `.ts` —— 那 17 个 `.mjs` 就被
 * **静默跳过**了。所以下面配了一条守卫：某个包的 `src/` 一个文件都没收到就报错，
 * 让"漏后缀"这件事出声，而不是安静地少查一半。
 */
const CODE_EXTS = ['.ts', '.mts', '.mjs', '.js'];

function targets() {
  // 命令行给了文件就只查它们（反向验证和"单独查一个文件"都用这条路）
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (argv.length) return argv.map((p) => resolve(p));

  const files = [];
  const pkgs = join(root, 'packages');
  for (const name of readdirSync(pkgs).sort()) {
    if (name.startsWith('.')) continue;
    files.push(...walk(join(pkgs, name, 'src'), CODE_EXTS));
    files.push(...walk(join(pkgs, name, 'probe'), CODE_EXTS));
  }

  // 防静默：每个"有 src/ 的包"都该至少收到一个文件；一个都没有，就是后缀名单漏了它
  const empty = readdirSync(pkgs)
    .filter((n) => !n.startsWith('.') && existsSync(join(pkgs, n, 'src')))
    .filter((n) => !files.some((f) => f.startsWith(join(pkgs, n, 'src') + sep)));
  if (empty.length) {
    console.error(
      `用户面文案自检：这些包的 src/ 一个文件都没收到 —— 后缀名单（${CODE_EXTS.join(' ')}）漏了它们？`,
    );
    for (const n of empty) console.error(`  packages/${n}/src`);
    process.exit(1);
  }

  const install = join(root, 'install.sh');
  if (existsSync(install)) files.push(install);
  return files;
}

/** 显示用的相对路径；在仓库外的就用绝对路径（临时文件就是这种情况） */
function label(abs) {
  const rel = relative(root, abs);
  return rel.startsWith('..') ? abs : rel;
}

// ───────────────────────── 认出"会打印"的调用 ─────────────────────────

/** 这些方法名在这个仓库里就是"打日志"（`.write` 不算 —— 见下面） */
const PRINT_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);

/**
 * 这个调用是不是"打到终端"的那几类？
 *
 * ⚠️ 第 48 轮放宽过一次，因为**实测**漏了两种：
 *   · `opts.log(…)` —— 引导页的打印口是**注入进来**的（`onboarding.ts` 里 14 处），
 *     第一版只认基名含 `logger` 的，全漏；
 *   · 裸的 `log(…)` —— `channel-wechat/src/login.mjs` 的扫码提示就是这么打的。
 * 所以现在**不看接收者叫什么**：`.log/.info/.warn/.error/.debug(…)` 一律算。
 * 这条放宽不是拍脑袋：全仓数过一遍，除了 `process.std*.write`，`.write` 只出现在
 * `handle` / `store` / `state` / `res` 上（写流、写盘），所以 `.write` **只认那两个**。
 */
function isPrintCall(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === 'log') return true;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (PRINT_METHODS.has(method)) return true;
  const base = callee.expression.getText();
  if (/^process\.(stdout|stderr)$/.test(base) && method === 'write') return true;
  return false;
}

/** 把一段表达式里**会直接变成文字**的片段捞出来（字符串、模板、`+` 拼接） */
function literalsIn(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push(node);
  } else if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) out.push(...literalsIn(span.expression, []));
    // 模板的头部也算文字
    if (node.head.text) out.push(node.head);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    literalsIn(node.left, out);
    literalsIn(node.right, out);
  } else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    literalsIn(node.expression, out);
  }
  return out;
}

/** 扫一段源码：返回命中列表。**真扫描和规则自检走的是同一条路**（否则自检等于没检） */
function scanSource(rel, text) {
  const hits = [];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && isPrintCall(node)) {
      for (const arg of node.arguments) {
        for (const lit of literalsIn(arg, [])) {
          const value = lit.text ?? lit.getText();
          if (offends(value)) {
            const { line } = sf.getLineAndCharacterOfPosition(lit.getStart(sf));
            hits.push({ rel, line: line + 1, text: value });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** 扫一段 shell：脚本没有 AST，只看会打出去的那几个动词，整行注释跳过 */
function scanShell(rel, text) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    if (/^[ \t]*#/.test(line)) return;
    if (!/^[ \t]*(echo|printf|step|ok|bad)\b/.test(line)) return;
    if (offends(line)) hits.push({ rel, line: index + 1, text: line.trim().slice(0, 120) });
  });
  return hits;
}

/** 按文件类型分派 —— 自检也走它，所以"分派对不对"同样被自检盯着 */
function scanFile(rel, text) {
  return rel.endsWith('.sh') ? scanShell(rel, text) : scanSource(rel, text);
}

// ───────────────────────── 规则自检（每次跑都验一遍） ─────────────────────────

/**
 * 这些是**规则自己的承诺**。为什么要有：第 47 轮的六道反向验证是手跑一次、记在文档里的 ——
 * 文档不会在别人改坏规则时喊疼。这十条每跑一次 `check:user-facing` 就验一次，
 * 所以"守卫真的会咬"不再依赖谁记得去手工试。
 *
 * ⚠️ 改规则时把这里一起改：**改不了就说明你改的是承诺**，那就该在文档里写清楚。
 */
const SELF_TEST = [
  { why: 'console.log 里的仓库内路径', file: 'a.ts', code: "console.log('见 docs/x.md')", want: 1 },
  { why: 'opts.log（注入进来的打印口）', file: 'a.ts', code: "opts.log('见 packages/cli/src/x.ts')", want: 1 },
  { why: '裸的 log(…)（扫码页）', file: 'a.mjs', code: "log('见 docs/x.md')", want: 1 },
  { why: 'ctx.logger 家族（第 46 轮起真会打到终端）', file: 'a.ts', code: "ctx.logger?.warn('见 packages/cli/src/x.ts')", want: 1 },
  { why: 'process.stderr.write', file: 'a.ts', code: "process.stderr.write('见 scripts/x.sh')", want: 1 },
  { why: '字符串拼接里的每一段', file: 'a.ts', code: "console.error('第 ' + n + ' 步：见 docs/x.md')", want: 1 },
  { why: '模板字符串', file: 'a.ts', code: 'console.log(`见 docs/x.md`)', want: 1 },
  { why: '注释里写什么都不算（AST 天然免疫）', file: 'a.ts', code: '// 见 docs/x.md\n/* packages/x */', want: 0 },
  { why: 'https://… 里的路径不算（那正是"够得着"）', file: 'a.ts', code: "console.log('https://github.com/o/r/blob/main/docs/x.md')", want: 0 },
  { why: '写流/写盘不算（store.write 不是打印）', file: 'a.ts', code: "store.write('docs/x.md')", want: 0 },
  { why: '.sh 的 echo', file: 'a.sh', code: 'echo "见 docs/x.md"', want: 1 },
  { why: '.sh 的 printf', file: 'a.sh', code: "printf '见 docs/x.md\\n'", want: 1 },
  { why: '.sh 的 ok（验收脚本的标题）', file: 'a.sh', code: 'ok "见 docs/x.md"', want: 1 },
  { why: '.sh 里不是打印动词的行不算', file: 'a.sh', code: 'mkdir -p docs/x', want: 0 },
  { why: '.sh 的整行注释', file: 'a.sh', code: '# 见 docs/x.md', want: 0 },
];

function runSelfTest() {
  const bad = SELF_TEST.map((c) => ({ ...c, got: scanFile(`自检/${c.file}`, c.code).length })).filter(
    (c) => c.got !== c.want,
  );
  if (!bad.length) return;

  console.error('用户面文案自检：**规则自己坏了**（不是仓库里有违规）。\n');
  for (const c of bad) {
    console.error(`  ${c.why}：应该 ${c.want} 处，实际 ${c.got} 处`);
    console.error(`    ${c.code.split('\n')[0]}`);
  }
  console.error('\n改法：这不是文案问题，是 scripts/check-user-facing.mjs 里的规则（isPrintCall /');
  console.error('offends / scanFile）被改动了。要是故意放宽/收紧，请把 SELF_TEST 一起改，');
  console.error('并在 docs/CHANNEL-FEISHU.md 里写清楚为什么。');
  process.exit(1);
}

// ───────────────────────── 主流程 ─────────────────────────

if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log(`用户面文案自检：规则自检 ${SELF_TEST.length} 条 → ✅ 规则本身是好的`);
  process.exit(0);
}

runSelfTest(); // 先确认"这把尺子"是好的，再拿它量仓库

const problems = [];
for (const abs of targets()) {
  const rel = label(abs);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`用户面文案自检：读不了 ${rel} —— ${err.code ?? err.message}`);
    process.exit(1);
  }
  problems.push(...scanFile(rel, text));
}

if (problems.length) {
  console.error('用户面文案自检没过：**会打印给用户看**的话里出现了仓库内路径。\n');
  console.error('装出来的机器上没有 packages/ docs/ scripts/ —— 那种用户打不开这些路径。\n');
  for (const p of problems) {
    console.error(`  ${p.rel}:${p.line}`);
    console.error(`    ${p.text}`);
  }
  console.error('\n改法：给**够得着**的东西 —— 完整地址（https://… 里的路径不算违规），');
  console.error('或者干脆只说"哪一步、怎么重来"，不要指一个他那儿没有的文件。');
  process.exit(1);
}

const list = targets();
const tsCount = list.filter((f) => f.endsWith('.ts')).length;
const mjsCount = list.filter((f) => f.endsWith('.mjs')).length;
const shCount = list.filter((f) => f.endsWith('.sh')).length;
console.log(
  `用户面文案自检：${tsCount} 个 .ts + ${mjsCount} 个 .mjs + ${shCount} 个 .sh → ` +
    `✅ 会打印的行里没有仓库内路径（https:// 里的不算；规则自检 ${SELF_TEST.length} 条通过）`,
);
