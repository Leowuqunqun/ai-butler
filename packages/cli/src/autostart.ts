/**
 * `butler autostart on|off|status` —— 让管家"开机就在"。
 *
 * 为什么非有不可：小白装完、扫码、把终端窗口一关，就以为管家一直在 ——
 * 其实进程是跟着那个窗口一起没的。让他自己记得每次重开是不现实的，
 * 所以我们替他把这件事交给操作系统：
 *
 *   · macOS：launchd 用户级 LaunchAgent（`~/Library/LaunchAgents/*.plist`）
 *   · Linux：systemd 用户级 unit（`~/.config/systemd/user/*.service`）
 *   · Windows：**还没做** —— 如实说，不假装（写一个跑不起来的注册表项最坏）
 *
 * 两个容易踩的坑，这里都处理了：
 *
 *   1. **PATH**。登录时系统给的 PATH 是最小集（`/usr/bin:/bin:…`），
 *      而管家干活要用的 `dsh` 装在 nvm/homebrew 里 —— 不把**现在这份 PATH**
 *      一起写进单元文件，自启动起来的管家会"找不到 dsh"。
 *   2. **弹浏览器**。单元文件里跑的是 `butler run --no-open` ——
 *      否则每次登录都弹一个页面出来，比不做还烦。
 *
 * 单元文件的内容是**纯函数**算出来的（`autostartPlan`），所以能离线测；
 * 跑命令那步可以注入（`run`），测试里一个字节都不碰真的 launchctl。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 跑一条命令的结果。测试注入它，就能不碰真的 launchctl/systemctl */
export type CommandRunner = (cmd: readonly string[]) => { ok: boolean; out: string };

export interface AutostartOptions {
  /** 家目录（测试用临时目录） */
  home?: string;
  platform?: NodeJS.Platform;
  /** 用哪个 node 跑（默认 `process.execPath`，必须是绝对路径） */
  nodePath?: string;
  /** 入口脚本 cli.js 的绝对路径 */
  cliPath?: string;
  /** 用哪份配置（默认 `~/.butler/config.json`） */
  configPath?: string;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  log?: (line: string) => void;
}

export interface AutostartPlan {
  /** 这套机制的人话名字 */
  kind: string;
  /** 单元文件写在哪 */
  file: string;
  /** 单元文件的内容 */
  content: string;
  /** 装上去要跑的命令（按顺序试，前一条不成再试下一条） */
  load: readonly (readonly string[])[];
  /** 摘下来要跑的命令 */
  unload: readonly (readonly string[])[];
  /** 查状态要跑的命令 */
  status: readonly (readonly string[])[];
}

/** 单元名。换名字等于换一个服务，别随手改 */
const LABEL = 'com.butler.hub';

