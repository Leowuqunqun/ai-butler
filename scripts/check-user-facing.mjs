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
//   · console.log / error / warn / info / debug(…)
//   · process.stdout.write(…) / process.stderr.write(…)
//   · logger 家族的 info/warn/error/debug(…)（`ctx.logger.x`、`this.ctx.logger?.x`、
//     `this.log(…)` 都算）
//   · `.sh` 里的 echo / printf / step / ok / bad —— 脚本没有 AST，那几行纯文本扫
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

const CONSOLE_METHODS = new Set(['log', 'error', 'warn', 'info', 'debug']);
const LOGGER_METHODS = new Set(['info', 'warn', 'error', 'debug']);

/** 这个调用是不是"打到终端"的那几类？ */
function isPrintCall(node) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  const base = callee.expression.getText();

  // console.log / console.error / …
  if (/^console$/.test(base) && CONSOLE_METHODS.has(method)) return true;
  // process.stdout.write / process.stderr.write
  if (/^process\.(stdout|stderr)$/.test(base) && method === 'write') return true;
  // ctx.logger.info / this.ctx.logger?.error / this.log(…)
  if (LOGGER_METHODS.has(method) && /logger/.test(base)) return true;
  if (base === 'this' && method === 'log') return true;
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

const problems = [];

/** 一行一条：打在哪、什么话、命中哪一段 */
function report(rel, line, text, why) {
  problems.push({ rel, line, text, why });
}

for (const abs of targets()) {
  const rel = label(abs);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`用户面文案自检：读不了 ${rel} —— ${err.code ?? err.message}`);
    process.exit(1);
  }

  if (abs.endsWith('.sh')) {
    // 脚本没有 AST：只看会打出去的那几个动词，整行注释跳过
    text.split('\n').forEach((line, index) => {
      if (/^[ \t]*#/.test(line)) return;
      if (!/^[ \t]*(echo|printf|step|ok|bad)\b/.test(line)) return;
      if (offends(line)) report(rel, index + 1, line.trim(), line.trim().slice(0, 120));
    });
    continue;
  }

  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) && isPrintCall(node)) {
      for (const arg of node.arguments) {
        for (const lit of literalsIn(arg, [])) {
          const value = lit.text ?? lit.getText();
          if (offends(value)) {
            const { line } = sf.getLineAndCharacterOfPosition(lit.getStart(sf));
            report(rel, line + 1, value, value.slice(0, 120));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
    '✅ 会打印的行里没有仓库内路径（https:// 里的不算）',
);
