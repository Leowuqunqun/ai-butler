/**
 * 「换一个 IM」的测试 —— M3 里"第二个通道验证抽象"那一条的验收。
 *
 *   node --test test/switch-im.mjs
 *
 * 这一份要证的不是"Telegram 能用"（那是 `packages/channel-telegram` 自己的事），
 * 而是**它接进来的代价**：`init` 换一行、`doctor` 照旧、核心层一个字没改。
 * 所以这里的断言刻意都是"结构"层面的：
 *
 *   ① 同一套 `butler init` / `butler doctor` 命令，配置里换一行 name 之后四个
 *      能力位照样齐（不是"也能跑"，是"看不出区别"）；
 *   ② `packages/core` 里**不许出现任何一个通道包的名字** —— 一旦出现，
 *      "换通道不用改核心层"就是空话了，而且最先烂掉的会是这里；
 *   ③ 换 IM 不许把家搬乱：`--config` 指到别处时，补丁和 dsh-home 都得跟着走，
 *      默认的 `~/.butler` 一个字节都不该被建出来。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsync, runSync, tempHome } from './fixtures/node-helpers.mjs';
import { useButlerShim } from './fixtures/path-shim.mjs';

// `doctor` 会去问内核"管家自己找得到 butler 吗"（量的是**管家进程自己的** PATH）。
// 测试机上没有 butler，给它一个真 shim —— **改环境，不改判据**。
// ⚠️ 这里造绿不算数 —— 真正把关的是 scripts/verify-clean-install.sh（真装出来的进程）。
useButlerShim();

const here = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(here, '..', '..', 'core', 'src');

test('★ 换一个 IM：init --im telegram → doctor 里四个能力位照旧，看不出区别', () => {
  const home = tempHome();

  const init = runSync(['init', '--im', 'telegram'], { home });
  assert.equal(init.code, 0, `init 该成功：\n${init.out}\n${init.err}`);
  assert.match(init.out, /@BotFather/, '要告诉他 token 去哪拿');
  // ★ M3 收尾之后，token 也由引导页问 —— 提示里不许再叫他去改配置文件
  assert.match(init.out, /butler run/, '要告诉他下一步就是跑起来');
  assert.match(init.out, /都不用你改任何文件/);
  assert.equal(/把通道那行的 botToken 填上/.test(init.out), false, '不该再让人手改配置');

  const doc = runSync(['doctor'], { home });
  const both = `${doc.out}\n${doc.err}`;

  // 通道那一行换成了 telegram —— 这是**唯一**变了的东西
  assert.match(both, /✓\s+channel\s+@butler\/channel-telegram/, `通道该装上来：\n${both}`);

  // 四个能力位照旧。核心层不认识"telegram"，它只认识 ctx.channel
  for (const slot of ['ctx.channel', 'ctx.agent', 'ctx.core']) {
    assert.match(both, new RegExp(`✓\\s+${slot.replace('.', '\\.')}`), `${slot} 该就位：\n${both}`);
  }

  // 通道自己的自检也照旧出现在 doctor 里，而且带出路
  assert.match(both, /Telegram 登录态[\s\S]*还没有填 bot token/);
  assert.match(both, /Telegram 登录态[\s\S]*@BotFather/);
});

test('★ 核心层里不许出现任何一个通道包的名字（不然这个 seam 就是空话）', () => {
  const files = readdirSync(CORE_SRC, { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.ts'));
  assert.ok(files.length >= 5, `core/src 里该有一堆文件，实际只扫到 ${files.length} 个`);

  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(CORE_SRC, f), 'utf8');
    for (const needle of ['wechat-agent-bridge', '@butler/channel-telegram', '@butler/channel-wechat']) {
      if (text.includes(needle)) hits.push(`${f}: ${needle}`);
    }
  }
  assert.deepEqual(hits, [], `核心层不能依赖具体通道包：\n${hits.join('\n')}`);
});

test('init --im telegram：配置里那一行是 telegram，token 留空等着他填', () => {
  const home = tempHome();
  runSync(['init', '--im', 'telegram'], { home });

  const cfg = JSON.parse(readFileSync(join(home, '.butler', 'config.json'), 'utf8'));
  const channel = cfg.plugins.find((p) => p.id === 'channel');
  assert.equal(channel.name, '@butler/channel-telegram');
  assert.equal(channel.config.botToken, '', '留一行空的，他至少知道该往哪儿填');
  assert.equal(channel.config.home, join(home, '.butler'), '登录态和收到的文件都在这个家里');
  // 其余三行的 id 一个都没变 —— 核心层认的是 id，不是 name
  assert.deepEqual(cfg.plugins.map((p) => p.id), ['channel', 'agent', 'core', 'memory', 'approval', 'link']);
});

test('init --im signal：不认识就说清楚现在支持哪些，别装作成功', () => {
  const home = tempHome();
  const r = runSync(['init', '--im', 'signal'], { home });
  assert.equal(r.code, 2);
  assert.match(`${r.out}${r.err}`, /不认识这个 IM：signal/);
  assert.match(`${r.out}${r.err}`, /wechat、telegram/, '得告诉他有哪些可选');
  assert.ok(!existsSync(join(home, '.butler', 'config.json')), '不认识的 IM 不该写出配置');
});

test('★ --config 指到别处：补丁和 dsh-home 跟着走，默认的 ~/.butler 一个字节都不许建', () => {
  const home = tempHome();
  const moved = join(home, '别处');
  const cfgPath = join(moved, 'config.json');

  const r = runSync(['init', '--config', cfgPath], { home });
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const agent = cfg.plugins.find((p) => p.id === 'agent');
  assert.equal(agent.config.patchFile, join(moved, 'dsh.patch.yml'), '补丁得跟着家走');
  assert.equal(agent.config.home, join(moved, 'dsh-home'), '凭据库（模型 key）也得跟着走');
  assert.ok(existsSync(join(moved, 'dsh.patch.yml')), '补丁该真写出来');
  assert.equal(cfg.plugins.find((p) => p.id === 'channel').config.home, moved, '通道的 state 同理');

  assert.ok(!existsSync(join(home, '.butler')), '指到别处之后，默认的家不许被建出来');
});

test('--help 里写着 --im（不然没人知道能换）', () => {
  const r = runSync(['--help']);
  assert.match(r.out, /--im/, '帮助里得有这一行');
  assert.match(r.out, /telegram/, '而且得写出可选值');
});

/**
 * 起一个假 Telegram：只监听 127.0.0.1，谁问它都回"我是 @fake_bot"。
 *
 * 为什么要它：`doctor` 现在**真会去问一句"我是谁"**。有了这个假服务器，
 * 这几条用例就既不用连真 Telegram（不联网、不慢、不飘），又能证明
 * **到底哪一串 token 被送到了插件手里** —— 这是"谁覆盖谁"唯一能被证死的办法。
 */
