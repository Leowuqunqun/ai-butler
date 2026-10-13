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
 *
 * 第 4 条是第 50 轮补的：**出包出去的 md 里，相对链接必须指向"同一个包里也出包"的东西**。
 * 包的 README 在 GitHub 上点得开，但在 **npm 页面**上相对链接是按"包"解析的 ——
 * `../cli`、`../../docs/GETTING-STARTED.md`、`test/fixtures/x.ts` 到了那边全是死链。
 * 同一个毛病在第 47 轮出现过一次（当时是**会打印给用户看的话**里写仓库路径），
 * 这次换了个读者：拿到这个包的人。指向仓库别处一律用完整地址。
 * ⚠️ "哪些 md 算出了包"不写死清单，从每个 package.json 的 `files` 现算（见 shippedSetOf）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
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

// ───────────── ④ 出包文档：链接得对着"拿到这个包的人"说 ─────────────

/** 递归列出目录下所有文件（绝对路径） */
function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 这个包**实际发出去**的文件（相对包根）。
 *
 * npm 一定会带 `README*` / `LICENSE*` / `package.json`，其余按 `files` 展开。
 * ⚠️ 不写死清单，从 package.json 现算 —— 第 47 轮漏了 17 个 `.mjs`、第 49 轮漏了整个 heredoc，
 * 两次都是"范围是假设的"。这里让范围由数据决定。
 */
