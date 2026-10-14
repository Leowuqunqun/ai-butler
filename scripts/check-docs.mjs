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
 * ⑥ 出处要跟得上：飞书手册开篇就承诺「本清单里每条事实都能点回**原文**」，并给了一套标注
 *    （`✓官方` / `⚙源码` / `△推断` / `?未核实` / `▣实测`）。
 *
 * 第 65 轮把这句话做成规则，是因为第十二节那张表里真出现过两种"说得比证据满"的写法：
 *   · 「官方原文：…」**没带任何标注** —— 读者分不出这句是官方文档抄来的，还是我们自己猜的；
 *   · 「原话是实测抓到的」—— 那是**我们自己跑出来的**，却连个轮次都不指，回去找不到那次运行。
 *
 * 两条规则，都按**块**判（表格行各自成一块、其余按空行分段 —— 一个表格里 A 行的 ✓ 不该救 B 行）：
 *   R1 含「官方原文：」的块 ⇒ 块内要有标注；
 *   R2 含 `▣实测` 的块 ⇒ 要写「第十一节第 K 轮」，**而且那个 K 真在**第十一节里有小节
 *      （所以它同时挡住"轮次号写错"—— 指路指到一个不存在的地方，比不指更坏）。
 *
 * ⚠️ **射程写在这儿，不靠猜**：R1 只挡"一个标注都没有"，挡不住"这行另有一个不相干的 ✓"
 *    （表格里 ✓/✗ 到处都是；实测：开头那张对照表里有一行就是靠裸 ✓ 表意的，它在上下文里毫无歧义）。
 *    ⚠️ 这里**故意不写行号**：写行号就得跟着文档一起改，而我这轮给前言加了一行之后，
 *    原先引的三处行号当场全过期了 —— 会烂的数字不写，就不用给它配检查器（第 64 轮那条教训）。
 *    要更严就得让标注长得独一无二 —— 那属于改约定，不归这条规则管。R2 则是精确的。
 * ⚠️ 第一版还写了个"定义标记那一行不算数"的豁免（开头那句「**▣实测**＝…」是在**解释**标记，
 *    当然没有轮次可指 —— 这是它第一次跑出来的唯一一条，一个假警报）。**划定切片之后它就没用了**：
 *    那句定义在前言里，本来就不在这一段视野内。死掉的豁免连同它的夹具一起删了 ——
 *    留一个"有夹具假装覆盖着的死代码"，比没有更坏。
 *
 * ⚠️ **只看切片、且行号是相对的**：调用处传进来的是「给用户的那一段」（飞书手册 = 第十二节），
 *    所以报错时**必须** `offset + 行号` —— 第 55 轮在规则 ⑥ 上踩过：从切片里数出来的行号直接报出去，
 *    读者会去那一行找一个根本不在那儿的东西（比不报行号更坏）。`rounds` 从**整份**文档现算：
 *    轮次小节都在第十一节，不在这个切片里。
 *
 * 返回 `{ hits, examined }`；`examined` 是"看了多少条出处声明"，接线处拿它防沉默 ——
 * 一条都没匹配上的规则和没写没区别（第 49～51 轮那套）。
 */
const PROV_MARK = /✓官方|✓|⚙源码|⚙|△推断|△|\?未核实/;
const MEASURED = /▣实测/;
const ROUND_HEAD = /^### 第 (\d+) 轮/gm;
/** 块里**任何一个**「第 K 轮」—— 一旦这个块提到了第十一节，就全都算指路（见下） */
const ROUND_ANY = /第\s*(\d+)\s*轮/g;