function startFakeTelegram() {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      const path = req.url ?? '';
      const m = /^\/bot([^/]+)\//.exec(path);
      seen.push(m ? m[1] : path);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { id: 777, username: 'fake_bot' } }));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 把 init 写出来的配置改一改（比如把 baseUrl 指到假服务器上） */
function patchConfig(home, fn) {
  const cfgFile = join(home, '.butler', 'config.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  fn(cfg.plugins.find((p) => p.id === 'channel'));
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
}

const seedSecrets = (home, token) => {
  const file = join(home, '.butler', 'state', 'secrets.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, channels: { telegram: { botToken: token } } }), { mode: 0o600 });
};

test('★ 引导页存过 token 之后，doctor 真的拿它去问了一句"我是谁"', async () => {
  const home = tempHome();
  runSync(['init', '--im', 'telegram'], { home });

  const before = runSync(['doctor'], { home });
  assert.match(`${before.out}${before.err}`, /Telegram 登录态[\s\S]*还没有填 bot token/);

  const fake = await startFakeTelegram();
  try {
    // 引导页写的就是这个文件（`butler run` 起页面 → 用户贴 → 存这儿）
    seedSecrets(home, '222:FROM-PAGE');
    patchConfig(home, (row) => { row.config.baseUrl = fake.url; });

    // 必须异步跑：假服务器就在这个进程里，runSync 会把事件循环卡死
    const after = await runAsync(['doctor'], { home });
    const both = `${after.out}${after.err}`;
    assert.equal(/还没有填 bot token/.test(both), false, `人家贴过了还说没填，就是骗人：\n${both}`);
    assert.match(both, /Telegram 登录态[\s\S]*已连上 @fake_bot/, `该报连上了：\n${both}`);
    assert.deepEqual(fake.seen, ['222:FROM-PAGE'], 'CLI 必须把存下来的那串填进插件（不然它手里是空的）');
  } finally {
    await fake.close();
  }
});

test('★ 配置里手写的 token 谁都不许覆盖（连 doctor 都送到插件手里的必须是手写那串）', async () => {
  const home = tempHome();
  runSync(['init', '--im', 'telegram'], { home });

  const fake = await startFakeTelegram();
  try {
    seedSecrets(home, '999:PAGE');
    patchConfig(home, (row) => {
      row.config.botToken = '111:HAND-WRITTEN';
      row.config.baseUrl = fake.url;
    });

    const doc = await runAsync(['doctor'], { home });
    const both = `${doc.out}${doc.err}`;
    assert.match(both, /Telegram 登录态[\s\S]*已连上 @fake_bot/, `手写的那份要生效：\n${both}`);
    assert.deepEqual(fake.seen, ['111:HAND-WRITTEN'], '手写的赢 —— 引导页那份不许盖上去');
  } finally {
    await fake.close();
  }
});

test('★ token 被作废了（Telegram 回 401）：doctor 当场说 ✗，并给出 --again', async () => {
  const home = tempHome();
  runSync(['init', '--im', 'telegram'], { home });

  // 假服务器一律 401 —— 就是"在 @BotFather 那边 revoke 过"的样子
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    seedSecrets(home, '333:REVOKED');
    patchConfig(home, (row) => { row.config.baseUrl = `http://127.0.0.1:${port}`; });

    const doc = await runAsync(['doctor'], { home });
    const both = `${doc.out}${doc.err}`;
    assert.match(both, /Telegram 登录态[\s\S]*✗/, `作废的 token 必须报红：\n${both}`);
    assert.match(both, /--again/, '出路要点名那条命令');
    assert.equal(doc.code !== 0, true, '有 ✗ 就该是"还有要修的"');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
