/**
 * `butler init` 的测试 —— 第一次用的人要走的那条路。
 *
 *   node --test test/setup.mjs
 *
 * 这里守的是一条产品上的硬要求：**用户不该手写配置文件**。
 * 所以用例不只问"文件写出来了没有"，还问三件更要紧的事：
 *
 *   ① 生成出来的配置**真的装得上**（六个插件、能力位齐）—— 名字写错一个字符，
 *      用户看到的是一句"装不上"，而他根本不知道那行字该长什么样；
 *   ② 跑第二次**一个字节都不写**（他已经加过设备、改过目录）；
 *   ③ 节点那台**没有通道**（同一个微信号被两个进程收信，消息会随机丢）。
 *
 * ⚠️ 单元用例一律把 `configPath` / `patchFile` 指到临时目录。不指的话
 * `init` 会往**用户真实的** `~/.butler` 里写东西 —— 测试不该污染用户的家。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  FALLBACK_PATCH, IM_LABEL, IM_NAMES, butlerHome, coreStateFileMissing, defaultConfigPath,
  defaultConfigText, defaultPatchPath, imOfChannelName, initButlerHome, patchTemplate,
} from '../lib/setup.js';
import { DEFAULT_KEY_REF, credentialsFileOf, keyRefOf } from '../lib/credentials.js';
import { runSync, tempHome } from './fixtures/node-helpers.mjs';
import { useButlerShim } from './fixtures/path-shim.mjs';

// `doctor` 会去问内核"管家自己找得到 butler 吗"（量的是**管家进程自己的** PATH）。
// 测试机上没有 butler，给它一个真 shim —— **改环境，不改判据**。
// ⚠️ 这里造绿不算数 —— 真正把关的是 scripts/verify-clean-install.sh（真装出来的进程）。
useButlerShim();

/** 引导页要写的那个引用名，必须就是模板里钉的那个 —— 两边分家就是"贴了也没用" */
test('引导页写的引用名 = 模板里钉的引用名', () => {
  assert.equal(keyRefOf(patchTemplate()), DEFAULT_KEY_REF);
  assert.equal(keyRefOf(FALLBACK_PATCH), DEFAULT_KEY_REF);
});

/** 一个用完就扔的家 */
function home() {
  return mkdtempSync(join(tmpdir(), 'butler-init-'));
}

const cfgIn = (dir) => join(dir, '.butler', 'config.json');
const patchIn = (dir) => join(dir, '.butler', 'dsh.patch.yml');

// ───────────────────────── 生成出来的东西 ─────────────────────────

test('默认配置：六行，名字和路径都是现成的，用户一个字都不用填', () => {
  const text = defaultConfigText({ workspace: '/tmp/我的电脑' });
  const parsed = JSON.parse(text);

  assert.deepEqual(parsed.plugins.map((p) => p.id), ['channel', 'agent', 'core', 'memory', 'approval', 'link']);

  const channel = parsed.plugins.find((p) => p.id === 'channel');
  assert.equal(channel.name, 'wechat-agent-bridge/plugin');
  // 登录态必须钉在家目录下 —— 不钉的话它落在"当前工作目录"，
  // 用户在哪个目录敲的 butler 就在哪儿，换个目录就要重新扫码
  assert.equal(channel.config.home, butlerHome());

  for (const row of parsed.plugins) {
    for (const [k, v] of Object.entries(row.config)) {
      if (typeof v === 'string' && v !== '') {
        assert.ok(v.startsWith('/'), `${row.id}.${k} 该是绝对路径，实际 ${v}`);
      }
    }
  }
});

test('选飞书：通道那一行换成 channel-feishu，两个字段留空', () => {
  const parsed = JSON.parse(defaultConfigText({ home: '/tmp/butler-home', im: 'feishu' }));
  const channel = parsed.plugins.find((p) => p.id === 'channel');

  assert.equal(channel.name, '@butler/channel-feishu');
  // 两个字段**留空行**：用户至少知道该往哪儿填。
  // 真值不走这个文件 —— 它只进 state/secrets.json（这份 config.json 是给人读的）
  assert.deepEqual(channel.config, { home: '/tmp/butler-home', appId: '', appSecret: '' });
  assert.ok(IM_NAMES.includes('feishu'), '--im feishu 得被认出来');
});