function provenanceViolations(text, rounds) {
  const hits = [];
  let examined = 0;
  const blocks = [];
  let cur = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (line.startsWith('|')) {
      if (cur.length) { blocks.push(cur); cur = []; }
      blocks.push([[i, line]]);
      continue;
    }
    if (line.trim() === '') { if (cur.length) { blocks.push(cur); cur = []; } continue; }
    cur.push([i, line]);
  }
  if (cur.length) blocks.push(cur);

  for (const block of blocks) {
    const joined = block.map(([, l]) => l).join('\n');
    const line = block[0][0] + 1;
    if (joined.includes('官方原文：')) {
      examined++;
      if (!PROV_MARK.test(joined)) {
        hits.push({ line, text: '「官方原文：」没带出处标注（✓官方 / ⚙源码 / △推断 / ?未核实）' });
      }
    }
    if (MEASURED.test(joined)) {
      examined++;
      // ⚠️ 只认「第十一节第 K 轮」是不够的：真有人会写"见第十一节第 53 轮、第 99 轮"，
      //    省略写法里那个 99 就会被**静默放过** —— 守卫上多出一个看不见的洞。
      //    所以只要这个块提到了「第十一节」，块里**每一个**「第 K 轮」都当作指路、都要真存在。
      const cites = joined.includes('第十一节')
        ? [...joined.matchAll(ROUND_ANY)].map((m) => Number(m[1]))
        : [];
      const bad = cites.filter((k) => !rounds.has(k));
      if (!cites.length) hits.push({ line, text: '`▣实测` 没写「第十一节第 K 轮」—— 回去找不到那次运行' });
      else if (bad.length) hits.push({ line, text: `\`▣实测\` 指的轮次在第十一节里不存在：第 ${bad.join('、')} 轮` });
    }
  }
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
// ───────── ⑧ 用户面文档里的"数"得跟仓库对上（第 73 轮） ─────────
//
// 为什么范围**写死**成这两份 README：它们里面的数是**给用户看的承诺** ——
// "全仓九百多个离线测试"、"18 张图"、"装哪个 release"。而 docs/CHANNEL-FEISHU.md 里
// 那些 `v0.2.0` 是**历史记录**（"第 34 轮那次发布"），是有意留着的。
// 拿一把尺子全仓扫，它立刻就变成一台误报机器 —— 这个文件下面那条注释记着同一个教训：
// **"一个会误报的守卫比没有守卫更糟"**。所以宁可少查，不要乱报。
//
// ⚠️ 这里查的是**文档 ↔ 仓库**（`packages/cli/package.json` 的版本、`docs/diagrams` 下
//    真有几张 .svg），**不是** zh ↔ en。上面放弃的是后者（分词差异、译文天然多一个数字），
//    那些噪声在这儿不存在：两边各自跟**事实**比。
// ⚠️ 第 74 轮把**安装指令**那半从"只查根 README"放宽到"查所有 README.md" ——
//    因为 `packages/dsh-plugin/README.md` 里钉着 `v0.1.0`（落后两个版本），而根 README
//    的守卫够不着它。**没有**一并放宽"图数"那半：它只认**以 `docs/` 开头的那一行**，
//    `docs/diagrams/README.md` 里的"18 张 / 17 张"说的是另一件事（总图数 / overview 之外
//    的张数），锚不上、也不该锚。放宽一半、留一半，是有意的。
// ⚠️ 一开始写成 `f === 'README.md' || f.endsWith('/README.md')`，把 `README.en.md` **漏了** ——
//    证据是「看了几条」从 4 掉到 3。所以下面那个防沉默阈值写死成 ≥4，专门拦这一类。
const isReadme = (f) => /(^|\/)README(\.[a-z]{2})?\.md$/.test(f);

