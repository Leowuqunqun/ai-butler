/**
 * `butler` 命令的测试 —— 真的 **spawn 一个进程**跑构建产物。
 *
 *   node --test test/cli.mjs
 *
 * 为什么不用 import 直接调 `main()`：这个命令的价值全在**进程边界**上 ——
 * 退出码、stdout/stderr 分开、收到 SIGINT 之后要体面地退出。
 * 这些用 import 都测不到。而且顺带钉住一个真踩过的坑：
 * `butler` 这个 bin 是**符号链接**，主入口判断必须比 realpath
 *（直接比 `process.argv[1]` 的话命令一行都不会跑，还静默退出 0）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'lib', 'cli.js');
const FIX = join(here, 'fixtures');
const cfg = (name) => join(FIX, name);

/**
 * 跑一次命令，收集输出。
 * `interruptOn` 命中 stdout 里的一行时发 SIGINT（模拟用户按 Ctrl-C）。
 *
 * ⚠️ 等的必须是 **CLI 自己打的那句**（`Ctrl-C 退出`），不能是 `上线了`：
 * 内核的 start() 里夹具自己也会打一句 `core 上线了`，那会儿 CLI 还没装信号处理器，
 * SIGINT 一到进程就被默认动作砍死了（表现为退出码 null）。
 */
function runCli(args, { interruptOn = null, timeoutMs = 10_000, env = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // ⚠️ 只有需要临时家目录的用例才传 env（autostart 那条线：绝不能碰真 ~/Library）
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let out = '';
    let err = '';
    let interrupted = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
      if (interruptOn && !interrupted && out.includes(interruptOn)) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err });
    });
  });
}

// ───────────────────────── 基本命令 ─────────────────────────


/**
 * 一个**保证不存在**的路径：在一个新建的临时目录里取一个没建过的名字。
 *
 * ⚠️ 别硬编码 `/tmp/绝对不会存在` 这种哨兵路径 —— `/tmp` 是共享的，
 * 早先的测试跑过、或者别的工具建过，它就真存在了，然后这条断言开始
 * 无缘无故地红。这是实测踩过的（`/tmp/绝对没有这个目录-zzz` 真的在）。
 */
function missing(name) {
  return join(mkdtempSync(join(tmpdir(), 'gone-')), name);
}

test('--version 打印版本，退出 0', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.out.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help 打印用法，退出 0', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /butler run/);
  assert.match(r.out, /--patch/);
});

test('什么参数都不给：打印用法并退出 1（别静默什么都不做）', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 1);
  assert.match(r.out, /butler run/);
});

test('不认识的子命令：退出 1，用法走 stderr（错误输出别混进 stdout）', async () => {
  const r = await runCli(['fly']);
  assert.equal(r.code, 1);
  assert.match(r.err, /不认识这个子命令：fly/);
  assert.match(r.err, /butler run/, '用法要跟着错误一起给，不能只丢一句"不认识"');
  assert.equal(r.out, '', '出错时 stdout 应当是干净的');
});

test('--config 后面没跟东西：说清楚，退出 1', async () => {
  const r = await runCli(['run', '--config']);
  assert.equal(r.code, 1);
  assert.match(r.err, /--config 后面要跟一个文件路径/);
});

test('配置文件不存在：**点名是哪个文件**，并且给一行能直接抄的命令', async () => {
  const path = missing('config.json');
  const r = await runCli(['run', '--config', path]);
  assert.equal(r.code, 1);
  // 要说清是哪个文件 —— 用户手里可能有四五份配置
  assert.ok(r.err.includes(path), `错误里没带路径：${r.err}`);
  // 而且不能只说"文件不存在"就完了：他该做的是跑这一行（它真会把配置写好）
  assert.match(r.err, /butler init --config /);
  assert.ok(r.err.includes(path), 'init 那一行也得带上他刚才用的路径');
});

test('上线这一步炸了（比如扫码超时）：说那一句话，不给一棵栈', async () => {
  const r = await runCli(['run', '--config', cfg('config-start-fails.json')]);

  assert.equal(r.code, 1);
  assert.match(r.err, /起不来：登录超时/);
  assert.match(r.err, /重新跑一次 butler run/, '通道给出的下一步不能被吞掉');
  assert.doesNotMatch(r.err, /\n\s+at /, `不要打栈：${r.err}`);
});