/**
 * `butler run` 上线那句里的 IM 名字 —— 第 91 轮真机验飞书时撞见它写死了「微信」。
 *
 * 两个方向都要钉：认得出时**说对名字**，认不出时**不猜**（宁可不说，也不能把人支到
 * 另一个 IM 里去等 —— 那边永远不会有消息）。
 */
test('上线那句说的 IM = 配置里实装的那条通道（认不出就不说）', () => {
  const row = JSON.parse(defaultConfigText({ home: '/tmp/h', im: 'feishu' }))
    .plugins.find((p) => p.id === 'channel');

  assert.equal(imOfChannelName(row.name), 'feishu');
  assert.equal(IM_LABEL.feishu, '飞书');

  // 三个 IM 都得有名字 —— 漏一个，那句就会打出一个 `undefined`
  for (const im of IM_NAMES) assert.equal(typeof IM_LABEL[im], 'string');

  // 认不出的（用户自己接的别的通道）不许猜
  assert.equal(imOfChannelName('some-other/plugin'), undefined);
  assert.equal(imOfChannelName(undefined), undefined);
});

test('节点那份配置：**没有通道**，也没有内核 —— 它不登录微信', () => {
  const parsed = JSON.parse(defaultConfigText({ node: true }));
  const ids = parsed.plugins.map((p) => p.id);

  assert.deepEqual(ids, ['agent', 'node']);
  // 这是硬性的：同一个微信号被两个进程同时长轮询，消息会随机分到两边，
  // 用户看到的是"有时回有时不回"，而两边日志都正常
  assert.ok(!ids.includes('channel'), '节点那份配置里出现 channel 是事故');
});

