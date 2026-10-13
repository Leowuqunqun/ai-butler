/**
 * 探针写下的凭据，CLI 真的读得到吗 —— 这条契约**只有跨包真跑一次**才算数。
 *
 * ── 为什么单独立一个文件 ──────────────────────────────────────
 *
 * 这条路上有两个"自洽的半球"：探针负责把凭据写到盘上（`probe/save.mjs`，测试在
 * `packages/channel-feishu/test/probe.mjs`），CLI 负责把它读出来（`src/secrets.ts`，
 * 测试在同目录的 `secrets.mjs`）。**两边各自的测试都可能是绿的，合起来却不通** ——
 * 那才是最难查的故障，因为用户看到的是"探针说存好了，`butler run` 却说还没有 app_id"，
 * 而两边看起来都没问题。
 *
 * 所以这里不重写一份读法（那又变成"我照着自己的理解对了一遍"），而是：
 * **真的把探针跑起来写一遍，再用 CLI 自己的读法读回来。**
 *
 * 用的凭据是**假的**，也不断言退出码 —— 连不上飞书是意料之中的（我们要验的是"存下来"，
 * 不是"连上"）。这里刻意掐时间：写完凭据就不必等长连接握手了。
 *
 * @module @butler/cli/test/probe-contract
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { injectChannelSecrets, readSecrets, secretOf } from '@butler/cli';
import { runSync } from './fixtures/node-helpers.mjs';

const PROBE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'channel-feishu', 'probe', 'run.sh',
);

test('★ 探针 --save 存下的凭据，CLI 读得到、也能填进配置行（两个半球合起来才通）', () => {
  const home = mkdtempSync(join(tmpdir(), 'butler-probe-contract-'));

  try {
    // 假凭据走"自建应用"那条路（不扫码）：凭据写盘发生在连长连接**之前**，
    // 所以连不上也不该丢 —— 这正是一个刚建好、权限还没配齐的应用的常态。
    const r = spawnSync('bash', [PROBE, '--save', '--home=' + home], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LARK_APP_ID: 'cli_contract_probe',
        LARK_APP_SECRET: 'secret_contract_probe',
        BUTLER_HOME: '',
      },
      timeout: 4000,
    });

    const file = join(home, 'state', 'secrets.json');
    assert.ok(
      existsSync(file),
      '探针必须**先**把凭据存下来（连不上飞书也不该丢）——'
        + `实际 stdout:\n${r.stdout}\n实际 stderr:\n${r.stderr}`,
    );

    // 用 CLI 自己的读法 —— 这才是这两个半球之间的契约
    assert.deepEqual(
      readSecrets(file).channels.feishu,
      { appId: 'cli_contract_probe', appSecret: 'secret_contract_probe' },
    );
    assert.equal(secretOf(file, 'feishu', 'appId'), 'cli_contract_probe');

    // 而且 `butler run` 注入那一步要真的把它填进配置行 —— 那才是"下次不用再扫"
    const rows = [
      { name: '@butler/channel-feishu', config: { home, appId: '', appSecret: '' } },
    ];
    const filled = injectChannelSecrets(rows, file);
    assert.deepEqual(filled, ['appId', 'appSecret'], '两项都要填上');
    assert.equal(rows[0].config.appId, 'cli_contract_probe');
    assert.equal(rows[0].config.appSecret, 'secret_contract_probe');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 两个半球之间**多出来的那条缝**：命令本身。
 *
 * 上一条验的是"写进去的、CLI 读得出来" —— 但它**手写**了 `--home=` 传给探针。
 * 用户不会手写：他照抄的是**引导页给的那条命令**。家不在默认位置（用 `--config`
 * 把配置安在别处）时，那条命令必须**自己**带上 `--home=`，否则探针把凭据存进
 * `~/.butler`，CLI 却在别处读 —— 用户看到的是"探针说存好了，`butler run` 却说还没有 app_id"。
 *
 * 所以这条把**算出来的命令原样交给 shell 跑一遍**（连引号一起验，用户就是这么做的）。
 */
test('★ 家不在默认位置时：引导页那条命令（原样照抄）存下的凭据，CLI 读得到', async () => {
  const { probeCommand } = await import('@butler/channel-feishu/probe-path');
  const home = mkdtempSync(join(tmpdir(), 'butler-probe-home-'));

  try {
    const cmd = probeCommand(home);
    assert.ok(cmd, '源码树里必须算得出来（探针就在包内）');
    assert.ok(cmd.includes(`--home="${home}"`), `别处的家必须带上 --home=（实际：${cmd}）`);

    // 原样交给 shell —— 就是用户把这句话粘进终端的动作
    const r = spawnSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LARK_APP_ID: 'cli_contract_home',
        LARK_APP_SECRET: 'secret_contract_home',
        BUTLER_HOME: '',
      },
      timeout: 4000,
    });

    const file = join(home, 'state', 'secrets.json');
    assert.ok(
      existsSync(file),
      '凭据必须落在**这个**家里（不是 ~/.butler）——'
        + `实际 stdout:\n${r.stdout}\n实际 stderr:\n${r.stderr}`,
    );
    assert.equal(secretOf(file, 'feishu', 'appId'), 'cli_contract_home');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * ⚠️ 上一条**手写**了那个 `--home=`（它自己调 `probeCommand(home)`）—— 可用户不会调用函数，
 * 他照抄的是 **`butler init` 印出来的那一行**。第 35 轮就是从这个缝里漏出去的：
 * `scanHint` 的 `butlerDir` 那时候是**可选参数**，`init` 的引导页和 `doctor` 的自检
 * 都漏传了它，TypeScript 一声没吭 —— "家安在别处"的用户照抄那条命令，凭据照样落回
 * `~/.butler`，而 CLI 在别处读：现象还是那句"探针说存好了，`butler run` 却说还没有 app_id"。
 *
 * 所以这条**不碰函数**：从 `init` 真实的输出里把命令抠出来（连引号一起），原样交给 shell
 * 跑一遍，再问 CLI 读不读得到。参数、默认位置的判断、输出格式 —— 改坏哪一处它都会红。
 */
