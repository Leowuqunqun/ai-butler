// ============================================================================
// 脚本自检：别让"标题里的反引号"再咬人一次。
//
//   pnpm check:scripts
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
// 这个检查只盯**显示用**的三个函数 —— `step` / `ok` / `bad`。它们的第一个参数永远是给人看的
// 一句话，里面出现反引号**一定是**笔误（想强调命令名就用「」，或者干脆不加引号）。别的行不查：
// 那里出现反引号经常是有意的（比如 `URL=$(… | head -1)` 旁边、或者 JS 模板字符串里）。
//
// 注释里的反引号不执行，所以整行注释跳过。
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

// 非注释行 + 以 step/ok/bad 开头 + 第一个双引号参数里含反引号
const OFFENDER = /^[ \t]*(step|ok|bad)[ \t]+"[^"]*`/;

const problems = [];
for (const rel of shellScripts()) {
  const lines = readFileSync(join(root, rel), 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (/^[ \t]*#/.test(line)) return; // 注释里的反引号不执行
    if (OFFENDER.test(line)) problems.push({ rel, line: index + 1, text: line.trim() });
  });
}

if (problems.length) {
  console.error('脚本自检没过：显示函数的标题里有反引号 —— 那在双引号里是**命令替换**，会把命令真跑一遍。\n');
  for (const p of problems) {
    console.error(`  ${p.rel}:${p.line}`);
    console.error(`    ${p.text}`);
  }
  console.error('\n改法：命令名用「」（例如 step "⑥ 升级后「butler init」补能力行…"），或者干脆不加引号。');
  process.exit(1);
}

console.log(`脚本自检：${shellScripts().length} 个 shell 脚本 → ✅ step/ok/bad 的标题里没有反引号（不会有意外命令替换）`);