test('人格模板：那份约定必须在（它是产品行为，不是示例）', () => {
  const t = patchTemplate();
  assert.ok(t.length > 500, '人格模板不该是空的');
  // 四条一条都不能少：输出格式、发文件的方式、不许点界面、敏感操先问一声
  assert.match(t, /禁止 Markdown/);
  assert.match(t, /\[\[file:/);
  assert.match(t, /模拟鼠标键盘/);
  // 审批：ask（问进对话里）—— 绝不是 never（那等于管家什么都干不了）。
  // "问"这条路能不能走通，由下面那条钉应答者的用例盯着。
  // 记忆自动抽取：内核靠这条约定认「值得长期记住」的话，人格里少一句就整条失效
  assert.match(t, /\[\[记住[:：]/);
  assert.match(t, /policy: ask/);
});

// ───────────────────────── 写文件这件事 ─────────────────────────

test('init：把两份文件写好，权限 0600，目录 0700', () => {
  const dir = home();
  try {
    const r = initButlerHome({ configPath: cfgIn(dir), patchFile: patchIn(dir) });

    assert.equal(r.written.length, 2);
    assert.ok(existsSync(r.configPath));
    assert.ok(existsSync(patchIn(dir)));
    assert.equal(statSync(join(dir, '.butler')).mode & 0o777, 0o700);
    assert.equal(statSync(r.configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init：跑第二次**一个字节都不写** —— 用户改过的东西不能被抹掉', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  try {
    initButlerHome({ configPath: cfg, patchFile: patchIn(dir) });

    // 模拟"用户后来自己加了东西"
    const mine = '{ "plugins": [], "我自己加的": true }';
    writeFileSync(cfg, mine);

    const again = initButlerHome({ configPath: cfg, patchFile: patchIn(dir) });
    assert.deepEqual(again.written, []);
    assert.equal(again.kept.length, 2);
    assert.equal(readFileSync(cfg, 'utf8'), mine, '已有的配置一个字节都不该动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init：幂等 —— 连跑三次，只有第一次写了东西', () => {
  const dir = home();
  try {
    const opts = { configPath: cfgIn(dir), patchFile: patchIn(dir) };
    assert.equal(initButlerHome(opts).written.length, 2);
    assert.equal(initButlerHome(opts).written.length, 0);
    assert.equal(initButlerHome(opts).written.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init --node：给被遥控的那台写配置（两行，没有通道）', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  try {
    initButlerHome({ configPath: cfg, patchFile: patchIn(dir), node: true });
    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.deepEqual(parsed.plugins.map((p) => p.id), ['agent', 'node']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认路径就是 ~/.butler/ 下的那两个（不给 --config 时）', () => {
  const before = process.env.BUTLER_HOME;
  delete process.env.BUTLER_HOME; // 这条讲的是"没有那条环境变量时"的默认
  try {
    assert.equal(defaultConfigPath(), join(butlerHome(), 'config.json'));
    assert.equal(defaultPatchPath(), join(butlerHome(), 'dsh.patch.yml'));
  } finally {
    if (before !== undefined) process.env.BUTLER_HOME = before;
  }
});

test('★ 家跟着 BUTLER_HOME 走：默认配置/补丁路径都换到那个家里（空串＝没设）', () => {
  const before = process.env.BUTLER_HOME;
  const dir = home();
  try {
    process.env.BUTLER_HOME = dir;
    assert.equal(butlerHome(), dir, '设了 BUTLER_HOME，家就是它 —— 探针一直是这么认的');
    assert.equal(defaultConfigPath(), join(dir, 'config.json'));
    assert.equal(defaultPatchPath(), join(dir, 'dsh.patch.yml'));

    // 空串 / 空白 = 没设。**这一条防的是"被当成一个叫空字符串的家"**：
    // `BUTLER_HOME= butler run` 是很常见的写法（清掉它），不能因此把家搬到 ""。
    process.env.BUTLER_HOME = '   ';
    assert.equal(butlerHome(), join(homedir(), '.butler'));
    assert.equal(defaultConfigPath(), join(homedir(), '.butler', 'config.json'));
  } finally {
    if (before === undefined) delete process.env.BUTLER_HOME;
    else process.env.BUTLER_HOME = before;
  }
});

// ───────────────────────── 真命令、真进程 ─────────────────────────

test('★ 一个刚装好的家：init 一次 → doctor 说"就差登录微信了"', () => {
  // **这条是 M3 的核心验收**：装完、跑两条命令、别的什么都不用做。
  // doctor 会真的把五个插件装进容器（真解析、真门控），所以它同时证明了
  // "生成出来的配置是对的" —— 插件名字写错一个字符，这里就红。
  const dir = tempHome();

  const init = runSync(['init'], { home: dir });
  assert.equal(init.code, 0, `init 该成功。stdout:\n${init.out}\nstderr:\n${init.err}`);
  assert.ok(existsSync(join(dir, '.butler', 'config.json')), '配置该被写出来');
  assert.match(init.out, /butler run/, '要告诉他下一步做什么');
  assert.match(init.out, /模型 key/, '要告诉他第一次会问什么');
  assert.doesNotMatch(init.out, /打开 .*patch\.yml/, '别再让他去改那个 YAML 了');

  const doc = runSync(['doctor'], { home: dir });
  const both = `${doc.out}\n${doc.err}`;

  for (const name of ['channel', 'agent', 'core', 'memory', 'approval', 'link']) {
    assert.match(both, new RegExp(`✓\\s+${name}\\b`), `${name} 那一行该装上来：\n${both}`);
  }
  for (const slot of ['ctx.channel', 'ctx.agent', 'ctx.core']) {
    assert.match(both, new RegExp(`✓\\s+${slot.replace('.', '\\.')}`), `${slot} 该就位：\n${both}`);
  }
  // 还没好的就两件事，而且每件都要说清下一步
  assert.match(both, /微信登录态[\s\S]*用微信扫/);
  assert.match(both, /模型 key[\s\S]*还没有/, `该说 key 还没配：\n${both}`);
  assert.match(both, /模型 key[\s\S]*butler run/, 'key 那一条的修法要指到引导页');
  assert.doesNotMatch(both, /credential|apiKeyEnv|MISSING_CREDENTIAL/, '别把内部词抛给用户');
});

test('★ 导出的兜底补丁和随包发的那份，插件行必须一模一样（防漂移）', () => {
  // 兜底只在"模板读不到"时用（打包漏文件之类），平时没人看它 ——
  // 所以它最容易跟真模板悄悄分家：用户拿到一份没有模型通道的配置，
  // 表现是"agent 不说话"，而没有任何一行字指向真正的原因。
  const rowsOf = (text) => text.split('\n')
    .filter((l) => /^-\s+id\s*:/.test(l))
    .map((l) => l.replace(/^-\s+id\s*:\s*/, '').trim());

  const shipped = patchTemplate();
  assert.deepEqual(rowsOf(FALLBACK_PATCH), rowsOf(shipped), '兜底和真模板的插件行/顺序必须一致');
  for (const text of [FALLBACK_PATCH, shipped]) {
    assert.match(text, /apiKeyEnv: DEEPSEEK_API_KEY/, '两边都要钉住同一个引用名');
  }
});

test('★ 补丁把审批从"一律拒绝"改成"问进对话里"，并把应答者装上', () => {
  const text = patchTemplate();

  // ① 策略改成 ask：dsh 碰到敏感操作会向下问应答者
  assert.match(text, /- id: approval\n  config:\n    policy: ask/, '策略要改成 ask');
  assert.doesNotMatch(text, /policy: never/, '不该再钉 never（那等于管家什么也干不了）');

  // ② 应答者那一行必须在，而且它的 name 是**真的存在**的绝对路径 ——
  //    子进程要从这个路径 import 它。这条断言就是这根线的离线守卫。
  const rows = text.split('\n').filter((l) => /^-\s+id\s*:/.test(l))
    .map((l) => l.replace(/^-\s+id\s*:\s*/, '').trim());
  assert.ok(rows.includes('approval-answerer'), `要装上应答者，实际的行：${rows.join(', ')}`);

  const m = text.match(/- id: approval-answerer\n\s+name: '([^']+)'/);
  assert.ok(m, '应答者那一行要有 name');
  assert.ok(m[1].startsWith('/'), `必须是绝对路径，实际是 ${m[1]}`);
  assert.ok(existsSync(m[1]), `这个路径得真的存在：${m[1]}`);
  assert.match(text, /home: '/, '要把管家目录一起告诉它 —— 两边必须是同一个目录');
});

test('init 再跑一次：说"已经有了，没动"，而不是又写一遍', () => {
  const dir = tempHome();
  runSync(['init'], { home: dir });

  const again = runSync(['init'], { home: dir });
  assert.equal(again.code, 0);
  assert.match(again.out, /已经有了，没动/);
});

test('没有配置就跑 run：给一行**能直接抄**的命令，而不是"文件不存在"', () => {
  const dir = tempHome();
  const r = runSync(['run'], { home: dir });

  assert.equal(r.code, 1);
  assert.match(r.err, /还没有配置/);
  assert.match(r.err, /butler init\b/, '要给出确切的那一行');
  assert.doesNotMatch(r.err, /ENOENT|堆栈|at .*\.js:/, '不要拿一个栈吓他');
});

test('没有配置就跑 node：给的那一行带 --node', () => {
  const dir = tempHome();
  const r = runSync(['node'], { home: dir });

  assert.equal(r.code, 1);
  assert.match(r.err, /butler init.*--node/);
});

test('帮助里写着 init 和它写的那两份文件', () => {
  const r = runSync(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /butler init/);
  assert.match(r.out, /dsh\.patch\.yml/);
  assert.match(r.out, /不问你 key/);
});

// ─────────────────── 老配置升级：缺的能力行要自己补上 ───────────────────
//
// 这一组盯的是**升级那一步**：新版本会多出能力行（记忆、审批…），而 init
// 原本只认"文件在不在" —— 文件早就在了，于是新能力**永远补不上**，
// 用户被卡在一个"少了半台管家"的旧配置里，还得自己打开一份 JSON 去改。
// 完全不懂技术的人就是卡死在这里。

/** 把配置退回"老版本"的样子：删掉后来才有的能力行，并且主人自己改过工作目录 */
function downgrade(cfg, drop) {
  const doc = JSON.parse(readFileSync(cfg, 'utf8'));
  doc.plugins = doc.plugins.filter((r) => !drop.includes(r.id));
  doc.plugins.find((r) => r.id === 'core').config.workspace = '/我自己的目录';
  writeFileSync(cfg, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

test('★ init：老配置缺的能力行会被补上，而主人改过的东西一个字都不动', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  const patch = patchIn(dir);
  try {
    initButlerHome({ configPath: cfg, patchFile: patch });
    downgrade(cfg, ['memory', 'approval']);

    const r = initButlerHome({ configPath: cfg, patchFile: patch });

    assert.deepEqual(r.added, ['memory', 'approval'], '缺的两行补上，顺序跟新装的一致');
    assert.deepEqual(r.written, [], '配置不是整份重写');
    const after = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.equal(
      after.plugins.find((x) => x.id === 'core').config.workspace,
      '/我自己的目录',
      '主人改过的工作目录不能被抹掉',
    );
    assert.ok(after.plugins.some((x) => x.id === 'memory'), '记忆那一行该在');
    assert.ok(after.plugins.some((x) => x.id === 'approval'), '审批那一行该在');

    // 补完就回到幂等：再跑一次什么都不补
    assert.deepEqual(initButlerHome({ configPath: cfg, patchFile: patch }).added, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init：补行那件事要说给用户听（他从命令行知道这件事）', () => {
  const dir = tempHome();
  try {
    runSync(['init'], { home: dir });
    downgrade(join(dir, '.butler', 'config.json'), ['memory', 'approval']);

    const again = runSync(['init'], { home: dir });

    assert.equal(again.code, 0);
    assert.match(again.out, /又补上了 2 样/, '补了几样、补了什么要说出来');
    assert.match(again.out, /记忆、审批/, '说的是人话，不是行 id');
    assert.match(again.out, /一个字都没动/, '还要说清"你原来改过的没被动过"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⚠️ 这条是这一轮的主角：**生成的配置里必须钉住账本路径**（`stateFile`）。
 *
 * 不给它，`SessionStore` 就是**纯内存**（见 core 的 `sessions.ts` 顶上那段）—— 认主
 * **重启就忘**：企业租户里 `dmMode` 默认 open，谁先发消息谁又成了主人；而手册教人改的
 * `<管家目录>/state/state.json` **根本不存在**。
 *
 * 为什么一直没被发现：**每一处测试都自己传了 `stateFile`**（`doctor.mjs` 的注释甚至写着
 * "真内核要 workspace 和 stateFile"）—— 测试都写死了，生产没写。
 */
test('★★ 生成的配置里，账本是**落盘**的 —— 认主不许重启就忘', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  try {
    initButlerHome({ configPath: cfg });
    const core = JSON.parse(readFileSync(cfg, 'utf8')).plugins.find((x) => x.id === 'core');
    const at = core.config.stateFile;
    assert.ok(at, 'core 行必须钉住 stateFile —— 不给它，SessionStore 就是纯内存（认主重启就忘）');
    assert.ok(isAbsolute(at), `必须是绝对路径（相对路径会落在当前工作目录，换个目录启动就换个人当家）：${at}`);
    assert.equal(at, join(dir, '.butler', 'state', 'state.json'), '就在管家目录的 state/ 下（手册说的就是这个文件）');

    // ★ "认主真的活过重启"这半边由 core 的用例钉着（`packages/core/test/sessions.mjs`：
    //   给了路径就落盘、换一个实例还记得）。这儿钉的是**另外半边**：我们真的给了路径，
    //   而且给的是绝对路径、就落在管家目录里。两个半球合起来才是完整的那句话。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 老配置（core 行只有 `workspace` —— 真安装里就是这样）跑 `init` 时补上缺的 `stateFile`。
 * 用户**在手册第 5 步**跑的就是这条命令，所以这一步是"老机器能不能被治好"的关键。
 */
test('★ init：老配置的内核行缺 stateFile 会被补上，而写过的值一个字都不动', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  const patch = patchIn(dir);
  const setStateFile = (value) => {
    const doc = JSON.parse(readFileSync(cfg, 'utf8'));
    const core = doc.plugins.find((x) => x.id === 'core');
    if (value === undefined) delete core.config.stateFile;
    else core.config.stateFile = value;
    writeFileSync(cfg, JSON.stringify(doc, null, 2));
  };
  try {
    initButlerHome({ configPath: cfg, patchFile: patch });
    setStateFile(undefined);                       // 装得早的那台：没有这个字段
    assert.equal(coreStateFileMissing(cfg), true, '删掉之后要认得出"缺"');

    const r = initButlerHome({ configPath: cfg, patchFile: patch });
    assert.equal(r.stateFileAdded, true, '补了什么要说清楚（调用方要念给用户听）');
    assert.deepEqual(r.written, [], '配置不是整份重写');
    assert.equal(
      JSON.parse(readFileSync(cfg, 'utf8')).plugins.find((x) => x.id === 'core').config.stateFile,
      join(dir, '.butler', 'state', 'state.json'),
    );
    assert.equal(coreStateFileMissing(cfg), false, '补上了就不该再说缺');
    assert.equal(initButlerHome({ configPath: cfg, patchFile: patch }).stateFileAdded, undefined,
      '补完就回到幂等：第二次什么都不补');

    // ⚠️ 用户自己写过的值（哪怕写的是**空串**）不许动 —— 那可能是他故意说"别落盘"
    setStateFile('');
    assert.equal(coreStateFileMissing(cfg), false, '字段在就不是"缺"，空串也算他写过了');
    const r2 = initButlerHome({ configPath: cfg, patchFile: patch });
    assert.equal(r2.stateFileAdded, undefined, '写过的值不许被当成"缺"');
    assert.equal(
      JSON.parse(readFileSync(cfg, 'utf8')).plugins.find((x) => x.id === 'core').config.stateFile, '',
      '空串也要原样留着 —— 猜着改用户的配置比不补更糟',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('init：被遥控那台不补能力行 —— 它只把本机的 agent 摊给中枢用', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  try {
    runSync(['init', '--node', '--config', cfg], { home: dir });
    const r = initButlerHome({ configPath: cfg, patchFile: patchIn(dir), node: true });

    assert.deepEqual(r.added, [], '节点那台不该长出记忆/审批/链路');
    const doc = JSON.parse(readFileSync(cfg, 'utf8'));
    assert.ok(!doc.plugins.some((x) => x.id === 'memory'), '记忆是主人的，不是某一台机器的');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ init：配置读不动时，一行都不补，而且如实说出来', () => {
  const dir = home();
  const cfg = cfgIn(dir);
  try {
    mkdirSync(join(dir, '.butler'), { recursive: true });
    writeFileSync(cfg, '{ 这不是 JSON');

    const r = initButlerHome({ configPath: cfg, patchFile: patchIn(dir) });

    assert.deepEqual(r.added, [], '读不动就一行都别补');
    assert.match(r.topUpSkipped ?? '', /读不出来/, '要如实说为什么没补');
    assert.equal(readFileSync(cfg, 'utf8'), '{ 这不是 JSON', '读不动就一个字都别动');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────── `butler run` 看见老配置：不写文件，但必须说一句 ───────────
//
// 升级那条路上最容易让人放弃的不是"缺一行"，而是**缺了却没人说** ——
// 他碰到的是一连串"它就是不动"，而原因藏在一份他根本不知道要打开的 JSON 里。

/** 把配置弄成"装不上"的样子：这样 run 会很快退出来，而提醒在它之前 */
function breakChannel(cfg) {
  const doc = JSON.parse(readFileSync(cfg, 'utf8'));
  doc.plugins.find((r) => r.id === 'channel').name = './plugins/根本没有这个插件.mjs';
  writeFileSync(cfg, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 先放一把假 key：免得 run 去开"贴 key"的页面等人（那是真人的事） */
function fakeKey(home) {
  mkdirSync(join(home, '.butler', 'dsh-home'), { recursive: true });
  writeFileSync(
    credentialsFileOf(join(home, '.butler', 'dsh-home')),
    `version: 1\nrefs:\n  ${DEFAULT_KEY_REF}: "sk-假的"
`,
    { mode: 0o600 },
  );
}

test('★ run：老配置少了能力行，开局就说一句（而且一个字节都不写）', () => {
  const dir = tempHome();
  const cfg = join(dir, '.butler', 'config.json');
  try {
    runSync(['init'], { home: dir });
    downgrade(cfg, ['memory', 'approval']);
    breakChannel(cfg);
    fakeKey(dir);
    const before = readFileSync(cfg, 'utf8');

    const r = runSync(['run'], { home: dir });

    assert.match(r.out, /少了 2 样/, '要在他碰壁之前就说明白');
    assert.match(r.out, /记忆、审批/, '说的是人话，不是行 id');
    assert.match(r.out, /butler init/, '要给出那一步');
    assert.match(r.out, /一律拒绝/, '还要说清不补的后果');
    assert.equal(readFileSync(cfg, 'utf8'), before, 'run 一个字节都不许写');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run：配置齐全时一个字都不啰嗦', () => {
  const dir = tempHome();
  const cfg = join(dir, '.butler', 'config.json');
  try {
    runSync(['init'], { home: dir });
    breakChannel(cfg);
    fakeKey(dir);

    const r = runSync(['run'], { home: dir });

    assert.doesNotMatch(r.out, /少了 \d+ 样/, '什么都不缺就别念叨');
    assert.doesNotMatch(r.out, /stateFile/, '新装的配置已经钉住账本了，不该再提这一句');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ run：老配置的内核行没有 stateFile，开局就说一句（而且一个字节都不写）', () => {
  const dir = tempHome();
  const cfg = join(dir, '.butler', 'config.json');
  const dropStateFile = () => {
    const doc = JSON.parse(readFileSync(cfg, 'utf8'));
    delete doc.plugins.find((x) => x.id === 'core').config.stateFile;
    writeFileSync(cfg, JSON.stringify(doc, null, 2));
  };
  try {
    runSync(['init'], { home: dir });
    dropStateFile();
    breakChannel(cfg);
    fakeKey(dir);
    const before = readFileSync(cfg, 'utf8');

    const r = runSync(['run'], { home: dir });

    assert.match(r.out, /stateFile/, '要在他碰壁之前说：认主这会儿只在内存里');
    assert.match(r.out, /重启/, '说清后果：重启之后第一个说话的人又会成为主人');
    assert.match(r.out, /butler init/, '要给出那一步');
    assert.equal(readFileSync(cfg, 'utf8'), before, 'run 一个字节都不许写');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★ 跨网那台：`init --link tailscale` 写的是尾巴网络那条，而且**不写密钥**', () => {
  const dir = home();
  try {
    const cfg = JSON.parse(defaultConfigText({ home: dir, link: 'tailscale' }));
    const link = cfg.plugins.find((pl) => pl.id === 'link');
    assert.equal(link.name, '@butler/link-tailscale');
    assert.equal(link.config.peersFile, join(dir, 'state', 'tailscale-peers.json'),
      '名册路径必须钉在这个家里 —— 不然用 --config 搬家时会悄悄落回 ~/.butler');
    assert.equal('secret' in link.config, false,
      '配对这条路不该写密钥：那正是用户要在两台机器上抄对、最容易放弃的那一步');
    // 别的行照旧（换链路不该把别的行带跑）
    assert.ok(cfg.plugins.some((pl) => pl.name === '@butler/core'));
    assert.ok(cfg.plugins.some((pl) => pl.name === '@butler/memory-file'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('不指定链路时还是局域网那条（老行为一个字没变）', () => {
  const dir = home();
  try {
    const link = JSON.parse(defaultConfigText({ home: dir })).plugins.find((pl) => pl.id === 'link');
    assert.equal(link.name, '@butler/link-lan');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('★ --link：一条命令配好跨网那台；名字不认识就当场说，不许装作成功', () => {
  const dir = home();
  try {
    const r = runSync(['init', '--config', join(dir, 'config.json'), '--link', 'tailscale'], { home: dir });
    assert.equal(r.code, 0, r.err);
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.plugins.find((pl) => pl.id === 'link').name, '@butler/link-tailscale');

    // 不认识的名字：验在写文件**之前**，一个字节都不该落
    const bad = runSync(['init', '--config', join(dir, 'x.json'), '--link', 'ssh'], { home: dir });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /不认识这条链路/);
    assert.equal(existsSync(join(dir, 'x.json')), false);

    // 帮助里得写着，不然没人知道能跨网
    assert.match(runSync(['--help'], { home: dir }).out, /--link/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