function staleCountViolations(text, { version, svgCount }) {
  const hits = [];
  let examined = 0;
  text.split('\n').forEach((line, i) => {
    // ① 安装指令里的 release tag 必须是当前版本
    for (const m of line.matchAll(/releases\/download\/(v\d+\.\d+\.\d+)\//g)) {
      examined++;
      if (m[1] !== `v${version}`) {
        hits.push({
          line: i + 1,
          text: line.trim(),
          why: `安装指令指向 ${m[1]}，而当前版本是 v${version} —— 照着这行装的人拿到的是旧包`,
        });
      }
    }
    // ② 「docs/ …… N 张图」得等于 docs/diagrams 下真有的 .svg 数
    //    ⚠️ 锚在**以 docs/ 开头的那一行**上：README 的示例对话里也有一句"32 张图"
    //    （那是用户的照片），不锚行首就会把它当成本仓的图。
    // ⚠️ 结尾**不能**加 \b：`图` 在 JS 正则里是非词字符，后面跟 `，` 或行尾也非词，
    //    `\b` 于是永远不成立 —— 这条夹具当场把它抓出来了（该看 1 条、实际 0 条）。
    const g = /^\s*docs\/\s.*?(\d+)\s*(?:张图|diagrams)/.exec(line);
    if (g) {
      examined++;
      if (Number(g[1]) !== svgCount) {
        hits.push({
          line: i + 1,
          text: line.trim(),
          why: `说 docs/ 有 ${g[1]} 张图，而 docs/diagrams 下真有 ${svgCount} 张 .svg`,
        });
      }
    }
  });
  return { hits, examined };
}

// ───────── ⑨ 中英两版的"包清单"必须说同一件事（第 74 轮） ─────────
//
// 第 74 轮量出来：`docs/ARCH-technical.md` 那棵树一直被维护着（14 个需要数字的包里 12 个是对的），
// 而 `docs/ARCH-technical.en.md` 那棵**从某个版本起就没人动过** —— core 还写着 92、wechat 130、
// link-tailscale 22、cli 196，`dsh-plugin` **整行都没有**，`seam-approval` / `approval-im` 没数。
// 也就是说：**英文读者看到的是一份几个月前的架构**，而他不会知道。
//
// ⚠️ 这和上面那段**放弃**了的"中英数字必须一样"**不是同一件事**，别搞混：
//   · 那段比的是**整篇散文里的所有数字** —— 分词差异、`## 1.` 这种编号、译文里合法多出的
//     数字（`32 张图` + `(32 images …)`）都会误报，所以放弃了；
//   · 这条只比**一个围栏代码块里的树**：每行形状固定成 `├── 包名/ …… N 个测试` / `N tests`。
//     有噪声的地方一个字都不碰，只碰这个**结构**。
// 一个会误报的守卫比没有守卫更糟 —— 所以这条宁可窄到只覆盖一个代码块。
//
// ⚠️ 它拦得住什么、拦不住什么，说清楚：
//   · 拦得住：一边加了包另一边没加、一边改了数另一边没改、一边有数另一边没数；
//   · **拦不住**：两边**一起**错（比如两个都还写着旧数）。后者只能靠人 —— 或者靠
//     某天有人真的拿 `pnpm test` 去对。所以它只是把"一半的时间差"变成红灯，不是真理。
const ARCH_PAIR = { zh: 'docs/ARCH-technical.md', en: 'docs/ARCH-technical.en.md' };

/** 从第一个围栏块里抓 包名 → 测试数（没写数就是 null） */
function treeOf(text, countPat) {
  const out = new Map();
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.trim() === '```') {
      inside = !inside;
      if (!inside && out.size) break;
      continue;
    }
    if (!inside) continue;
    const row = /[├└]──\s*([a-z0-9-]+)\//.exec(line);
    if (!row) continue;
    const n = new RegExp(countPat).exec(line);
    out.set(row[1], n ? Number(n[1]) : null);
  }
  return out;
}