test('★★ 家安在别处：从 `init` 输出里抠出的那条命令，照抄一遍真的管用', () => {
  const home = mkdtempSync(join(tmpdir(), 'butler-probe-init-'));
  const butler = join(home, '别处的家');
  const cfg = join(butler, 'config.json');

  try {
    const r = runSync(['init', '--config', cfg, '--im', 'feishu'], { home });
    assert.equal(r.code, 0, `init 该成功：\n${r.out}`);
    const cmd = /`(node [^`]+)`/.exec(r.out)?.[1];
    assert.ok(cmd, `引导里必须有一条能照着敲的命令：\n${r.out}`);
    assert.ok(cmd.includes(`--home="${butler}"`), `别处的家必须带上 --home=（实际：${cmd}）`);

    const run = spawnSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LARK_APP_ID: 'cli_init_contract',
        LARK_APP_SECRET: 'secret_init_contract',
        BUTLER_HOME: '',
      },
      // 4 秒和上面那条一样：`--save` 是**存盘在连接之前**的，所以被超时杀掉是**预期结局**
      //（探针会接着去连飞书；这一条要验的只是"凭据落在哪个家"）。
      timeout: 4000,
    });

    const file = join(butler, 'state', 'secrets.json');
    assert.ok(
      existsSync(file),
      '照抄那条命令之后，凭据必须落在**这个**家里（不是 ~/.butler）——'
        + `实际 stdout:\n${run.stdout}\n实际 stderr:\n${run.stderr}`,
    );
    assert.equal(secretOf(file, 'feishu', 'appId'), 'cli_init_contract');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * 家可以用两条路说：`--config`（CLI 的选项）和 `BUTLER_HOME`（探针的用法里写着的那条）。
 *
 * 第 37 轮之前它们**不是**一回事：探针认 `BUTLER_HOME`，CLI 只认 `~/.butler` —— 于是设了它的
 * 人会看到探针说"凭据已存进 <那个家>，下次 `butler run` 会直接用它"，而 CLI 在**另一个家里**
 * 读，现象还是那句"探针说存好了，`butler run` 却说还没有 app_id"。
 *
 * 这条不验"某一侧算得对"，验的是**两侧说的是同一个家**：CLI 把家安在 `$BUTLER_HOME`，
 * 它自己印出来的命令照抄一遍，再用 CLI 自己的读法读回来。
 */
test('★★ 设了 BUTLER_HOME：init 安的家、探针存的家、CLI 读的家是同一个', () => {
  const home = mkdtempSync(join(tmpdir(), 'butler-env-home-'));
  const butler = join(home, 'data'); // 家不在默认位置，而且是用**环境变量**说的

  try {
    const r = runSync(['init', '--im', 'feishu'], { home, env: { BUTLER_HOME: butler } });
    assert.equal(r.code, 0, `init 该成功：\n${r.out}\n${r.err}`);
    assert.ok(
      existsSync(join(butler, 'config.json')),
      `设了 BUTLER_HOME，init 就该把家安在那儿（不是 ~/.butler）：\n${r.out}`,
    );

    const cmd = /`(node [^`]+)`/.exec(r.out)?.[1];
    assert.ok(cmd, `引导里必须有一条能照着敲的命令：\n${r.out}`);
    // 它**就是**默认家（这条规则里 $BUTLER_HOME 优先），所以不必带 --home=、保持最短
    assert.ok(!cmd.includes('--home='), `$BUTLER_HOME 就是默认家，不必带 --home=（实际：${cmd}）`);

    // 原样交给 shell —— 就是用户把这句话粘进终端的动作
    spawnSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        BUTLER_HOME: butler,
        LARK_APP_ID: 'env_home_id',
        LARK_APP_SECRET: 'env_home_secret',
      },
      timeout: 4000,
    });

    const file = join(butler, 'state', 'secrets.json');
    assert.equal(secretOf(file, 'feishu', 'appId'), 'env_home_id', '探针该存进这个家');
    // ⭐ 这一步才是契约：用 CLI 自己的读法读到它 —— 探针那句"下次 butler run 直接用它"兑现
    assert.equal(
      readSecrets(file).channels.feishu?.appId,
      'env_home_id',
      'CLI 的读法要能读回探针写下的那个家',
    );

    // 反过来：显式给了 `--config` 就听它的 —— 环境变量只是**默认值**，不能压过明确的选项
    const other = join(home, 'another', 'config.json');
    const r2 = runSync(['init', '--config', other, '--im', 'feishu'], {
      home,
      env: { BUTLER_HOME: butler },
    });
    assert.equal(r2.code, 0, `init --config 该成功：\n${r2.out}\n${r2.err}`);
    assert.ok(existsSync(other), '`--config` 比 BUTLER_HOME 优先');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
