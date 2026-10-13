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
