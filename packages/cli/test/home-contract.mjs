/**
 * 「管家自己的家在哪儿」—— **所有算它的地方，必须是同一个家**。
 *
 * ── 为什么单独立一个文件 ──────────────────────────────────────
 *
 * 这条例子的另一头是**用户看到的承诺**：探针说"凭据存好了，`butler run` 直接用"。
 * 只要**有任何一个**地方不认 `BUTLER_HOME`，那句承诺在他那儿就是假的 —— 而每一处
 * 单独的测试都可能是绿的（各自都自洽），合起来才不通。那才是最难查的故障。
 *
 * 所以这里既不重写一份读法、也不比源码文本，而是：**设一个 `BUTLER_HOME`，然后把
 * 每一处都真的问一遍"你的家在哪"**，只认它们算出来的路径。
 *
 * 第 42 轮补齐后，算管家目录的地方是这些（下面的用例一处不落）：
 *   · 内核 `@butler/core`（`grants.json` 的兜底目录）
 *   · CLI 的 `lib/setup.js`（默认配置路径、补丁路径都跟着它走）
 *   · 探针 `probe/save.mjs` 的 `homeOf`（`--home=` > `BUTLER_HOME` > `~/.butler`）
 *   · `@butler/channel-feishu/probe-path` 的 `defaultHome()`（故意不依赖任何东西的那份）
 *   · 叶子包：记忆文件、局域网的节点身份、审批的家、两个通道各自的 `home`
 *
 * 叶子包**故意不引内核**（它们是 leaf，各自只写一行同样的式子）—— 把这条规则焊住的
 * 是**这个文件**，不是一次共享 import。
 *
 * ⚠️ `BUTLER_HOME=` 空串 / 全空白 = 没设（`BUTLER_HOME= butler run` 是很常见的写法），
 *    所以**每一处都要 trim** —— 这一条也在这里量。
 *
 * @module @butler/cli/test/home-contract
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Context } from '@deepseek-ai/cordis';
import { butlerHome, defaultConfigPath } from '../lib/setup.js';
import { autostartPlan } from '../lib/autostart.js';
import { collectReport, reportFilePath } from '../lib/report.js';
import { butlerHome as coreButlerHome } from '@butler/core';
import { approvalsDir } from '@butler/approval-im';
import { defaultIdentityFile, defaultStateDir } from '@butler/link-lan';
import FileMemory from '@butler/memory-file';
import TelegramChannel from '@butler/channel-telegram';
import FeishuChannel from '@butler/channel-feishu';

// 探针的 `save.mjs` 不在包的 `exports` 里（那不是给人 import 的入口）—— 按**文件路径**引，
// 和 `probe-contract.mjs` 引 `run.sh` 是同一个路子：量的是那个**真发出去的脚本**。
const SAVE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'channel-feishu', 'probe', 'save.mjs',
);
const { homeOf } = await import(pathToFileURL(SAVE).href);

/**
 * 真的 cordis ctx：这些类都 extends `Service`，构造时会往 ctx 上挂东西（假的会当场炸）。
 * **每次都要一个新的**：同一个 ctx 上同名服务只能注册一次（`channel` / `memory`）。
 */
const ctx = () => new Context();

/** 在"设了 `BUTLER_HOME`"的环境里跑一段（跑完一定换回来，别污染别的用例） */
async function withHome(dir, fn) {
  const before = process.env.BUTLER_HOME;
  process.env.BUTLER_HOME = dir;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.BUTLER_HOME;
    else process.env.BUTLER_HOME = before;
  }
}

/** 把通道 `check()` 说出来的那几行拼起来 —— 它本来就该把"东西在哪儿"告诉用户 */
const saidBy = async (channel) => JSON.stringify(await channel.check());

const HOME = '/tmp/butler-home-contract-的家';

