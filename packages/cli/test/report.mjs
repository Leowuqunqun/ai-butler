/**
 * `butler report` —— 出事之后用户手里的那根绳子。
 *
 * 这里钉的是两件**别的测试盯不到**的事：
 *   ① **一个 key 都不许漏出去**（连他机器上真实的那把都不许被读出来）
 *   ② **只读** —— 生成报告不许改他机器上的任何东西
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectReport, redact, reportFilePath, writeReport } from '../lib/report.js';

const tempHome = () => mkdtempSync(join(tmpdir(), 'butler-report-'));

const SECRETS = {
  channelToken: 'TOKEN-LEAK-987654',
  patchKey: 'sk-PATCHLEAK-abcdefgh',
  logSecret: 'sk-LOGLEAK-zyxwvuts',
  realKey: 'sk-REALKEY-MUST-NEVER-BE-READ',
  linkSecret: 'LINKSECRET-LEAK-1234',
};

/** 建一个"像真的"管家目录：配置、补丁、日志、几样状态文件，每样都埋一把密钥 */
function seed(home) {
  const b = join(home, '.butler');
  mkdirSync(join(b, 'state', 'approvals', 'pending'), { recursive: true });
  mkdirSync(join(b, 'logs'), { recursive: true });
  mkdirSync(join(b, 'dsh-home'), { recursive: true });
  writeFileSync(join(b, 'config.json'), JSON.stringify({
    plugins: [
      { id: 'core', name: '@butler/core', config: { workspace: '/home/leo/work' } },
      { id: 'channel', name: '@butler/channel-wechat', config: { token: SECRETS.channelToken, poll: 2000 } },
      { id: 'memory', name: '@butler/memory', config: { dir: join(b, 'state', 'memory.json') } },
    ],
  }, null, 2));
  writeFileSync(join(b, 'dsh.patch.yml'),
    `# 补丁\nagent-dsh:\n  model:\n    apiKey: ${SECRETS.patchKey}\n    apiKeyEnv: DEEPSEEK_API_KEY\n`);
  writeFileSync(join(b, 'logs', 'autostart.log'), `启动…\n又一行\n连上了 ${SECRETS.logSecret}\n`);
  writeFileSync(join(b, 'dsh-home', '.credentials.yaml'),
    `version: 1\nrefs:\n  DEEPSEEK_API_KEY: "${SECRETS.realKey}"\n`, { mode: 0o600 });
  writeFileSync(join(b, 'state', 'token.json'), JSON.stringify({ secret: SECRETS.linkSecret }));
  return b;
}

const selfCheck = async () => '✓ 内核 @butler/core\n✗ 模型 key 还没有 —— 跑一次 butler run';