function pairedTreeViolations(zhText, enText) {
  const zh = treeOf(zhText, '(\\d+)\\s*个测试');
  const en = treeOf(enText, '(\\d+)\\s*tests?');
  const hits = [];
  for (const [k, v] of zh) {
    if (!en.has(k)) hits.push({ text: k, why: `中文树里有 \`${k}\`，英文树里没有这一行` });
    else if (en.get(k) !== v) {
      hits.push({ text: k, why: `同一个包 \`${k}\`，中文写 ${v ?? '（没数）'}、英文写 ${en.get(k) ?? '（没数）'}` });
    }
  }
  for (const k of en.keys()) {
    if (!zh.has(k)) hits.push({ text: k, why: `英文树里有 \`${k}\`，中文树里没有这一行` });
  }
  return { hits, examined: zh.size + en.size };
}

// ───────── ⑩ 精确的"当时多少测试"必须带时间锚（第 75 轮） ─────────
//
// 第 73/74 轮定下的政策是：**会烂的精确数换成量级**（`九百多个`），**历史记录则加时间锚**。
// 但这条政策一直没人守。第 75 轮把它写下来时，同一类缺陷一次冒出四处：
//   · `README.en.md` 的包树里 `channel-feishu ... 50 offline tests` —— 中文那侧早就换成了
//     "八十多个离线用例"（第 73 轮），英文那侧**没人动**；
//   · `README.en.md` / `VISION.en.md` 的 M0 行写着 `19 offline tests` / `Done, 19 offline tests`，
//     而中文两处都有"当时"（`当时 19 个离线测试` / `已完成（当时 19 个离线测试）`）。
//     ⚠️ 注意行里的 `Done` **不算锚**：它说的是"这个里程碑完成了"，不是"这个数是当时的"。
//
// 规则：`README*.md` 和 `docs/VISION*.md` 里，**出现精确测试数的那一行必须同时出现时间锚**
//（`当时` / `at the time`）。要么它是量级（`eighty-odd offline cases`，没有精确数字，天然通过），
// 要么它带着"这是当时"的字样。
//
// ⚠️ 范围**故意不含** `docs/ARCH-technical*.md`：那棵树里的 `166 个测试` 是**精确且当前**的，
//    由规则 ⑨ 盯着两边一致、由人维护。这不是"历史记录"，不该被这条规则逼着加锚。
// ⚠️ 也**不含**各包自己的 README：那里 `test/smoke.mjs（25 个）` 这种分文件计数是**当前值**，
//    给每一行加"当时"是荒谬的。它们的政策是"只修不守"（见手册第 74 轮）。
const ANCHOR_FILES = ['README.md', 'README.en.md', 'docs/VISION.md', 'docs/VISION.en.md'];
const ANCHOR_WORDS = /当时|at the time/;
const EXACT_TEST_COUNT = /\d+\s*个(?:离线)?(?:测试|用例)|\b\d+\s+(?:offline\s+)?tests?\b/;

/** 只看第一行：一张表的一行就是一行 */
function unanchoredCountViolations(text) {
  const hits = [];
  let examined = 0;
  for (const line of text.split('\n')) {
    if (!EXACT_TEST_COUNT.test(line)) continue;
    examined++;
    if (ANCHOR_WORDS.test(line)) continue;
    hits.push({ text: line.trim().slice(0, 80), why: `这是一个精确的测试数，但没说"这是当时的"：${line.trim().slice(0, 70)}` });
  }
  return { hits, examined };
}

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

/** 出处那条的承诺：报几处、看了几条，以及**轮次号不存在**要报出来（指到空处比不指更坏） */
const PROV_TEST = [
  { why: '官方原文带标注', text: '官方原文：「x」✓官方', want: 0, examined: 1 },
  { why: '官方原文一个标注都没有', text: '官方原文：**x**，顺序反了就一直失败', want: 1, examined: 1 },
  {
    why: '同一个表格里 A 行没标注、B 行有个 ✓ —— B 不该救 A（表格行各自成块）',
    text: '| a | 官方原文：x |\n| b | ✓ |',
    want: 1, examined: 1,
  },
  { why: '▣实测 指了真存在的轮次', text: '（▣实测，见第十一节第 53 轮）', rounds: [53], want: 0, examined: 1 },
  { why: '▣实测 没指轮次', text: '（原话是实测抓到的）▣实测', rounds: [53], want: 1, examined: 1 },
  {
    why: '▣实测 指的轮次不存在 —— 指到空处比不指更坏',
    text: '▣实测，见第十一节第 99 轮', rounds: [53], want: 1, examined: 1,
  },
  { why: '▣实测 指了好几个轮次，只要有一个不存在就报', text: '▣实测，见第十一节第 53 轮、第 99 轮', rounds: [53], want: 1, examined: 1 },
  { why: '没声称出处：不看（这两条规则只管声称了出处的块）', text: '跑 butler doctor 就行。', want: 0, examined: 0 },
];

