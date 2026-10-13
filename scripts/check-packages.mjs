#!/usr/bin/env node
/**
 * 打包自检：**装出来的包，是不是完整的**。
 *
 * ── 为什么要有这个 ────────────────────────────────────────────────
 *
 * 仓库里什么都跑得通，因为源码就在手边。但 `npm publish` / `pnpm deploy`
 * 只带走 `files` 里列的东西 —— 而人写 `files` 的方式是**一个一个列文件名**，
 * 于是漏掉一个编译产物，现象是：
 *
 *     npm 上装得上、装完起不来
 *     Cannot find module '…/lib/sessions.js'
 *
 * 我们真踩过（`@butler/core` 的 `lib/sessions.js`）。这个脚本就是那次踩坑留下的：
 * **不再靠人列文件名** —— 整目录进包，然后在这里验证。
 *
 * ── 查什么 ────────────────────────────────────────────────────────
 *
 *   1. `main` / `exports` / `bin` 指的文件**真的存在**；
 *   2. `lib/` 和 `templates/` 下的每一个文件，都被 `files` 覆盖到了；
 *   3. `exports` 里的每一个子路径入口都存在（子路径写错 = 用户 import 不到）；
 *   4. **（第 51 轮）`src/` 里运行时用到的包，得在 `dependencies` 或 `peerDependencies` 里。**
 *      这条抓的是同一个病根的另一半：本地跑得通是因为仓库里装了、宿主也可能恰好声明了，
 *      装出去就是 `Cannot find module`。实测：7 个包在运行时值导入了 `@deepseek-ai/schemastery`，
 *      却只写在 `devDependencies` 里 —— 而同一个包对 `@deepseek-ai/cordis`（同样是宿主提供的）
 *      写的是 `peerDependencies`。宿主提供的东西，就该写 peer，让清单说真话。
 *      ⚠️ `import type` / `{ type X }` 只是类型，编译后不留痕，`devDependencies` 就够。
 *      ⚠️ `try { await import('x') } catch {}` **不算**：那是 ESM 里明写"这个可以没有"的办法
 *      （本仓 `dsh-plugin` 对 `@deepseek-ai/dsh-agent` 正是这么用的）。**静态** import 才是硬要求。
 *
 * 用法：node scripts/check-packages.mjs [--self-test]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
let checked = 0;

/** 把 `files` 里的一条规则套到相对路径上。npm 用的是 minimatch，这里只支持我们真会写的几种 */
function covers(pattern, path) {
  if (pattern === path) return true;
  // 整目录：`lib` 覆盖 `lib/` 下的一切
  if (!pattern.includes('*')) return path.startsWith(`${pattern}/`);
  // `a/**` 和 `a/**/x` 两种
  const rx = new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')}$`);
  return rx.test(path);
}

/** 这个包该带上哪些文件（相对包根） */
function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out;
}

/** npm 永远会带上的几个文件，`files` 里不写也在 */
const ALWAYS = new Set(['package.json', 'README.md', 'LICENSE', 'LICENSE.md']);