/** plist 是 XML，路径里可能有 `&`/`<`（用户名里真出现过），必须转义 */
function xml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function defaultRunner(cmd: readonly string[]): { ok: boolean; out: string } {
  const [bin, ...rest] = cmd;
  if (!bin) return { ok: false, out: '空命令' };
  const r = spawnSync(bin, rest, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * 算出这台机器的自启动单元。`null` = 这个平台还没有（Windows）。
 *
 * 纯函数：不写文件、不跑命令，所以能直接对着内容做断言。
 */
export function autostartPlan(opts: AutostartOptions = {}): AutostartPlan | null {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const node = opts.nodePath ?? process.execPath;
  const cli = opts.cliPath ?? '';
  const config = opts.configPath ?? join(home, '.butler', 'config.json');
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  // ⚠️ **现在**这份 PATH 才是能干活的那份，见文件头的第 1 个坑
  const path = (opts.env ?? process.env).PATH ?? '';
  const logFile = join(home, '.butler', 'logs', 'autostart.log');
  const args = ['run', '--config', config, '--no-open'];

  if (platform === 'darwin') {
    const file = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${xml(LABEL)}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...[node, cli, ...args].map((a) => `    <string>${xml(a)}</string>`),
      '  </array>',
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      '    <key>PATH</key>',
      `    <string>${xml(path)}</string>`,
      '  </dict>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '  <key>KeepAlive</key>',
      '  <true/>',
      // 配置写错时会起来就死、死了就起，没有这个会刷屏刷到没法查
      '  <key>ThrottleInterval</key>',
      '  <integer>30</integer>',
      '  <key>StandardOutPath</key>',
      `  <string>${xml(logFile)}</string>`,
      '  <key>StandardErrorPath</key>',
      `  <string>${xml(logFile)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return {
      kind: 'launchd（macOS 登录项）',
      file,
      content,
      // bootstrap 是新写法；老系统/被裁过的 launchctl 上回退到 load -w
      load: [
        ['launchctl', 'bootstrap', `gui/${uid}`, file],
        ['launchctl', 'load', '-w', file],
      ],
      unload: [
        ['launchctl', 'bootout', `gui/${uid}/${LABEL}`],
        ['launchctl', 'unload', '-w', file],
      ],
      status: [['launchctl', 'print', `gui/${uid}/${LABEL}`]],
    };
  }

  if (platform === 'linux') {
    const file = join(home, '.config', 'systemd', 'user', 'butler.service');
    // systemd 的 ExecStart 不吃 shell 展开，带空格的路径要自己加引号
    const exec = [node, cli, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    const content = [
      '[Unit]',
      'Description=AI 管家（butler run）',
      'After=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${exec}`,
      'Restart=always',
      'RestartSec=30',
      `Environment=PATH=${path}`,
      `StandardOutput=append:${logFile}`,
      `StandardError=append:${logFile}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return {
      kind: 'systemd 用户级服务（Linux）',
      file,
      content,
      load: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', 'butler.service'],
      ],
      unload: [['systemctl', '--user', 'disable', '--now', 'butler.service']],
      status: [['systemctl', '--user', 'status', 'butler.service', '--no-pager']],
    };
  }

  return null;
}

/** 把计划原样念给用户听（`--dry-run` 用，一个字节都不写） */
export function formatPlan(plan: AutostartPlan): string {
  return [
    `机制：${plan.kind}`,
    `单元文件：${plan.file}`,
    '—— 文件内容 ——',
    plan.content.trimEnd(),
    '—— 装上去会跑 ——',
    ...plan.load.map((c) => `  ${c.join(' ')}`),
  ].join('\n');
}

function unsupported(platform: NodeJS.Platform): string {
  return [
    `自启动还没做 ${platform} 这一套（现在只有 macOS 的 launchd 和 Linux 的 systemd --user）。`,
    'Windows 上请手动把 `butler run --no-open` 放进"启动"文件夹，或者用任务计划程序。',
    '我们宁可说"还没做"，也不写一个你以为生效、其实跑不起来的注册表项。',
  ].join('\n');
}

function firstOk(run: CommandRunner, cmds: readonly (readonly string[])[]): { ok: boolean; out: string } {
  let last: { ok: boolean; out: string } = { ok: false, out: '' };
  for (const cmd of cmds) {
    last = run(cmd);
    if (last.ok) return last;
  }
  return last;
}

/** 装上自启动。返回进程退出码 */
export function autostartOn(opts: AutostartOptions = {}): number {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const run = opts.run ?? defaultRunner;
  const plan = autostartPlan(opts);
  if (!plan) {
    log(unsupported(opts.platform ?? process.platform));
    return 2;
  }

  mkdirSync(dirname(plan.file), { recursive: true });
  mkdirSync(dirname(join(opts.home ?? homedir(), '.butler', 'logs', 'autostart.log')), { recursive: true });
  writeFileSync(plan.file, plan.content, { mode: 0o644 });
  log(`✅ 写好了自启动单元（${plan.kind}）：${plan.file}`);

  const r = firstOk(run, plan.load);
  if (!r.ok) {
    log('⚠ 单元文件写好了，但没能**当场**装上去。它下次登录时也会被系统读到，');
    log('  或者你手动跑一次上面的命令。系统说：');
    log(`  ${r.out || '(没有输出)'}`);
    return 1;
  }
  log('✅ 自启动已生效：管家会在这台电脑登录后自己起来（不用开终端）。');
  log('  日志：~/.butler/logs/autostart.log');
  return 0;
}

/** 摘掉自启动。返回进程退出码 */
export function autostartOff(opts: AutostartOptions = {}): number {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const run = opts.run ?? defaultRunner;
  const plan = autostartPlan(opts);
  if (!plan) {
    log(unsupported(opts.platform ?? process.platform));
    return 2;
  }

  const had = existsSync(plan.file);
  if (had) {
    const r = firstOk(run, plan.unload);
    if (!r.ok) log(`（系统说：${r.out || '没有输出'} —— 文件还是会删掉）`);
    rmSync(plan.file, { force: true });
    log(`✅ 自启动摘掉了，单元文件也删了：${plan.file}`);
  } else {
    log('本来就没装自启动 —— 不用摘（配置和数据一个字节都没动）。');
  }
  return 0;
}

/** 看现在是什么状态。返回进程退出码 */
export function autostartStatus(opts: AutostartOptions = {}): number {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const run = opts.run ?? defaultRunner;
  const plan = autostartPlan(opts);
  if (!plan) {
    log(unsupported(opts.platform ?? process.platform));
    return 2;
  }

  if (!existsSync(plan.file)) {
    log('自启动：没装。装它：butler autostart on');
    return 0;
  }
  log(`自启动：装了（${plan.kind}）`);
  log(`单元文件：${plan.file}`);
  const r = firstOk(run, plan.status);
  // "没在跑"不等于报错：文件在、服务没起来，是最常见的坏状态，得让人看见
  log(r.ok ? '服务状态：在跑' : `服务状态：没在跑${r.out ? `（系统说：${r.out}）` : ''}`);
  return 0;
}