test('扫码中途按 Ctrl-C：不当成故障，退出码 0', async () => {
  // 用户自己按的取消不是"出错了" —— 报成故障会让他以为弄坏了什么
  const r = await runCli(['run', '--config', cfg('config-start-cancel.json')]);

  assert.equal(r.code, 0, `取消不该是非零退出码。stderr:\n${r.err}`);
  assert.match(r.out, /已经退出/);
  assert.doesNotMatch(r.err, /起不来/, '取消不是"起不来"');
});

// ───────────────────────── 上线与退出 ─────────────────────────

test('run：装载 → 上线 → Ctrl-C → 体面退出', async () => {
  const r = await runCli(['run', '--config', cfg('config-cli.json')], { interruptOn: 'Ctrl-C 退出' });

  assert.equal(r.code, 0, `应当退出 0，实际 ${r.code}（stderr：${r.err}）`);
  assert.match(r.out, /✓ {2}demo/);
  assert.match(r.out, /✓ {2}core/);
  assert.match(r.out, /\[stub\] core 上线了/, '内核真的被 start 了');
  assert.match(r.out, /已退出/);
});

test('run：Ctrl-C 之后插件的收尾真的跑了（不是直接被砍死）', async () => {
  const r = await runCli(['run', '--config', cfg('config-cli.json')], { interruptOn: 'Ctrl-C 退出' });
  // 容器卸载插件靠的是 ctx.effect 的 teardown（真内核就是这么写自己的收尾的），
  // CLI 这边只负责 dispose —— 这条钉的是"那条路真的通到插件"
  assert.match(r.out, /\[stub\] core 下线了/, '不收尾的话微信那边的连接不会体面断开');
  assert.equal(r.signal, null, '不该被信号砍死');
});

// ───────────────────────── patch 真的生效 ─────────────────────────

test('run --patch：补丁真的叠加到了，而且是端到端生效的', async () => {
  const r = await runCli(
    ['run', '--config', cfg('config-cli.json'), '--patch', cfg('patch-workspace.json')],
    { interruptOn: 'Ctrl-C 退出' },
  );
  assert.equal(r.code, 0, `stderr：${r.err}`);
  assert.match(r.out, /被补丁改过的目录/, '补丁里的 config 应当传到了插件手里');
  assert.equal(r.out.includes('workspace=/tmp'), false, 'base 里的值应当被整体替换掉，不是并存');
});

test('run --patch：补丁文件不存在 → 退出 1 且点名', async () => {
  const r = await runCli(['run', '--config', cfg('config-cli.json'), '--patch', '/tmp/没有这个补丁-zzz.json']);
  assert.equal(r.code, 1);
  assert.match(r.err, /没有这个补丁-zzz\.json/);
});

// ───────────────────────── 装不上时的表现 ─────────────────────────