function shippedSetOf(pkgRoot) {
  const abs = resolve(ROOT, pkgRoot);
  const pkgJson = JSON.parse(readFileSync(join(abs, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  for (const name of readdirSync(abs)) {
    if (/^(README|LICENSE|LICENCE|CHANGELOG)(\.|$)/i.test(name)) out.add(name);
  }
  for (const entry of pkgJson.files ?? []) {
    const target = join(abs, entry);
    if (!existsSync(target)) continue;
    if (statSync(target).isFile()) out.add(entry);
    else for (const f of walkFiles(target)) out.add(join(entry, relative(target, f)));
  }
  return out;
}

/**
 * 出包文档里"指向没出包的东西"的相对链接。**纯函数**（shipped 由调用方给），
 * 所以规则自检能直接喂它 —— 第 48/49 轮那套。
 */
function shippedDocViolations(relFile, text, shipped) {
  const parts = relFile.split('/'); // packages/<name>/…
  const pkgRoot = `${parts[0]}/${parts[1]}`;
  const hits = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue; // 完整地址/锚点：读者够得着
    const path = raw.split('#')[0];
    if (!path) continue;
    const target = normalize(join(dirname(relFile), path)); // 相对仓库根
    if (!target.startsWith(`${pkgRoot}/`)) {
      hits.push(raw); // 跑到包外面去了
      continue;
    }
    if (!shipped.has(target.slice(pkgRoot.length + 1))) hits.push(raw);
  }
  return hits;
}

/**
 * 用户文档里"照着敲"的命令，路径得够得着 —— 够不着就必须自己说清**只在源码树里成立**。
 *
 * 第 53 轮真机跑出来的洞：手册让装好的人跑 `bash packages/channel-feishu/probe/run.sh --save`，
 * 而 `install.sh` 装出来的人**没有 `packages/`**（包在 `~/.butler/prefix/app/node_modules` 里）——
 * 照抄只会得到 `No such file or directory`。文档里早就写过这句话（`probe-path.ts` 的注释：
 * "一条用户照着做也做不到的提示，比没有提示更坏"），第 54 轮把它做成检查。
 *
 * 认的"标记"：**同一个代码块里**（行内代码则是同一行）出现 `源码树` / `发行包` / `装完之后` /
 * `仓库根` / `clone` / `开发` 之一。**不看邻近的行** —— 真跑时就有一处：第一个块的说明写在
 * **块外**的引用里，读者直接翻到第三个块（`--save`，最容易照抄的那个）根本看不到它。
 *
 * 只认"像命令"的整行：`bash|sh|node|pnpm|npx|dsh|butler|npm|cd` 开头，且带仓库内路径
 * （`packages/` `scripts/` `apps/`）。散文里提到 `packages/a/src/x.ts` 不算 —— 那是叙述。
 * 包内相对路径（`node --test test/*.mjs`）也不算：读者本来就在包里。
 *
 * 返回 `{ hits, examined }`。`examined` 是"看了多少条像命令的行"，接线处拿它防沉默 ——
 * 规则看着在跑、其实一条都没匹配上，是最难发现的坏法（第 49～51 轮那套）。
 */
const CMD_VERB = /^(?:bash|sh|node|pnpm|npx|dsh|butler|npm|cd)\b/;
const CMD_REPO_PATH = /(?:^|[\s`"'(=])(?:\.\/)?(?:packages|scripts|apps)\/[A-Za-z0-9_./-]+/;
/**
 * ② 另一种"照着敲"的形状：**本身就是脚本路径，后面跟开关** —— 没有 `bash` 这种动词。
 *
 * 第 53 轮真机发现的那个洞就是这个形状：表格里写着 `` `probe/run.sh --save` ``（源码树/包根才
 * 够得着）。光看动词抓不住它 —— 拿第 53 轮**之前**的手册试过：窄口径 0 处、这一条 2 处。
 * 要求带 `--` 开关是关键：散文里提一句 `packages/cli/test/x.mjs` 不会带开关，别误报。
 */
const CMD_BARE_SCRIPT = /^(?:\.\/)?(?:packages|scripts|apps|probe)\/[A-Za-z0-9_./-]*\.(?:sh|mjs|js)\s+--/;
const CMD_MARK = /源码树|发行包|装完之后|仓库根|clone|克隆|开发/;

/** 这一行像不像"让人照着敲的命令" */
const looksLikeCommand = (t) => CMD_BARE_SCRIPT.test(t) || (CMD_VERB.test(t) && CMD_REPO_PATH.test(t));

function sourceTreeCommandViolations(text) {
  const hits = []; // 每项 { line, text } —— 报错要指到**行**（第 55 轮）
  let examined = 0;
  let inFence = false;
  let block = []; // 整块都留着：标记可能写在块里**任意一行**（那一行自己未必是命令）
  let cmds = []; // 块里"像命令且带仓库内路径"的行 —— 没标记时只报这些
  const flush = () => {
    // 报**第一条**命令所在的行（不是围栏那行 —— 围栏行读者打开文件会看错地方）
    if (cmds.length && !block.some((l) => CMD_MARK.test(l))) hits.push(cmds[0]);
    block = [];
    cmds = [];
  };
  for (const [i, line] of text.split('\n').entries()) {
    if (/^ {0,3}```/.test(line)) {
      if (inFence) flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      block.push(line);
      const t = line.trim();
      if (looksLikeCommand(t)) {
        examined++;
        cmds.push({ line: i + 1, text: t });
      }
      continue;
    }
    // ⚠️ **缩进块是在引用，不是在让你敲**。这份仓库的手册用四空格缩进贴"当年终端里长什么样"
    //    （第 410 行那种：`→ 先跑 \`bash …\`` 是历史输出的一部分）。改它会篡改记录，
    //    所以规则自己让开。实测：这样放掉的当前文档是 0 处，而第 53 轮那两处真命中一个不少。
    //    只在围栏**之外**让开 —— 围栏里的缩进是字面内容（手册的代码块正靠它）。
    if (/^ {4,}\S/.test(line)) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim();
      if (!looksLikeCommand(t)) continue;
      examined++;
      if (!CMD_MARK.test(line)) hits.push({ line: i + 1, text: t });
    }
  }
  flush();
  return { hits, examined };
}

/**
 * 哪些 md 算"用户会读的文档"：仓库门面 + 上手指南 + 各包的 README（后者跟着包发出去，
 * 装完的人在 `node_modules/@butler/<包>/README.md` 读到它）+ 飞书手册的**验收那一节**。
 *
 * ⚠️ `docs/CHANNEL-FEISHU.md` 整份是 2000 行开发史、通篇源码树视角，整份量会报上百条噪音，
 * 规则会变成没人看的红 —— 所以只取它收尾的「真机验收手册」（见 `userDocText`）。
 * 第 53 轮那个洞正是在那一节里发现的。
 */