test('★★ 设了 BUTLER_HOME：每一处"算管家目录"的地方都落在那个家里', async () => {
  await withHome(HOME, async () => {
    // 内核 + CLI：两处**各自实现**的规则，必须算出同一个家
    assert.equal(coreButlerHome(), HOME, '内核的 butlerHome 不认 BUTLER_HOME');
    assert.equal(butlerHome(), HOME, 'CLI 的 butlerHome 不认 BUTLER_HOME');
    assert.ok(
      defaultConfigPath().startsWith(HOME),
      `CLI 的默认配置路径没跟着 BUTLER_HOME 走：${defaultConfigPath()}`,
    );

    // 探针：`homeOf` 那一份（`--home=` 仍然最优先，见最后一条用例）
    assert.equal(homeOf(['node', 'x'], { BUTLER_HOME: HOME }), HOME, '探针的 homeOf 不认 BUTLER_HOME');

    // 探针另一份：`probe-path` 的 `defaultHome()`（故意不依赖任何东西）
    const probePath = await import('@butler/channel-feishu/probe-path');
    assert.equal(probePath.defaultHome(), HOME, 'probe-path 的 defaultHome 不认 BUTLER_HOME');

    // 叶子包：记忆文件
    const memory = new FileMemory(ctx(), { home: '' });
    assert.ok(memory.file.startsWith(HOME), `记忆文件没落在 BUTLER_HOME 里：${memory.file}`);

    // 叶子包：局域网的节点身份
    assert.ok(
      defaultStateDir().startsWith(HOME),
      `局域网的节点目录没落在 BUTLER_HOME 里：${defaultStateDir()}`,
    );
    assert.ok(defaultIdentityFile().startsWith(HOME), '节点身份文件没跟着它走');

    // 叶子包：审批的家
    assert.ok(approvalsDir().startsWith(HOME), `审批的家没落在 BUTLER_HOME 里：${approvalsDir()}`);

    // 两个通道：用它们**自己**会露给用户的那句话来观察（`check()` 里带着路径）
    // 凭据一律留空 —— 走的就是"还没有凭据"那条路，不碰网络
    const feishu = new FeishuChannel(ctx(), { appId: '', appSecret: '', home: '' });
    assert.ok(
      (await saidBy(feishu)).includes(HOME),
      `飞书通道没去 BUTLER_HOME 那个家：${await saidBy(feishu)}`,
    );

    const telegram = new TelegramChannel(ctx(), { botToken: '', home: '' });
    assert.ok(
      (await saidBy(telegram)).includes(HOME),
      `telegram 通道没去 BUTLER_HOME 那个家：${await saidBy(telegram)}`,
    );
  });
});

test('★ BUTLER_HOME 是空串 / 全空白 = 没设：每一处都退回 ~/.butler，不许把家搬到 "   "', async () => {
  const fallback = join(homedir(), '.butler');
  for (const blank of ['', '   ']) {
    await withHome(blank, async () => {
      assert.equal(coreButlerHome(), fallback, `内核把 ${JSON.stringify(blank)} 当成了一个家`);
      assert.equal(butlerHome(), fallback, `CLI 把 ${JSON.stringify(blank)} 当成了一个家`);
      assert.equal(homeOf(['node', 'x'], { BUTLER_HOME: blank }), fallback, '探针没 trim');
      assert.ok(approvalsDir().startsWith(fallback), '审批的家没退回默认位置');
      assert.ok(defaultStateDir().startsWith(fallback), '节点目录没退回默认位置');
      assert.ok(
        new FileMemory(ctx(), { home: '' }).file.startsWith(fallback),
        '记忆文件没退回默认位置',
      );
      assert.ok(
        (await saidBy(new TelegramChannel(ctx(), { botToken: '', home: '' }))).includes(fallback),
        'telegram 通道没退回默认位置',
      );
    });
  }
});

test('探针的 --home= 仍然最优先（把家安在别处的人靠它）', () => {
  const flagged = '/tmp/butler-home-contract-命令行指定';
  assert.equal(
    homeOf(['node', 'x', `--home=${flagged}`], { BUTLER_HOME: HOME }),
    flagged,
    '--home= 必须压过 BUTLER_HOME',
  );
});

test('★★ 报告和自启动也走同一个家（第 43 轮收的两处 CLI 层）', async () => {
  await withHome(HOME, async () => {
    // 报告写到哪儿（纯函数）
    const report = reportFilePath({ now: new Date(2026, 0, 2, 3, 4, 5) });
    assert.ok(report.startsWith(HOME), `报告文件没落在 BUTLER_HOME 里：${report}`);

    // 自启动单元里写着两样跟家有关的东西：要用的配置、日志往哪儿写（纯函数）
    // ⚠️ 断言必须**专指**：`plan.content` 里还带着日志路径，它也含 `<家>/` —— 用 `.includes(HOME)`
    //    的话，配置那行改坏了它照样是绿的（第 43 轮反向验证时真踩到了）。
    const plan = autostartPlan({ platform: 'darwin', cliPath: '/opt/x/cli.js' });
    assert.ok(plan, 'darwin 上该有自启动方案');
    assert.ok(
      plan.content.includes(join(HOME, 'config.json')),
      '自启动单元里的配置路径没跟着 BUTLER_HOME 走',
    );
    assert.ok(
      plan.content.includes(join(HOME, 'logs', 'autostart.log')),
      '自启动日志没落在 BUTLER_HOME 里',
    );

    // 报告的**默认分支**（没给 `--config` 时走哪个家）。自检那段换掉 —— 不然会真起容器。
    // 同样只认专指的那一行：`管家目录：` 后面就是它算出来的家。
    const text = await collectReport({ selfCheck: async () => '（跳过）' });
    assert.ok(
      text.includes(`管家目录：${HOME}`),
      '报告的默认家没跟着 BUTLER_HOME 走（报告里 `管家目录：` 那行不是它）',
    );
  });
});