test('报告是给人看的：版本、系统、文件清单、自检、日志都在', async () => {
  const home = tempHome();
  try {
    seed(home);
    const text = await collectReport({ home, selfCheck });
    assert.match(text, /管家体检报告/);
    assert.match(text, /butler \d+\.\d+\.\d+/);
    assert.match(text, new RegExp(`node ${process.version.replace(/\./g, '\\.')}`));
    assert.match(text, /① 有哪些文件/);
    assert.match(text, /配置：有（\d+ 字节，权限 /);
    assert.match(text, /④ 自检说什么/);
    assert.match(text, /模型 key 还没有/);
    assert.match(text, /⑤ 最近的日志尾巴/);
    assert.match(text, /又一行/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('★ 埋在各处的密钥，一个都不许出现在报告里', async () => {
  const home = tempHome();
  try {
    seed(home);
    const text = await collectReport({ home, selfCheck });
    for (const [where, secret] of Object.entries(SECRETS)) {
      assert.ok(!text.includes(secret), `${where} 那把漏出去了：${secret}`);
    }
    // 连"真实那把"都不许被读出来 —— 报告只登记凭据文件存在，不读它
    assert.match(text, /模型 key（只登记存在，\*\*不读内容\*\*）：有（/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('隐去是**明说**的，不是装作没有：字段名还在，值标掉了', async () => {
  const home = tempHome();
  try {
    seed(home);
    const text = await collectReport({ home, selfCheck });
    assert.match(text, /token: （已隐去）/, '要能看出来"这里本来有个 token"');
    assert.match(text, /apiKey: （已隐去）/);
    assert.match(text, /apiKeyEnv: DEEPSEEK_API_KEY/, '该给帮手看的东西不能一起隐掉');
    assert.match(text, /⑥ 这一份里没有什么/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('★ 只读：生成报告不改机器上的任何东西', async () => {
  const home = tempHome();
  try {
    const b = seed(home);
    const snapshot = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = join(e.parentPath ?? e.path, e.name);
        const st = statSync(p);
        return `${p}|${st.size}|${st.mtimeMs}|${readFileSync(p, 'utf8').length}`;
      })
      .sort()
      .join('\n');

    const before = snapshot(b);
    await collectReport({ home, selfCheck });
    assert.equal(snapshot(b), before, '报告必须是只读的 —— 一个字节都不该动');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('配置读不动 / 什么都没有：报告照样出得来，而且如实说', async () => {
  const empty = tempHome();
  const broken = tempHome();
  try {
    const a = await collectReport({ home: empty, selfCheck });
    assert.match(a, /配置：没有/);
    assert.match(a, /没有日志文件/);

    seed(broken);
    writeFileSync(join(broken, '.butler', 'config.json'), '{ 这不是 JSON');
    const bText = await collectReport({ home: broken, selfCheck });
    assert.match(bText, /读不出来（不是合法的 JSON）/, '读不动就要说出来，不能装没看见');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(broken, { recursive: true, force: true });
  }
});

test('写到哪、权限多少：0600，而且文件名带时间', () => {
  const home = tempHome();
  try {
    const at = new Date(2026, 9, 12, 16, 7, 32);
    const path = reportFilePath({ home, now: at });
    assert.match(path, /report-20261012-160732\.txt$/);

    const file = writeReport('报告正文', { home, now: at });
    assert.equal(file, path);
    assert.equal(statSync(file).mode & 0o777, 0o600, '跟凭据一个待遇');
    assert.equal(readFileSync(file, 'utf8'), '报告正文');

    const custom = writeReport('x', { out: join(home, '自定义', 'r.txt') });
    assert.equal(readFileSync(custom, 'utf8'), 'x');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('扫描器本身：sk-、Bearer、长串都拦得住', () => {
  const out = redact('key=sk-abcdefghijklmnop Authorization: Bearer abcdef1234567890 {"secret":"hunter2xyz"} 串 0123456789abcdef0123456789abcdef');
  assert.ok(!out.includes('sk-abcdefghijklmnop'));
  assert.ok(!out.includes('abcdef1234567890'));
  assert.ok(!out.includes('hunter2xyz'));
  assert.ok(!out.includes('0123456789abcdef0123456789abcdef'));
  assert.match(out, /已隐去/);
});

/**
 * ⚠️ 这条盯的是报告**自己跟自己打架**：④段的 doctor 读的是 `--config` 那份，
 * ①段却曾经写死 `~/.butler` —— 于是同一份报告里，"管家目录"和凭据有没有是假的。
 * 报告是"出事了发给帮你的人"那份东西，指错地方比不写更坏。
 */
test('★ 用 --config 把家安在别处：报告说的是**那个**家', async () => {
  const home = tempHome();
  try {
    const elsewhere = join(home, '别处的家');
    mkdirSync(join(elsewhere, 'state'), { recursive: true });
    mkdirSync(join(elsewhere, 'dsh-home'), { recursive: true });
    mkdirSync(join(home, '.butler', 'logs'), { recursive: true });
    const configPath = join(elsewhere, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      plugins: [{ id: 'core', name: '@butler/core', config: { workspace: '/home/leo/work' } }],
    }, null, 2));
    // 凭据**只**在别处那个家里 —— 报告要是还去 ~/.butler 找，这一条就会说"没有"
    writeFileSync(join(elsewhere, 'state', 'secrets.json'), JSON.stringify({ version: 1, channels: {} }));
    // 自启动的日志反过来：**不**跟着 --config 走，永远在 ~/.butler/logs（见 autostart.ts）
    writeFileSync(join(home, '.butler', 'logs', 'autostart.log'), '别处那台的日志尾巴\n');

    const text = await collectReport({ home, configPath, selfCheck });

    // ⚠️ 比"整条路径"是不行的：报告最后要过一个**按形状扫**的脱敏器，而 macOS 临时路径里
    //    那串长随机段正好长得像密钥 —— 它会被隐去（那是**对**的）。所以这里比**可辨认的尾巴**，
    //    它同样能证伪：写死 `~/.butler` 的时候，这一行里根本不会出现"别处的家"。
    const dirLine = /管家目录：.*/.exec(text)?.[0] ?? '';
    assert.ok(dirLine.endsWith('别处的家'),
      `报告必须说 --config 那个家（不是 ~/.butler），实际写的是：${dirLine}`);
    assert.ok(text.includes('通道凭据（只登记存在，**不读内容**）：有'),
      '凭据在 --config 那个家里 —— 去 ~/.butler 找就会说"没有"');
    assert.match(text, /记忆：没有/);
    assert.match(text, /别处那台的日志尾巴/, '⑤ 念的是真日志（它固定在 ~/.butler/logs，不跟着 --config 走）');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