/** `./lib/x.js` 和 `lib/x.js` 是同一个东西 */
const norm = (p) => p.replace(/^\.\//, '');

// ───────────── ③ 运行时用到的包，得在 dependencies / peerDependencies 里 ─────────────

/**
 * 源码里**运行时**（值）用到的外部包名 → 第一处出现的位置。
 *
 * 用 TypeScript 语法树，不用正则 —— 跟 `check:user-facing` 同一套：`import type`、
 * `{ type X }` 这些"看着像导入、编译后不留痕"的写法，正则分不干净。
 */
function runtimeImportsOf(sources) {
  const out = new Map();
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const note = (spec, node) => {
      if (!spec || spec.startsWith('.') || spec.startsWith('node:')) return;
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (out.has(name)) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.set(name, `${file}:${line + 1}`);
    };
    /** `import { type A, type B } from 'x'` 这种：整条都是类型 */
    const allTypeOnly = (named) =>
      !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
    /**
     * 有没有被 try 包着。
     * ⚠️ 这不是钻空子：`try { await import('x') } catch {}` 就是 ESM 里明写"这个可以没有"的方式
     * （本仓 `dsh-plugin` 对 `@deepseek-ai/dsh-agent` 正是这么用的 —— 注释写着"拿不到就只传
     * agentOptions，插件不该整个起不来"）。**静态** `import` 才是硬要求，那才是要声明的。
     * `createSourceFile` 第 4 个参数开了 parent 指针，所以能往上走。
     */
    const inTry = (node) => {
      for (let p = node.parent; p; p = p.parent) if (ts.isTryStatement(p)) return true;
      return false;
    };

    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (!clause?.isTypeOnly && !allTypeOnly(clause?.namedBindings)) note(node.moduleSpecifier.text, node);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const named = node.exportClause;
        const everyType = !!named && ts.isNamedExports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
        if (!node.isTypeOnly && !everyType) note(node.moduleSpecifier.text, node);
      } else if (ts.isCallExpression(node)) {
        const spec = node.arguments[0];
        const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const requireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if ((dynamicImport || requireCall) && spec && ts.isStringLiteral(spec) && !inTry(node)) note(spec.text, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * 运行时用到、却没写进 `dependencies`/`peerDependencies` 的包名 → 位置。
 * **纯函数**（declared 由调用方给），所以自检能直接喂它 —— 第 48~50 轮那套。
 */
function undeclaredRuntime(sources, declared, selfName) {
  const out = new Map();
  for (const [name, at] of runtimeImportsOf(sources)) {
    if (name === selfName || declared.has(name)) continue;
    out.set(name, at);
  }
  return out;
}

/** 这些是**规则自己的承诺**（改规则就把这里一起改，改不了说明你改的是承诺） */
const SELF_TEST = [
  { why: '值导入、什么都没声明', code: "import z from 'x';", declared: [], want: 1 },
  { why: '值导入、只声明在 devDependencies', code: "import z from 'x';", declared: [], dev: ['x'], want: 1 },
  { why: 'import type 只是类型 ⇒ 不用管', code: "import type { T } from 'x';", declared: [], want: 0 },
  { why: '命名导入全是 type ⇒ 不用管', code: "import { type A, type B } from 'x';", declared: [], want: 0 },
  { why: '命名导入里有值 ⇒ 要管', code: "import { A } from 'x';", declared: [], want: 1 },
  { why: '一半 type 一半值 ⇒ 要管', code: "import { type A, B } from 'x';", declared: [], want: 1 },
  { why: '声明在 dependencies ⇒ 过', code: "import z from 'x';", declared: ['x'], want: 0 },
  { why: '声明在 peerDependencies ⇒ 过（宿主提供的就这么写）', code: "import z from 'x';", declared: ['x'], want: 0 },
  { why: '动态 import() 也是运行时', code: "const m = await import('x');", declared: [], want: 1 },
  { why: 'try/catch 里的动态 import 是"可以没有"的依赖（ESM 的 optional dep 写法）', code: "try { await import('x'); } catch {}", declared: [], want: 0 },
  { why: 'try/catch 里的 require 同理', code: "try { require('x'); } catch {}", declared: [], want: 0 },
  { why: 'require() 也是运行时', code: "const m = require('x');", declared: [], want: 1 },
  { why: '相对路径和 node: 内置不用声明', code: "import a from './a'; import b from 'node:fs';", declared: [], want: 0 },
  { why: 'export { A } from 是运行时再导出', code: "export { A } from 'x';", declared: [], want: 1 },
  { why: 'export type 只是类型', code: "export type { T } from 'x';", declared: [], want: 0 },
  { why: '子路径导入按包名算', code: "import z from 'x/sub';", declared: ['x'], want: 0 },
  { why: '没有 from 的 export（moduleSpecifier 是 undefined）', code: 'export { A };', declared: [], want: 0 },
];

function runSelfTest() {
  const bad = SELF_TEST.map((c) => ({
    ...c,
    got: undeclaredRuntime(new Map([['src/a.ts', c.code]]), new Set(c.declared), '@self/pkg').size,
  })).filter((c) => c.got !== c.want);
  if (!bad.length) return;
  console.error('打包自检：**规则自己坏了**（不是仓库里有违规）。\n');
  for (const c of bad) {
    console.error(`  ${c.why}：应该 ${c.want} 处，实际 ${c.got} 处`);
    console.error(`    ${c.code}`);
  }
  console.error('\n改法：这是 scripts/check-packages.mjs 里 runtimeImportsOf / undeclaredRuntime 的规则被改动了。');
  console.error('要是故意放宽/收紧，请把 SELF_TEST 一起改，并在 docs/CHANNEL-FEISHU.md 里写清楚为什么。');
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log(`打包自检：规则自检 ${SELF_TEST.length} 条 → ✅ 规则本身是好的`);
  process.exit(0);
}

runSelfTest(); // 先确认"这把尺子"是好的，再拿它量仓库

function checkPackage(dir) {
  const pkgPath = join(root, 'packages', dir, 'package.json');
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const name = pkg.name ?? dir;
  const files = pkg.files ?? [];
  const where = `packages/${dir}`;
  checked++;

  const must = (raw, why) => {
    const rel = norm(raw);
    if (ALWAYS.has(rel.split('/').pop()) || rel === 'package.json') return;
    if (!existsSync(join(root, 'packages', dir, rel))) {
      problems.push(`${name}（${where}）：${why} 指的 ${rel} 不存在`);
      return;
    }
    if (files.length && !files.some((p) => covers(norm(p), rel))) {
      problems.push(`${name}（${where}）：${why} 指的 ${rel} **不在 files 里**，装出去的包里没有它`);
    }
  };

  // ── ① 入口都得在包里 ──
  if (typeof pkg.main === 'string') must(pkg.main, 'main');
  if (typeof pkg.types === 'string') must(pkg.types, 'types');
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target === 'string') must(target, `exports["${sub}"]`);
    else for (const [kind, t] of Object.entries(target)) must(t, `exports["${sub}"].${kind}`);
  }
  for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
    const rel = typeof target === 'string' ? target : '';
    if (rel) must(rel, `bin["${bin}"]`);
  }

  // ── ② 编译产物一个都不能漏 ──
  // 这条是**根因**层面的守卫：lib/（构建产物）和 templates/（随包发的模板）
  // 下的每个文件都必须被 files 覆盖。新加一个源文件忘了改 files，这里就红。
  for (const sub of ['lib', 'templates']) {
    const abs = join(root, 'packages', dir, sub);
    if (!existsSync(abs)) continue;
    for (const rel of walk(abs, join(root, 'packages', dir))) {
      if (rel.endsWith('.tsbuildinfo')) continue;
      if (!files.some((p) => covers(norm(p), rel))) {
        problems.push(`${name}（${where}）：${rel} 不会被装进包里（files 里没有覆盖它的规则）`);
      }
    }
  }

  // ── ③ 运行时用到的包，得在 dependencies / peerDependencies 里 ──
  // 这条是**病根的另一半**：files 管"文件带没带走"，这条管"依赖声明得对不对"。
  // 本地永远过得去（仓库里装着、宿主也声明了），装出去才 Cannot find module。
  const pkgDirAbs = join(root, 'packages', dir);
  const srcDir = join(pkgDirAbs, 'src');
  if (existsSync(srcDir)) {
    const sources = new Map();
    for (const rel of walk(srcDir, pkgDirAbs)) {
      if (!/\.(m?ts|m?js)$/.test(rel) || rel.endsWith('.d.ts')) continue;
      sources.set(rel, readFileSync(join(pkgDirAbs, rel), 'utf8'));
    }
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    const undeclared = undeclaredRuntime(sources, declared, pkg.name);

    // ⚠️ 对账守卫（第 49 轮的教训）：正则数一遍"外面看着像导入"，跟语法树取到的比。
    //    对不上就是取漏了 —— 那比"仓库里真有违规"危险得多，因为它是静默的。
    const rawExternal = [...sources.values()]
      .join('\n')
      .match(/(?:from\s*|require\(\s*|import\(\s*)['"][^'"]+['"]/g)
      ?.some((s) => !/['"](?:\.|node:)/.test(s));
    if (rawExternal && runtimeImportsOf(sources).size === 0) {
      console.error(`打包自检：**在 ${where} 里取 import 取漏了**（不是仓库里有违规）。`);
      console.error('  源码里明明有指向外部包的 import/require，语法树一个都没取到。');
      console.error('  runtimeImportsOf 被改坏了？看 scripts/check-packages.mjs。');
      process.exit(1);
    }

    for (const [dep, at] of undeclared) {
      const onlyDev = dep in (pkg.devDependencies ?? {});
      problems.push(
        `${name}（${where}）：${at} 里运行时用到 ${dep}，但它${onlyDev ? '只在 devDependencies 里' : '哪里都没声明'}\n` +
          '       （本地跑得通是因为仓库里装着、宿主也可能恰好声明了；装出去就是 Cannot find module。宿主提供的就写 peerDependencies）',
      );
    }
  }
}

const pkgRoot = join(root, 'packages');
for (const dir of readdirSync(pkgRoot)) {
  if (statSync(join(pkgRoot, dir)).isDirectory()) checkPackage(dir);
}

if (problems.length) {
  console.error(`打包自检没过（查了 ${checked} 个包）：\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n改法看是哪一类：文件没进包 ⇒ 把 files 写成整目录（"lib"），别一个一个列文件名；');
  console.error('依赖没声明 ⇒ 宿主提供的写 peerDependencies，自己带的写 dependencies。');
  process.exit(1);
}

console.log(`打包自检：${checked} 个包 → ✅ 入口都在、编译产物一个不漏、运行时依赖都声明了（规则自检 ${SELF_TEST.length} 条通过）`);