const isUserDoc = (rel) =>
  rel === 'README.md' ||
  rel === 'docs/GETTING-STARTED.md' ||
  rel === 'docs/CHANNEL-FEISHU.md' ||
  /^packages\/[^/]+\/README\.md$/.test(rel);

/**
 * 只看这份文档里"给用户的那一段"。除了飞书手册，别的整份都算。
 *
 * 那一节是**给用户照着做**的（装完的人会在 README 和 doctor 的输出里被指到这里）；
 * 它前面的开发史不是 —— 那里写 `packages/…` 是叙述，不是让人敲。
 *
 * ⚠️ 返回 `{ text, offset }`：`offset` 是**切掉了前面多少行**。第 55 轮加行号时踩到的 ——
 * 从切片里数出来的行号是**相对**的，直接报出去会指向别处（比不报行号更坏：
 * 读者会去那一行找一个根本不在那儿的命令）。所以报错时必须 `offset + 行号`。
 */
function userDocText(rel, text) {
  if (rel !== 'docs/CHANNEL-FEISHU.md') return { text, offset: 0 };
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## 十二/.test(l));
  if (start === -1) return { text: '', offset: 0 }; // 那节没了：宁可一条都不看
  const end = lines.slice(start + 1).findIndex((l) => /^## /.test(l));
  const stop = end === -1 ? lines.length : start + 1 + end;
  return { text: lines.slice(start, stop).join('\n'), offset: start };
}

/**
 * 指向**本仓**的完整地址，路径得真在仓库里（`blob` ⇒ 文件，`tree` ⇒ 目录）。
 *
 * 第 41 轮把这条规矩写进过文档：「手册那个地址指向的文件必须真在仓库里」。这次让它是个**检查** ——
 * 而且第 50 轮我自己刚写了 14 个这种地址，正好需要有人盯着（写错一个字符，读者点开就是 404，
 * 而本地什么都不会响）。只认 `main` 这一支：认 tag 就得联网或翻 git 历史，不值当。
 *
 * `exists(kind, path)` 由调用方注入 —— 纯函数，自检可以喂假数据（第 48/49 轮那套）。
 */
const SELF_REPO = /^https:\/\/github\.com\/Leowuqunqun\/ai-butler\/(blob|tree)\/main\/([^)#]+)/;

function selfRepoUrlViolations(text, exists) {
  const hits = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const mm = SELF_REPO.exec(m[1]);
    if (!mm) continue;
    if (!exists(mm[1], mm[2])) hits.push(m[1]);
  }
  return hits;
}

/** 这些是**规则自己的承诺**（改规则就把这里一起改，改不了说明你改的是承诺） */
const SELF_TEST = [
  { why: '指向别的包（npm 读者够不着）', file: 'packages/a/README.md', link: '../b/README.md', shipped: ['README.md'], want: 1 },
  { why: '指向仓库根（更够不着）', file: 'packages/a/README.md', link: '../../docs/x.md', shipped: ['README.md'], want: 1 },
  { why: '同包内、也出包', file: 'packages/a/README.md', link: 'docs/x.md', shipped: ['README.md', 'docs/x.md'], want: 0 },
  { why: '同包内、没出包（test/ 里的）', file: 'packages/a/README.md', link: 'test/x.ts', shipped: ['README.md'], want: 1 },
  { why: '完整地址永远算够得着', file: 'packages/a/README.md', link: 'https://github.com/o/r/blob/main/docs/x.md', shipped: ['README.md'], want: 0 },
  { why: '同文件内的锚点不算跨文件', file: 'packages/a/README.md', link: '#小节', shipped: ['README.md'], want: 0 },
  { why: '子目录里的 md 也按包根算', file: 'packages/a/docs/y.md', link: '../../b/z.md', shipped: ['docs/y.md'], want: 1 },
];

/** 本仓地址那条的承诺：blob 要指向文件、tree 要指向目录，都得真在 */
const URL_TEST = [
  { why: 'blob 指向真文件', url: 'https://github.com/Leowuqunqun/ai-butler/blob/main/README.md', want: 0 },
  { why: 'blob 指向不存在的路径', url: 'https://github.com/Leowuqunqun/ai-butler/blob/main/docs/nope.md', want: 1 },
  { why: 'blob 写成了目录（差一个词）', url: 'https://github.com/Leowuqunqun/ai-butler/blob/main/packages/cli', want: 1 },
  { why: 'tree 指向真目录', url: 'https://github.com/Leowuqunqun/ai-butler/tree/main/packages/cli', want: 0 },
  { why: 'tree 写成了文件', url: 'https://github.com/Leowuqunqun/ai-butler/tree/main/README.md', want: 1 },
  { why: '别人的仓库不管（那是外部世界）', url: 'https://github.com/o/r/blob/main/nope.md', want: 0 },
  { why: '本仓的 tag 链接不在范围里', url: 'https://github.com/Leowuqunqun/ai-butler/blob/v0.2.1/README.md', want: 0 },
];

/** 「照着敲的命令」那条的承诺：报几处，以及**看了几条**（防沉默） */
const CMD_TEST = [
  { why: '源码树命令、块里没标记', text: '```bash\nbash packages/a/probe/run.sh\n```', want: 1, examined: 1, wantLine: 2 },
  { why: '块里写了"源码树里"', text: '```bash\nbash packages/a/probe/run.sh  # 源码树里\n```', want: 0, examined: 1, wantLine: null },
  {
    why: '标记在块**外面**（引用里）—— 读者翻到这儿看不见',
    text: '> 上面是源码树里的写法\n\n```bash\nbash packages/a/probe/run.sh --save\n```',
    want: 1,
    examined: 1, wantLine: 4,
  },
  { why: '行内代码、同行没标记', text: '先跑 `bash packages/a/probe/run.sh --save` 就行', want: 1, examined: 1, wantLine: 1 },
  { why: '行内代码、同行说清了', text: '源码树里跑 `bash packages/a/probe/run.sh --save`', want: 0, examined: 1, wantLine: null },
  { why: '不带仓库内路径的命令（butler run 在哪儿都能敲）', text: '```bash\nbutler run\n```', want: 0, examined: 0, wantLine: null },
  { why: '包内相对路径不算（读者就在包里）', text: '```bash\nnode --test test/*.mjs\n```', want: 0, examined: 0, wantLine: null },
  { why: '散文里提到路径不算让人敲', text: '实现放在 packages/a/src/x.ts 里，见下节。', want: 0, examined: 0, wantLine: null },
  {
    why: '同块里**另一行**有标记也算（微信 README 那种）',
    text: '```bash\npnpm test  # 在仓库根目录跑全部包\ncd packages/a && node --test test/*.mjs\n```',
    want: 0,
    examined: 1, wantLine: null,
  },
  {
    why: '两个块、只有一个带标记',
    text: '```bash\nbash packages/a/p.sh\n```\n\n```bash\nbash packages/a/p.sh --save  # 源码树里\n```',
    want: 1,
    examined: 2, wantLine: 2,
  },
  {
    why: '飞书手册：开发史那部分不算（§十二 之前）',
    doc: 'docs/CHANNEL-FEISHU.md',
    text: '## 一、开发\n\n```bash\nbash packages/a/p.sh\n```\n\n## 十二、真机验收\n\n```bash\nbutler run\n```',
    want: 0,
    examined: 0, wantLine: null,
  },
  {
    why: '飞书手册：§十二 里面要算',
    doc: 'docs/CHANNEL-FEISHU.md',
    text: '## 一、开发\n\n```bash\nbash packages/a/p.sh\n```\n\n## 十二、真机验收\n\n```bash\nbash packages/a/p.sh --save\n```',
    want: 1,
    examined: 1, wantLine: 10,
  },
  {
    why: '别的文档整份都算',
    doc: 'README.md',
    text: '## 一、开发\n\n```bash\nbash packages/a/p.sh\n```',
    want: 1,
    examined: 1, wantLine: 4,
  },
  {
    why: '第 53 轮那个形状：裸脚本路径 + 开关，没有动词、也没标记',
    text: '| 报错 | 怎么办 |\n| --- | --- |\n| `code: 10003` | 重扫：`probe/run.sh --save` |',
    want: 1,
    examined: 1, wantLine: 3,
  },
  { why: '裸脚本路径 + 开关，但同行说了"源码树里"', text: '源码树里：`probe/run.sh --save`', want: 0, examined: 1, wantLine: null },
  {
    why: '散文里提一个测试文件名：不是让人敲（没开关）',
    text: '这两条测试盯着它：`packages/cli/test/probe-contract.mjs` 和 `packages/cli/test/real-composition.mjs`。',
    want: 0,
    examined: 0, wantLine: null,
  },
  {
    why: '缩进块里贴的"当年终端输出"：那是记录，不是让人敲',
    text: '修完之后同一个空配置：\n\n    ✗  飞书登录态    还没有填 app_id / app_secret\n        → 先跑 `bash packages/a/probe/run.sh --save`；…',
    want: 0,
    examined: 0, wantLine: null,
  },
];

/** 自检用的假仓库：路径 → 是文件还是目录。谓词按它回答，跟真实现同一套语义 */
const FAKE_REPO = { 'README.md': 'file', 'packages/cli': 'dir' };
const fakeExists = (urlKind, path) => {
  const kind = FAKE_REPO[path];
  if (!kind) return false;
  return urlKind === 'blob' ? kind === 'file' : kind === 'dir';
};

function runSelfTest() {
  const bad = [
    ...SELF_TEST.map((c) => ({
      ...c,
      got: shippedDocViolations(c.file, `[t](${c.link})`, new Set(c.shipped)).length,
      shown: `${c.file} → ${c.link}`,
    })),
    ...URL_TEST.map((c) => ({
      ...c,
      got: selfRepoUrlViolations(`[t](${c.url})`, fakeExists).length,
      shown: c.url,
    })),
    ...CMD_TEST.map((c) => {
      const { text, offset } = userDocText(c.doc ?? 'README.md', c.text);
      const r = sourceTreeCommandViolations(text);
      // ⚠️ 行号要加回切片偏移 —— 否则飞书手册那几条会指到开发史里去
      const gotLine = r.hits.length ? offset + r.hits[0].line : null;
      return {
        ...c,
        got: r.hits.length,
        shown: JSON.stringify(c.text).replace(/\\n/g, '⏎'),
        // 报了几处对、但"看了几条"或"报在第几行"不对，也是规则坏了。
        whyWrong:
          (r.examined === c.examined ? '' : `（另外：像命令的行应该看 ${c.examined} 条，实际 ${r.examined} 条）`) +
          (gotLine === c.wantLine ? '' : `（行号应该 ${c.wantLine}，实际 ${gotLine}）`),
      };
    }),
  ].filter((c) => c.got !== c.want || c.whyWrong);

  if (!bad.length) return;
  console.error('文档体检：**规则自己坏了**（不是仓库里的文档有问题）。\n');
  for (const c of bad) {
    console.error(`  ${c.why}：应该 ${c.want} 处，实际 ${c.got} 处${c.whyWrong ?? ''}`);
    console.error(`    ${c.shown}`);
  }
  console.error('\n改法：这是 scripts/check-docs.mjs 里 shippedDocViolations / selfRepoUrlViolations /');
  console.error('sourceTreeCommandViolations 的规则被改动了。要是故意放宽/收紧，请把 SELF_TEST /');
  console.error('URL_TEST / CMD_TEST 一起改，并在 docs/CHANNEL-FEISHU.md 里写清楚为什么。');
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log(
    `文档体检：规则自检 ${SELF_TEST.length + URL_TEST.length + CMD_TEST.length} 条 → ✅ 规则本身是好的`,
  );
  process.exit(0);
}

runSelfTest(); // 先确认"这把尺子"是好的，再拿它量仓库

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

// ───────────── ④ 出包文档里指向没出包的东西（范围从 package.json 现算） ─────────────

let shippedBad = 0;
const shippedCache = new Map();
for (const file of files) {
  const m = /^packages\/([^/]+)\//.exec(file);
  if (!m) continue;
  const pkgRoot = `packages/${m[1]}`;
  if (!shippedCache.has(pkgRoot)) shippedCache.set(pkgRoot, shippedSetOf(pkgRoot));
  const shipped = shippedCache.get(pkgRoot);
  if (!shipped.has(relative(pkgRoot, file))) continue; // 这份 md 自己就不出包（比如 test/ 里的）
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  for (const raw of shippedDocViolations(file, text, shipped)) {
    problems.push(
      `❌ 出包文档里指向了没出包的东西  ${file}\n       → ${raw}\n` +
        '       （npm 页面上的相对链接是按"包"解析的，跨包的相对路径到了那边就是死链；换完整地址）',
    );
    shippedBad++;
  }
}

// ───────────── ⑤ 指向本仓的完整地址，路径得真在（第 41 轮写下的规矩，第 50 轮做成检查） ─────────────

let selfUrlBad = 0;
/** blob ⇒ 得是文件；tree ⇒ 得是目录 */
const reallyExists = (kind, path) => {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) return false;
  return kind === 'blob' ? statSync(abs).isFile() : statSync(abs).isDirectory();
};
for (const file of files) {
  const text = readFileSync(resolve(ROOT, file), 'utf8');
  for (const url of selfRepoUrlViolations(text, reallyExists)) {
    problems.push(
      `❌ 指向本仓的完整地址，在仓库里找不到  ${file}\n       → ${url}\n` +
        '       （本地看着没问题是因为它只是个字符串；推上去读者点开就是 404）',
    );
    selfUrlBad++;
  }
}

