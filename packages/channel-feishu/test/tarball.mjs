/**
 * **装好之后还能不能跑** —— 打包产物里那份探针。
 *
 * 文档和页面提示都让用户跑 `node <…>/probe/smoke.mjs --save`（`probe-path.ts` 按**包自己的
 * 位置**算出来的绝对路径）。源码树里当然跑得通；**装好之后**（`install.sh` → `~/.butler/prefix`，
 * 那里没有 `packages/` 源码树）跑不跑得通，只有真的打个包、解开、跑一次才知道。
 *
 * 做法：`npm pack` → 解到临时目录 → 把本仓的 `node_modules` **链**进去（替身：真安装会有
 * 自己的依赖，这里只是让 `@larksuite/channel` 解析得到）→ `--dry`（不联网、不写任何东西）
 * 跑一次，并断言**提示里那条路径在这份副本里真的存在**。
 *
 * 这条盯的是"用户看到的命令必须能照着跑"那条规矩 —— 它曾经坏过：`files: ["lib"]` 把探针
 * 漏在包外，而 11 处文字都在承诺 `bash …/probe/run.sh`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 本仓根目录（这个文件在 `<repo>/packages/channel-feishu/test/`） */
const REPO = join(HERE, '..', '..', '..');
const PKG = join(REPO, 'packages', 'channel-feishu');

test('★★ 打包产物里那份探针能跑，提示里那条路径也真的存在（装好之后的形态）', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'butler-pack-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  execFileSync('npm', ['pack', '--pack-destination', tmp], { cwd: PKG, stdio: 'pipe' });
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack 一个 tarball 都没出');
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp]);
  const copy = join(tmp, 'package');

  // 真安装会有自己的依赖；这里链**这个包自己的** `node_modules`（pnpm 把 `@larksuite/channel`
  // 放在这儿，不在仓库根），等价于"这个包装好、依赖也装好了"
  symlinkSync(join(PKG, 'node_modules'), join(copy, 'node_modules'), 'dir');

  assert.ok(existsSync(join(copy, 'probe', 'smoke.mjs')), '探针必须打进包里');
  assert.ok(existsSync(join(copy, 'probe', 'run.sh')), '`run.sh` 也要 —— 文档里承诺的就是它');
  assert.ok(existsSync(join(copy, 'lib', 'probe-path.js')), '提示里那条路径由 lib 算出来，lib 也得在');

  // `--dry` 不联网、不写盘；`--home=` 指到临时目录（**绝不碰真的 ~/.butler**）
  const out = execFileSync(
    process.execPath,
    ['probe/smoke.mjs', '--dry', `--home=${join(tmp, 'home')}`],
    { cwd: copy, encoding: 'utf8' },
  );
  assert.match(out, /dry run/, '--dry 要真的只是"说一遍、什么都不发"');
  assert.match(out, /通了就证明五件事/, '输出要是探针自己的那段，不是别的什么');

  // 提示里那条命令 = 用户会去粘的东西：在这份装好的副本里必须真的能跑
  const mod = await import(pathToFileURL(join(copy, 'lib', 'probe-path.js')).href);
  const probe = mod.probePath();
  // `import.meta.url` 可能给真实路径（macOS 上 /var 是 /private/var 的软链），所以两边都取真实路径再比
  assert.ok(
    realpathSync(probe).startsWith(realpathSync(copy)),
    `提示该指向**这份副本**自己的探针，实际是 ${probe}`,
  );
  assert.ok(existsSync(probe), `提示里那条命令必须真能跑：${probe}`);
  const hint = mod.scanHint(mod.defaultHome());
  assert.match(hint, /--save/, '提示要带 --save —— 不带只会连一下，不会把凭据存下来');
  assert.ok(hint.includes(probe), '提示里印的正是这条路径');

  // ★ 提示里提到手册时，给的是**能打开的地址**吗？
  //
  //   手册在仓库里，而 `install.sh` 装出来的人手里**没有**仓库 —— "详细对照表在
  //   `docs/CHANNEL-FEISHU.md` 第十二节"对他等于没说。这和上面那条探针路径是同一类毛病：
  //   提示里出现的东西，用户得真有，或者真够得着。
  //
  //   两条一起盯：① 探针提到手册的地方得是**完整地址** ② 地址指向的文件必须**真在仓库里**
  //   —— 文档改名/搬家会让它红，而不是静默地印一个 404。
  const smoke = readFileSync(join(copy, 'probe', 'smoke.mjs'), 'utf8');
  assert.ok(
    smoke.includes('https://github.com/Leowuqunqun/ai-butler/blob/main/docs/CHANNEL-FEISHU.md'),
    '探针提到手册时要给能打开的地址（装出来的人手里没有 docs/）',
  );
  assert.ok(
    existsSync(join(REPO, 'docs', 'CHANNEL-FEISHU.md')),
    '提示里那个地址指向的文件必须真在仓库里 —— 文档改名/搬家了就得改提示',
  );

  // 同一个毛病在**整个包**里都不许有：这份副本里凡是"会打印出去"的行（console / stdout），
  // 都不许出现仓库内路径（`packages/` `docs/` `scripts/`）—— 装出来的人手里没有仓库。
  // 扫的是**这一份副本**，也就是**真发出去的东西**（连编译后的 `lib/` 一起，不只是源码）。
  // `https://…` 里的路径不算：那是用户真够得着的那一种。
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
      return /\.(ts|mjs|js|sh)$/.test(e.name) ? [p] : [];
    });
  const offenders = [];
  for (const file of walk(copy)) {
    const text = readFileSync(file, 'utf8');
    if (!/packages\/|docs\/|scripts\//.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      if (!/console\.(log|error|warn)\(|process\.(stdout|stderr)\.write\(|^\s*(echo|printf)\b/.test(line)) return;
      const withoutUrls = line.replace(/https?:\/\/\S+/g, '');
      if (/packages\/|docs\/|scripts\//.test(withoutUrls)) {
        offenders.push(`${file.replace(copy, '<包>')}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.equal(
    offenders.length,
    0,
    `这些"会打印出去"的行里还印着仓库内路径（用户那儿没有这些文件）：\n${offenders.join('\n')}`,
  );
});
