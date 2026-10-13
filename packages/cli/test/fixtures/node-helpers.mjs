/**
 * `butler node` 系列测试共用的工具。
 *
 * 这个文件**本身不含用例** —— 它只是被 `node-cli.mjs` 和 `m2-e2e.mjs` 一起用，
 * 免得"怎么起一个真节点进程"在两处各写一遍然后慢慢漂移。
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 从 fixtures/ 里回看包的根
const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = join(here, 'lib', 'cli.js');
export const AGENT = join(here, 'test', 'fixtures', 'plugins', 'node-agent.mjs');
export const CHANNEL = join(here, 'test', 'fixtures', 'plugins', 'plain-channel.mjs');
export const SECRET = 'a-long-enough-secret-for-tests';
/** CLI 自己打的那句。等到它就说明端口已经开好了（serve 在 start 之后） */
export const READY = '（Ctrl-C 下线）';

export const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 给子进程一个**自己的家**。
 *
 * 节点现在会把身份（id + 密钥）和配对收下的名册写在 `~/.butler/` 下。
 * 测试直接跑在真 `$HOME` 上的话，会往用户的家里写文件 —— 而且多个用例
 * 的 id 不一样时，还会互相把对方的身份文件顶掉。
 *
 * 所以每个子进程一个临时 HOME。**顺带钉住一件事**：管家自己的状态
 * 只应该落在 `$HOME` 下，别的地方（尤其仓库里）一个字节都不该有。
 */
export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'butler-home-'));
}

export async function waitFor(fn, what = '条件', ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error(`等不到：${what}`);
    await sleep(10);
  }
}

/** 要一个真实空闲端口：绑 0 拿号再放掉 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 写一份节点配置到临时目录，返回路径 */
export function nodeConfig(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-node-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ plugins: rows }, null, 2));
  return path;
}

/** 一条正常的节点行 */
export const agentRow = { id: 'agent', name: AGENT };
export const nodeRow = (port, config = {}) => ({
  id: 'node',
  name: '@butler/link-lan/node',
  config: { id: 'node-home', alias: '家里那台', secret: SECRET, port, host: '127.0.0.1', ...config },
});

/**
 * 写一个假 `tailscale` CLI：它只干一件事 —— 把一份名册打出来。
 *
 * 为什么可以拿假的：这条链路里**只有"问名册"这一步**是 Tailscale 特有的，
 * 后面全是 `link-lan` 那套 HTTP + SSE（这里是真节点、真往返）。
 * 真 CLI 的输出形状在 `@butler/link-tailscale` 里有用真机抓下来的夹具钉着。
 */
export function fakeTailscale(addresses, { state = 'Running' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'butler-fake-tail-'));
  const script = join(dir, 'tailscale');
  const json = JSON.stringify({
    BackendState: state,
    Self: { UserID: 1, DNSName: 'hub.test.ts.net.' },
    Peer: Object.fromEntries(addresses.map((address, i) => [`key${i}`, {
      ID: `tail-${i}`,
      HostName: `machine-${i}`,
      UserID: 1,
      OS: 'linux',
      Online: true,
      LastSeen: '2026-05-11T19:25:18.1Z',
      TailscaleIPs: [address],
    }])),
  });
  writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(json)});\n`);
  chmodSync(script, 0o755);
  return script;
}

/**
 * 起一个 `butler node` 进程，等它打出 READY。
 *
 * 顺带钉住一件事：**进程提前退出时，测试要拿到 stdout/stderr**。
 * 不然失败了只看到"unexpected exit"，还得手动重跑一遍才知道为什么。
 */
export function startNode(args, { timeoutMs = 15_000, home = tempHome() } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home },
  });
  let out = '';
  let err = '';
  let exited = null;

  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle.reject(new Error(`等「${READY}」超时。stdout:\n${out}\nstderr:\n${err}`));
  }, timeoutMs);

  child.stdout.on('data', (d) => {
    out += d;
    if (out.includes(READY)) { clearTimeout(timer); settle.resolve(); }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => {
    exited = code;
    clearTimeout(timer);
    settle.reject(new Error(`进程提前退出了（码 ${code}）。stdout:\n${out}\nstderr:\n${err}`));
  });

  return {
    child,
    ready,
    get out() { return out; },
    get err() { return err; },
    /** 按 Ctrl-C，等它体面退出 */
    async interrupt() {
      if (exited !== null) return exited;
      const done = new Promise((r) => child.once('exit', r));
      child.kill('SIGINT');
      const code = await done;
      clearTimeout(timer);
      return code;
    },
  };
}

/**
 * 一次性跑完的命令（会自己退出的那种）。
 *
 * `home` 可以显式给 —— 「先 init 再 doctor」这种要用**同一个家**的用例需要它；
 * 不给就一个新的临时家（互不干扰）。
 */
/**
 * 异步跑一次 CLI，把输出收回来。
 *
 * ⚠️ 跟 `runSync` 的区别不是风格，是**必须**：`spawnSync` 会阻塞本进程的事件循环，
 *   所以"测试自己起了个假服务器、CLI 去连它"这种用法一定会超时 ——
 *   服务器在同一个进程里，而那个进程正卡在 spawnSync 上。
 */
export function runAsync(args, { home = tempHome(), timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * 一次性跑完的命令（会自己退出的那种）。
 *
 * `home` 可以显式给 —— 「先 init 再 doctor」这种要用**同一个家**的用例需要它；
 * 不给就一个新的临时家（互不干扰）。
 *
 * `env` 用来加**额外的**环境变量（覆盖 `HOME` 之外的东西），例如 `BUTLER_HOME`
 * —— 那是"家在哪"的另一条说法，得能和 `HOME` 一起被测试指定。
 */
export function runSync(args, { home = tempHome(), env = {} } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
