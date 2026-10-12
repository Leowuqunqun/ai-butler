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
 *   3. `exports` 里的每一个子路径入口都存在（子路径写错 = 用户 import 不到）。
 *
 * 用法：node scripts/check-packages.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

const pkgRoot = join(root, 'packages');
for (const dir of readdirSync(pkgRoot)) {
  if (statSync(join(pkgRoot, dir)).isDirectory()) checkPackage(dir);
}

if (problems.length) {
  console.error(`打包自检没过（查了 ${checked} 个包）：\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('\n改法通常是：把 files 写成整目录（"lib"），别一个一个列文件名。');
  process.exit(1);
}

console.log(`打包自检：${checked} 个包 → ✅ 入口都在、编译产物一个不漏`);