/** 自检用的假仓库：路径 → 是文件还是目录。谓词按它回答，跟真实现同一套语义 */
const FAKE_REPO = { 'README.md': 'file', 'packages/cli': 'dir' };
const fakeExists = (urlKind, path) => {
  const kind = FAKE_REPO[path];
  if (!kind) return false;
  return urlKind === 'blob' ? kind === 'file' : kind === 'dir';
};

// ── 规则 ⑧ 的夹具。⭐ 第 4、5 条是**关键**：它们钉住"范围"本身 ——
//    "示例对话里的 32 张图不算"、"零散提到的旧版本不算"，正是这两条让这把尺子不误报。
const COUNT_TEST = [
  {
    why: '版本和图数都对 → 不报',
    text: 'curl …/releases/download/v1.2.3/x.tar.gz\ndocs/   产品与技术架构、3 张图',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 0, examined: 2,
  },
  {
    why: '安装指令指向旧 release → 报',
    text: 'curl …/releases/download/v1.2.2/x.tar.gz',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 1, examined: 1,
  },
  {
    why: 'docs/ 那行的图数不对 → 报',
    text: 'docs/                  产品与技术架构、9 张图',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 1, examined: 1,
  },
  {
    why: '⭐ 示例对话里的"N 张图"不算（它说的是用户的照片）→ 不报',
    text: '管家（你的电脑）：「32 张图，按拍摄月份分成了 5 个文件夹。」',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 0, examined: 0,
  },
  {
    why: '⭐ 零散提到的旧版本（手册里的历史记录）不算 → 不报',
    text: '那一轮发的是 v0.2.0，附了 butler-dsh-plugin-0.2.0.tar.gz',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 0, examined: 0,
  },
  {
    why: '⭐ 包自己的 README 里钉旧版本也算（第 74 轮放宽到所有 README.md）',
    text: 'curl …/releases/download/v0.1.0/butler-dsh-plugin-0.1.0.tar.gz',
    ctx: { version: '1.2.3', svgCount: 3 },
    want: 1, examined: 1,
  },
];

/** 自检夹具的总条数。两处汇总都用它，免得改了一处忘了另一处 */
// ── 规则 ⑨ 的夹具
const TREE_TEST = [
  {
    why: '两棵树一模一样 → 不报',
    zh: '```\npackages/\n├── core/   # 内核（166 个测试）\n└── cli/    # 入口（274 个测试）\n```',
    en: '```\npackages/\n├── core/   # the kernel (166 tests)\n└── cli/    # the entry point (274 tests)\n```',
    want: 0,
  },
  {
    why: '⭐ 同一边改了数、另一边没改 → 报',
    zh: '```\npackages/\n├── core/   # 内核（166 个测试）\n```',
    en: '```\npackages/\n├── core/   # the kernel (92 tests)\n```',
    want: 1,
  },
  {
    why: '⭐ 一边加了包、另一边整行没有 → 报',
    zh: '```\npackages/\n├── core/   # 内核（166 个测试）\n├── dsh-plugin/  # 插件（37 个测试）\n```',
    en: '```\npackages/\n├── core/   # the kernel (166 tests)\n```',
    want: 1,
  },
  {
    why: '⭐ 一边有数、另一边没数 → 也报',
    zh: '```\npackages/\n├── seam-approval/  # 接口（7 个测试）\n```',
    en: '```\npackages/\n├── seam-approval/  # the interface\n```',
    want: 1,
  },
  {
    why: '两边都没写数的（规划中的包）→ 不报',
    zh: '```\npackages/\n├── hub/   # 规划中\n└── node/  # 规划中\n```',
    en: '```\npackages/\n├── hub/   # planned\n└── node/  # planned\n```',
    want: 0,
  },
];