// ───────── ⑥ 用户文档里"照着敲"的命令，路径得够得着（第 54 轮，从真机那次洞里来） ─────────

let cmdBad = 0;
let cmdExamined = 0;
for (const file of files) {
  if (!isUserDoc(file)) continue;
  const { text, offset } = userDocText(file, readFileSync(resolve(ROOT, file), 'utf8'));
  const { hits, examined } = sourceTreeCommandViolations(text);
  cmdExamined += examined;
  for (const hit of hits) {
    problems.push(
      `❌ 让读者照抄的命令，路径只在源码树里成立  ${file}:${offset + hit.line}\n       → ${hit.text}\n` +
        '       （`install.sh` 装出来的人没有 `packages/`：包在 `~/.butler/prefix/app/node_modules` 里，' +
        '照抄只会得到 `No such file or directory`。在这条命令后面写一句"源码树里"，' +
        '或者换成他真能敲的那条）',
    );
    cmdBad++;
  }
}
// 防沉默：这条规则要是因为写法一变就再也匹配不上，它看起来还是绿的。
if (!problems.length && cmdExamined === 0) {
  problems.push(
    '❌ 规则 ⑥ 一条"照着敲的命令"都没看到\n' +
      '       → 用户文档里一定有几条。检查 CMD_VERB / CMD_REPO_PATH，别让它空转。',
  );
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
    ? `❌ 断链 ${broken}、锚点 ${badAnchor}、被忽略 ${ignored}、围栏 ${oddFence}、出包链接 ${shippedBad}、本仓地址 ${selfUrlBad}、照抄命令 ${cmdBad}、结构 ${h2Mismatch}、缺切换链接 ${noSwitch}`
    : `✅ 链接有效、都在版本库里、围栏成对、出包文档的链接读者够得着、本仓地址指得到、照抄的命令路径够得着（看了 ${cmdExamined} 条）、双语结构对齐（规则自检 ${SELF_TEST.length + URL_TEST.length + CMD_TEST.length} 条通过）`),
);
process.exit(problems.length ? 1 : 0);
