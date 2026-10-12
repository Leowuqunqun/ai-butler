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