// ── 规则 ⑩ 的夹具
const ANCHOR_TEST = [
  {
    why: '量级（没有精确数字）→ 不报',
    text: '| 全仓 | 九百多个离线测试，现跑现数：`pnpm test` |',
    want: 0, examined: 0,
  },
  {
    why: '精确数 + 中文时间锚 → 不报',
    text: '| **M0** | 通道层跑通 | 当时 19 个离线测试 | ✅ 已完成 |',
    want: 0, examined: 1,
  },
  {
    why: '精确数 + 英文时间锚 → 不报',
    text: '| **M0** | Channel layer works end to end | 19 offline tests at the time | ✅ Done |',
    want: 0, examined: 1,
  },
  {
    why: '⭐ 精确数 + 只有 `Done`（那是里程碑完成，不是时间锚）→ 报',
    text: '| **M0** | Channel layer works end to end | Done, 19 offline tests |',
    want: 1, examined: 1,
  },
  {
    why: '⭐ 精确数、什么都没带 → 报（第 75 轮 README.en.md 那行 `50 offline tests`）',
    text: 'channel-feishu/      📐 third channel: Feishu (...; 50 offline tests, inbound images land on disk)',
    want: 1, examined: 1,
  },
];

const RULE_FIXTURE_COUNT = () =>
  SELF_TEST.length + URL_TEST.length + CMD_TEST.length + PROV_TEST.length + COUNT_TEST.length + TREE_TEST.length + ANCHOR_TEST.length;

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
    ...PROV_TEST.map((c) => {
      const r = provenanceViolations(c.text, new Set(c.rounds ?? []));
      return {
        ...c,
        got: r.hits.length,
        shown: JSON.stringify(c.text).replace(/\\n/g, '⏎'),
        whyWrong:
          r.examined === c.examined
            ? ''
            : `（另外：像出处声明的块应该看 ${c.examined} 条，实际 ${r.examined} 条）`,
      };
    }),
    ...COUNT_TEST.map((c) => {
      const r = staleCountViolations(c.text, c.ctx);
      return {
        ...c,
        got: r.hits.length,
        shown: JSON.stringify(c.text).replace(/\\n/g, '⏎'),
        whyWrong:
          r.examined === c.examined
            ? ''
            : `（另外：像"数"的行应该看 ${c.examined} 条，实际 ${r.examined} 条）`,
      };
    }),
    ...ANCHOR_TEST.map((c) => {
      const r = unanchoredCountViolations(c.text);
      return { ...c, got: r.hits.length, examined: r.examined, shown: (r.hits[0] && r.hits[0].why) ?? '（都有锚）' };
    }),
    ...TREE_TEST.map((c) => {
      const r = pairedTreeViolations(c.zh, c.en);
      return { ...c, got: r.hits.length, shown: (r.hits[0] && r.hits[0].why) ?? '（两棵树一致）' };
    }),
  ].filter((c) => c.got !== c.want || c.whyWrong);

  if (!bad.length) return;
  console.error('文档体检：**规则自己坏了**（不是仓库里的文档有问题）。\n');
  for (const c of bad) {
    console.error(`  ${c.why}：应该 ${c.want} 处，实际 ${c.got} 处${c.whyWrong ?? ''}`);
    console.error(`    ${c.shown}`);
  }
  console.error('\n改法：这是 scripts/check-docs.mjs 里 shippedDocViolations / selfRepoUrlViolations /');
  console.error('sourceTreeCommandViolations / provenanceViolations / staleCountViolations / pairedTreeViolations / unanchoredCountViolations 的规则被改动了。');
  console.error('要是故意放宽/收紧，请把 SELF_TEST / URL_TEST / CMD_TEST / PROV_TEST / COUNT_TEST / TREE_TEST / ANCHOR_TEST 一起改，');
  console.error('并在 docs/CHANNEL-FEISHU.md 里写清楚为什么。');
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log(
    `文档体检：规则自检 ${RULE_FIXTURE_COUNT()} 条 → ✅ 规则本身是好的`,
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

// ───────────── ⑦ 出处要跟得上（第 65 轮：手册开头承诺过"每条事实都能点回原文"） ─────────────

let provBad = 0;
let provExamined = 0;
// ⚠️ 只对**声明了那套标注约定**的文档生效 —— 别的 md 没承诺过"每条事实都能点回原文"，
//    拿这把尺子去量它们是冤枉人。
const PROV_DOC = 'docs/CHANNEL-FEISHU.md';
for (const file of files) {
  if (file !== PROV_DOC) continue;
  const raw = readFileSync(resolve(ROOT, file), 'utf8');
  const { text, offset } = userDocText(file, raw);
  const rounds = new Set([...raw.matchAll(ROUND_HEAD)].map((m) => Number(m[1])));
  const { hits, examined } = provenanceViolations(text, rounds);
  provExamined += examined;
  for (const hit of hits) {
    problems.push(
      `❌ 出处跟原话对不上  ${file}:${offset + hit.line}\n       → ${hit.text}\n` +
        '       （这份手册开头写着"本清单里每条事实都能点回原文"并给了标注：✓官方 / ⚙源码 / ' +
        '△推断 / ▣实测 / ?未核实。声称了出处却不标、或者用 ▣实测 却不写是哪一轮跑出来的，' +
        '读者就没法判断这句话能不能信 —— 也没法自己回去复核）',
    );
    provBad++;
  }
}
// 防沉默：理由同规则 ⑥。
if (!problems.length && provExamined === 0) {
  problems.push(
    '❌ 规则 ⑦ 一条"出处声明"都没看到\n' +
      '       → 飞书手册里一定有几条（「官方原文：」和「▣实测」）。检查那两个正则，别让它空转。',
  );
}

// ───────── ⑧ 用户面文档里的"数"得跟仓库对上（第 73 轮） ─────────

const cliPkg = JSON.parse(readFileSync(resolve(ROOT, 'packages/cli/package.json'), 'utf8'));
const diagramDir = resolve(ROOT, 'docs/diagrams');
const svgCount = existsSync(diagramDir)
  ? readdirSync(diagramDir).filter((f) => f.endsWith('.svg')).length
  : 0;

let staleBad = 0;
let staleExamined = 0;
for (const file of files) {
  if (!isReadme(file)) continue;
  const raw = readFileSync(resolve(ROOT, file), 'utf8');
  const { hits, examined } = staleCountViolations(raw, { version: cliPkg.version, svgCount });
  staleExamined += examined;
  for (const hit of hits) {
    problems.push(
      `❌ 用户面文档里的"数"跟仓库对不上  ${file}:${hit.line}\n       → ${hit.text}\n` +
        `       （${hit.why}。这些数是**给用户看的承诺** —— 他要照着这行去装东西，或者据此判断` +
        '这仓库有多大。数过期不是"文字旧了"，是**读者会照着做错事**）',
    );
    staleBad++;
  }
}
// 防沉默：理由同规则 ⑥⑦。这两份 README 里一定既有安装指令、又有那张状态表。
// ⚠️ 阈值**不是 0 而是 4**：两份根 README 各有 2 条（一个 release URL + 一行「N 张图」），
//    再加上包 README 里的安装 URL。写成 `=== 0` 的话，范围被误缩到只剩一份 README 也照样绿 ——
//    第 74 轮就是这么把 `README.en.md` 漏掉的（数字从 4 掉到 3 才被发现）。
if (!problems.length && staleExamined < 4) {
  problems.push(
    `❌ 规则 ⑧ 只看了 ${staleExamined} 条「数」，太少\n` +
      '       → 两份根 README 各有 2 条（一个 `releases/download/v…` + 一行 `docs/ … N 张图`），包 README 里还有安装 URL。' +
      '检查 isReadme 和那两条正则，别让它空转或漏掉一份文档。',
  );
}

// ───────── ⑨ 中英两版的"包清单"必须说同一件事（第 74 轮） ─────────

let treeBad = 0;
let treeExamined = 0;
{
  const zhPath = resolve(ROOT, ARCH_PAIR.zh);
  const enPath = resolve(ROOT, ARCH_PAIR.en);
  if (existsSync(zhPath) && existsSync(enPath)) {
    const r = pairedTreeViolations(readFileSync(zhPath, 'utf8'), readFileSync(enPath, 'utf8'));
    treeExamined = r.examined;
    for (const hit of r.hits) {
      problems.push(
        `❌ 架构文档两棵"包树"对不上  ${ARCH_PAIR.zh} ↔ ${ARCH_PAIR.en}\n       → ${hit.why}\n` +
          '       （这两棵树是同一件事实的两种说法。一边改了另一边没改，那边的读者就会看到' +
          '一份**几个月前的架构** —— 而双语结构守卫只比二级标题的数量，拦不住这个）',
      );
      treeBad++;
    }
  }
}
// 防沉默：理由同规则 ⑥⑦⑧。两棵树加起来一定不止一两行。
if (!problems.length && treeExamined < 10) {
  problems.push(
    `❌ 规则 ⑨ 只看 ${treeExamined} 行"包树"\n       → 两棵加起来应该有二十来行。检查 treeOf 里那个围栏和行形状的正则。`,
  );
}

// ───────── ⑩ 精确的"当时多少测试"必须带时间锚（第 75 轮） ─────────

let anchorBad = 0;
let anchorExamined = 0;
for (const rel of ANCHOR_FILES) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) continue;
  const r = unanchoredCountViolations(readFileSync(abs, 'utf8'));
  anchorExamined += r.examined;
  for (const hit of r.hits) {
    problems.push(
      `❌ 精确的测试数没带时间锚  ${rel}\n       → ${hit.why}\n` +
        '       （政策见手册第 73/74 轮：会烂的精确数换成量级（`九百多个`），历史记录加时间锚（`当时`）。' +
        '⚠️ `Done` 不算锚 —— 它说的是里程碑完成了，不是"这个数是当时的"）',
    );
    anchorBad++;
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
    ? `❌ 断链 ${broken}、锚点 ${badAnchor}、被忽略 ${ignored}、围栏 ${oddFence}、出包链接 ${shippedBad}、本仓地址 ${selfUrlBad}、照抄命令 ${cmdBad}、出处 ${provBad}、用户面数字 ${staleBad}、包树 ${treeBad}、时间锚 ${anchorBad}、结构 ${h2Mismatch}、缺切换链接 ${noSwitch}`
    : `✅ 链接有效、都在版本库里、围栏成对、出包文档的链接读者够得着、本仓地址指得到、照抄的命令路径够得着（看了 ${cmdExamined} 条）、出处跟得上原话（看了 ${provExamined} 条）、用户面文档里的数跟仓库对得上（看了 ${staleExamined} 条）、架构包树中英对齐（看了 ${treeExamined} 行）、精确数都带时间锚（看了 ${anchorExamined} 条）、双语结构对齐（规则自检 ${RULE_FIXTURE_COUNT()} 条通过）`),
);
process.exit(problems.length ? 1 : 0);