test('有一行装不上：把行名和原因打出来，退出 1，**不装作没事**', async () => {
  const r = await runCli(['run', '--config', cfg('config-broken.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /✗ {2}broken/, '要指名道姓哪一行坏了');
  assert.match(r.err, /这个包根本没装好/);
  assert.match(r.err, /没装上来/);
});

test('少了 core 这一行：说清楚缺什么、以及那行长什么样', async () => {
  const r = await runCli(['run', '--config', cfg('config-nocore.json')]);
  assert.equal(r.code, 1);
  assert.match(r.err, /没有 core 这一行/);
  assert.match(r.err, /"id": "core"/, '要直接给出可粘贴的那一行 —— 而不是让用户去翻文档');
});

test('配置里关掉的行：报出来，但不拦着启动', async () => {
  const r = await runCli(['run', '--config', cfg('config-disabled.json')], { interruptOn: 'Ctrl-C 退出' });
  assert.equal(r.code, 0, `stderr：${r.err}`);
  assert.match(r.out, /关掉了/);
  assert.match(r.out, /上线了/);
});

// ───────────────────────── doctor ─────────────────────────

test('doctor：一切正常时退出 0，四段都打出来', async () => {
  const r = await runCli(['doctor', '--config', cfg('config-doctor.json')]);
  assert.equal(r.code, 0, `stderr：${r.err}`);
  for (const sec of ['环境', '配置', '装载', '能力位']) {
    assert.match(r.out, new RegExp(`\\n${sec}\\n`), `少了「${sec}」这一段`);
  }
  assert.match(r.out, /可以 `butler run` 了/);
});

test('doctor：**绝不启动任何东西**（诊断工具不能有副作用）', async () => {
  const r = await runCli(['doctor', '--config', cfg('config-cli.json')]);
  assert.equal(r.out.includes('[stub] core 上线了'), false,
    'doctor 只该自检，不该把内核 start 起来 —— 那会真连上微信');
});

test('doctor：有问题时退出 1，并把"该干什么"打出来', async () => {
  const r = await runCli(['doctor', '--config', cfg('config-broken.json')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ {2}broken/);
  assert.match(r.out, /这个包根本没装好/);
  assert.match(r.out, /改完再跑一次 doctor/);
});

test('doctor：配置读不了也退 1 且有话说（诊断工具不能自己炸）', async () => {
  const r = await runCli(['doctor', '--config', missing('config.json')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /文件不存在/);
  assert.match(r.out, /→ /, '要给一句 fix');
});

test('doctor：--patch 也认，并且把实际读的文件打出来', async () => {
  const r = await runCli(['doctor', '--config', cfg('config-doctor.json'), '--patch', cfg('patch-workspace.json')]);
  assert.equal(r.code, 0, `stderr：${r.err}`);
  assert.match(r.out, /实际读的文件/);
  assert.match(r.out, /patch-workspace\.json/);
});

// ─────────────────────── 自启动（autostart）───────────────────────

/**
 * ⚠️ 这里**故意不测** `autostart on` 真的装上去那一步：那会在跑测试的这台机器上
 * 真装一个 launchd/systemd 登录项出来。所以分开验：
 *
 *   · 单元文件内容、装上/摘下的命令、失败回退 —— `test/autostart.mjs`（注入假 runner）
 *   · 命令分派、--dry-run 真的什么都不写、参数归属 —— 这里（真进程）
 */
function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'butler-cli-home-'));
}

test('autostart --dry-run：念出单元文件和命令，一个字节都不写', async () => {
  const home = tmpHome();
  const r = await runCli(['autostart', '--dry-run'], { env: { HOME: home } });
  assert.equal(r.code, 0, `stderr：${r.err}`);
  assert.match(r.out, /com\.butler\.hub\.plist|butler\.service/, '要说清文件写哪');
  assert.match(r.out, /--no-open/, '自启动起来的命令里必须带 --no-open');
  assert.match(r.out, /--dry-run：上面这些一个字节都还没真的做/);
  assert.deepEqual(readdirSync(home), [], 'dry-run 不许写任何东西');
  rmSync(home, { recursive: true, force: true });
});

test('autostart（不给动作）= status：没装就明说没装，别吓人', async () => {
  const home = tmpHome();
  const r = await runCli(['autostart'], { env: { HOME: home } });
  assert.equal(r.code, 0, `stderr：${r.err}`);
  assert.match(r.out, /没装/);
  assert.match(r.out, /butler autostart on/, '要告诉他怎么装');
  rmSync(home, { recursive: true, force: true });
});

test('autostart 后面跟个不认识的动作：说清楚认哪几个', async () => {
  const home = tmpHome();
  const r = await runCli(['autostart', 'everyday'], { env: { HOME: home } });
  assert.equal(r.code, 2);
  assert.match(r.err, /不认 everyday/);
  assert.match(r.err, /on \/ off \/ status/);
  rmSync(home, { recursive: true, force: true });
});

test('★ 参数不串门：--dry-run 只归 autostart，--no-open 只归 run/node', async () => {
  const a = await runCli(['doctor', '--dry-run']);
  assert.equal(a.code, 1);
  assert.match(a.err, /--dry-run 只有 autostart 认/);

  const b = await runCli(['doctor', '--no-open']);
  assert.equal(b.code, 1);
  assert.match(b.err, /--no-open 只有 run \/ node 认/);
});

test('--help 里看得到 --again（换一把 key/token 的时候用）', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--again[\s\S]*再问一遍/);
});

test('--again 不许串门：只有 run / node 认它', async () => {
  const r = await runCli(['init', '--again']);
  assert.equal(r.code, 1, '参数用错要非零退出');
  assert.match(r.err, /--again 只有 run \/ node 认/);
});

test('--help 里看得到 autostart', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /butler autostart on\|off\|status/);
});

test('--help 里看得到 BUTLER_HOME（"家在哪"的第二条说法）', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  // 别只印一个名字：要说清它和 --config 谁优先（不然用户不知道该信哪条）
  assert.match(r.out, /--config <文件>[\s\S]*BUTLER_HOME[\s\S]*仍然优先/);
  // 还有一处更实际的：init 会写到那底下 —— 这段原来写死了 ~/.butler
  assert.match(r.out, /init 写这两份[\s\S]*BUTLER_HOME/);
});
