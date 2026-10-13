#!/usr/bin/env node
/**
 * `butler` —— AI 管家的命令行入口。
 *
 *   butler init [--node] [--link lan|tailscale] [--im wechat|telegram|feishu]   第一次用：把配置写好
 *   butler run [--config <文件>] [--patch <文件>]...
 *   butler --help
 *
 * 配置默认读 `~/.butler/config.json`，**由 `butler init` 生成**：
 *
 *   butler init          收微信的那台
 *   butler init --node   被遥控的那台
 *
 * 用户不该手写这个文件 —— 插件名字、绝对路径、该有几行，
 * 每一样都是"填错一个字符就装不上、而且看不出为什么"。详见 setup.ts。
 *
 * @module @butler/cli/cli
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { boot, type Booted } from './boot.js';
import { doctor, formatDoctor } from './doctor.js';
import { collectReport, writeReport } from './report.js';
import {
  DEFAULT_CONFIG_PATH, IM_NAMES, LINK_NAMES, coreStateFileMissing, initButlerHome, missingAbilityRows,
  type ImName, type LinkName,
} from './setup.js';
import { autostartOff, autostartOn, autostartPlan, autostartStatus, formatPlan } from './autostart.js';
import { dshAgentHome, ensureChannelSecrets, ensureModelKey } from './onboarding.js';
import { loadConfig } from './config.js';
import { scanHint } from '@butler/channel-feishu/probe-path';
import { injectChannelSecrets, secretsFileOf } from './secrets.js';
import { keyRefOf } from './credentials.js';

/**
 * `butler autostart on|off|status` —— 让管家开机自己起来。
 *
 * 这里只管进程级的事实（入口脚本的绝对路径、用哪份配置），
 * 单元文件怎么长、命令怎么跑都在 `autostart.ts` 里（那边是纯函数，能离线测）。
 */
function runAutostart(args: Args): number {
  const cliPath = cliPathOf();
  const opts = {
    cliPath,
    configPath: args.config,
    log: (line: string): void => console.log(line),
  };

  if (args.dryRun) {
    const plan = autostartPlan(opts);
    // 这个平台还没做（Windows）→ 借 status 把"还没做"那句人话打出来
    if (!plan) return autostartStatus(opts);
    console.log(formatPlan(plan));
    console.log('（--dry-run：上面这些一个字节都还没真的做）');
    return 0;
  }

  const action = args.rest[0] ?? 'status';
  if (action === 'on') return autostartOn(opts);
  if (action === 'off') return autostartOff(opts);
  if (action === 'status') return autostartStatus(opts);
  console.error(`autostart 后面跟 on / off / status，不认 ${action}`);
  return 2;
}

/**
 * 入口脚本的**真实**路径（`butler` 这个 bin 是符号链接，自启动里必须写真实路径 ——
 * 登录时不一定有那个链接所在目录）。
 */
function cliPathOf(): string {
  const invoked = process.argv[1] ?? fileURLToPath(import.meta.url);
  try {
    return realpathSync(invoked);
  } catch {
    return invoked;
  }
}

const HELP = `AI 管家 —— 用微信遥控你的电脑

用法：
  butler init [选项]           第一次用：把配置写好（**你什么都不用填**）
  butler run [选项]            读配置、拉起容器、上线（**收微信的那台机器**用这个）
  butler report [--out 文件]   出事时生成一份报告（**不含你的任何 key**，直接发给帮你的人）
  butler node [选项]           当节点：把这台电脑的 agent 摊给中枢用（**被遥控的那台**用这个）
  butler doctor [选项]         自检：把"为什么没反应"查出来（不改任何东西）
  butler autostart on|off|status 让管家"开机自己起来"（关掉终端窗口也不怕）

第一次用，两条命令：

  butler init                  把默认配置写好，你不用编辑
  butler run                   起来之后手机上扫码

选项：
  --no-open                    别开浏览器（自启动时每登录弹一次会很烦）
  --again                      已经贴过的 key / token 也再问一遍（想换一把的时候用）
  --dry-run                    只说要干什么，一个字节都不写（只有 autostart 认）
  --config <文件>              主配置。默认 ~/.butler/config.json
  --patch <文件>               叠加在上面的补丁，可以给多次，后写的赢
  --node                       给**被遥控的那台**写配置（只对 init 有意义）
  --im wechat\|telegram\|feishu  这一台用哪个 IM 收信（不给 = 保持现在这个；首次是 wechat）
  --link lan\|tailscale        这一台怎么找别的机器（默认 lan = 同一个 WiFi）
                               跨网（电脑在家、你在外面）选 tailscale：
                               装好 Tailscale、两台登同一个账号，然后别填密钥 ——
                               设备是在微信里「配对」一台台收进来的
  -h, --help                   看这个
  --out <文件>                 报告写到哪儿（只有 report 认）
  -v, --version                看版本

butler init 写这两份（已经存在的一律不动）：

  ~/.butler/config.json        装哪几个插件（五行：通道 / agent / 内核 / 记忆 / 链路）
  ~/.butler/dsh.patch.yml      给 agent 的补丁：模型通道 + 人格

  **模型 key 不在这两份文件里** —— 它走 DSH 自己的凭据库。所以这里不问你 key。

配置格式（JSON，patch 用同一套语义）：

  {
    "plugins": [
      { "id": "channel", "name": "wechat-agent-bridge/plugin", "config": { } },
      { "id": "agent",   "name": "@butler/agent-dsh", "config": { } },
      { "id": "core",    "name": "@butler/core", "config": { "workspace": "/你要它管的目录" } },
      { "id": "memory",   "name": "@butler/memory-file", "config": { } },
      { "id": "approval", "name": "@butler/approval-im", "config": { } }
    ]
  }

  id     行的地址。patch 靠它找到要覆盖哪一行
  name   模块名（从应用自己的目录找）或路径（./x 从配置所在目录找）
  config 原样交给插件。patch 覆盖它是**整体替换**，不是深合并

butler run 的配置五行里前三行缺一不可：channel 负责收发，agent 负责干活，
core 把两头接起来。后两行是可选的：memory 让它记住你说过的事（默认就有），
link 只在你要遥控别的电脑时才用得上（默认也有）。

butler node 的配置**没有** channel、也**没有** core —— 节点不登录微信：

  {
    "plugins": [
      { "id": "agent", "name": "@butler/agent-dsh", "config": { } },
      { "id": "node",  "name": "@butler/link-lan/node", "config": { "alias": "家里那台" } }
    ]
  }

  alias  你在微信里叫它的名字（id 和密钥它自己生成，定下就别改）
`;

interface Args {
  command: string;
  config: string;
  patches: string[];
  help: boolean;
  version: boolean;
  /** `init --node`：给被遥控的那台写配置 */
  node: boolean;
  /** `init --im telegram`：这一台用哪个 IM 收信（一次只能上一个） */
  im?: ImName;
  /** `init --link tailscale`：这一台怎么找别的机器（同一个 WiFi / 尾巴网络） */
  link?: LinkName;
  /** `report --out 文件`：报告写到哪儿 */
  out?: string;
  /** `--no-open`：起页面但别开浏览器（自启动场景） */
  open: boolean;
  /** `autostart --dry-run`：只说要干什么 */
  dryRun: boolean;
  /** `--again`：就算已经有 key / token 也重新问一遍（想换一把的时候） */
  again: boolean;
  /** 命令后面的位置参数（目前只有 `autostart on|off|status` 用） */
  rest: string[];
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    command: '',
    config: join(homedir(), '.butler', 'config.json'),
    patches: [],
    help: false,
    version: false,
    node: false,
    open: true,
    dryRun: false,
    again: false,
    rest: [],
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--node') args.node = true;
    else if (a === '--im') {
      const v = argv[++i];
      if (!v) throw new Error(`--im 后面要跟一个名字（${IM_NAMES.join(' / ')}）`);
      args.im = v as ImName;
    } else if (a.startsWith('--im=')) args.im = a.slice('--im='.length) as ImName;
    else if (a === '--link') {
      const v = argv[++i];
      if (!v) throw new Error(`--link 后面要跟一个名字（${LINK_NAMES.join(' / ')}）`);
      args.link = v as LinkName;
    } else if (a.startsWith('--link=')) args.link = a.slice('--link='.length) as LinkName;
    else if (a === '--no-open') args.open = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--again') args.again = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a === '--config') {
      const v = argv[++i];
      if (!v) throw new Error('--config 后面要跟一个文件路径');
      args.config = v;
    } else if (a.startsWith('--config=')) args.config = a.slice('--config='.length);
    else if (a === '--patch') {
      const v = argv[++i];
      if (!v) throw new Error('--patch 后面要跟一个文件路径');
      args.patches.push(v);
    } else if (a.startsWith('--patch=')) args.patches.push(a.slice('--patch='.length));
    else if (a === '--out') {
      const v = argv[++i];
      if (!v) throw new Error('--out 后面要跟一个文件路径');
      args.out = v;
    } else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (!a.startsWith('-') && !args.command) args.command = a;
    else rest.push(a);
  }
  // `autostart on` 后面那个词是位置参数；别的命令多给了就是打错字
  if (rest.length && args.command !== 'autostart') throw new Error(`不认识的参数：${rest.join(' ')}`);
  args.rest = rest;
  return args;
}

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function report(b: Booted): void {
  for (const row of b.config.disabled) {
    console.log(`  ·  ${row.id}（配置里关掉了）`);
  }
  for (const row of b.loaded) {
    console.log(`  ✓  ${row.id}  ${row.name}`);
  }
  for (const f of b.failures) {
    console.error(`  ✗  ${f.id}  ${f.name}`);
    console.error(`     ${f.message}`);
  }
}

/**
 * 缺配置时该说什么。
 *
 * 以前这里是"配置读不了：文件不存在"，然后就没有下文了 —— 用户能做的只有猜。
 * 现在只给一行能抄的命令，而且那一行**真的会把文件写好**。
 */
function noConfig(path: string, node: boolean): number {
  console.error(`还没有配置：${path}`);
  console.error('\n跑一次这个就好 —— 它会把默认配置写好，你什么都不用填：\n');
  const flag = path === DEFAULT_CONFIG_PATH ? '' : ` --config ${path}`;
  console.error(`  butler init${flag}${node ? ' --node' : ''}`);
  return 1;
}

async function run(args: Args): Promise<number> {
  if (!existsSync(args.config)) return noConfig(args.config, false);
  console.log(`读配置：${args.config}`);
  for (const p of args.patches) console.log(`  补丁：${p}`);

  // 老配置升上来的：能力行还没补。**run 不写文件**（刻意的，见上面的注释），
  // 但一定要说一句 —— 不说的话，他碰到的是一连串"它就是不动"，
  // 而真正的原因藏在一份他根本不知道要打开的 JSON 里。
  const missing = missingAbilityRows(args.config);
  if (missing.length) {
    console.log(`\n  ⚠️ 配置里少了 ${missing.length} 样：${missing.map(rowLabel).join('、')}`);
    console.log('  跑一次 butler init 就会补上（没补上之前，要动你电脑的事它会一律拒绝）。');
    console.log('  你原来改过的东西一个都不会动。\n');
  }
  // 老配置的内核行没有 `stateFile`：账本只在内存里 —— **认主重启就忘**（企业租户里
  // `dmMode` 默认 open，"谁先说话谁当家"会一次次重来）。`run` 不写文件，但要说一句，
  // 不然用户会照着手册去改一个根本不存在的 `state/state.json`。
  if (coreStateFileMissing(args.config)) {
    console.log('\n  ⚠️ 这份配置的内核行没有 stateFile：认主只在内存里 —— 重启之后第一个说话的人又会成为主人。');
    console.log('  跑一次 butler init 会把它补上（你改过的值一个都不会动）。\n');
  }

  let b: Booted;
  try {
    // 通道凭据（Telegram 的 bot token）必须在**装进容器之前**填进行里：
    // 插件的 config 是构造时读进去的 —— 装上了再改那个对象是不生效的。
    const rows = loadConfig(args.config, args.patches).rows;
    await ensureChannelSecrets(rows, {
      butlerDir: dirname(args.config),
      log: (line) => console.log(line),
      ...(args.open ? {} : { autoOpen: false }),
      ...(args.again ? { force: true } : {}),
    });
    b = await boot({ configPath: args.config, patches: args.patches, rows });
  } catch (error) {
    console.error(`\n配置读不了：${(error as Error).message}`);
    return 1;
  }

  console.log('\n装载：');
  report(b);

  if (b.failures.length) {
    console.error(`\n有 ${b.failures.length} 个插件没装上来。修好再启动，或者先跑 butler doctor 看看。`);
    await b.dispose();
    return 1;
  }

  // 模型 key 属于 **agent** 那一层，所以这一关放在通道/内核的检查之前：
  // 缺通道是配置问题，缺 key 是"没法思考"，先说更根本的那个。
  const dsh = dshAgentHome(b.loaded);
  if (dsh) {
    await ensureModelKey({
      dshHome: dsh.home,
      ref: keyRefOf(existsSync(dsh.patchFile) ? readFileSync(dsh.patchFile, 'utf8') : ''),
      log: (line) => console.log(line),
      // `--no-open`：自启动起来的管家不该每次登录都弹一个页面出来
      ...(args.open ? {} : { autoOpen: false }),
      ...(args.again ? { force: true } : {}),
    });
  }

  const core = (b.ctx as { core?: { start(): Promise<void>; stop(): Promise<void> } }).core;
  if (!core) {
    console.error('\n配置里没有 core 这一行 —— 通道和大脑都就位了，但没人把它们接起来。');
    console.error('缺的那行长这样：{ "id": "core", "name": "@butler/core", "config": { "workspace": "…" } }');
    await b.dispose();
    return 1;
  }

  // ⚠️ 装载成功**不等于**上得了线：通道可能正在等用户扫码，超时就抛在这儿。
  // 不接住的话，用户看到的是一棵栈 —— 而这恰恰是他最可能撞上的那一步
  // （十二分钟没人扫，通道就超时了）。
  //
  // 还有一件容易漏的：**扫码可能等十几分钟**，这段时间里按 Ctrl-C 也得管用。
  // 所以信号处理要在这之前就装上 —— 否则用户按下 Ctrl-C，进程是硬死的，
  // 扫码页还挂在那儿，他会以为没退干净。
  const onSignal = (): void => { void core.stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    await core.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 用户自己按的 Ctrl-C 不是故障，别报成故障，也别给非零退出码
    if (/取消/.test(message)) {
      console.log('\n已经退出。');
      await b.dispose();
      return 0;
    }
    console.error(`\n起不来：${message}`);
    console.error('插件都装上了，是"上线"这一步没过 —— 上面那句就是原因。');
    await b.dispose();
    return 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  await serve('上线了。用微信给它发句话试试。（Ctrl-C 退出）');

  console.log('\n正在退出…');
  await b.dispose();
  console.log('已退出。');
  return 0;
}

/**
 * 节点那一行提供的东西。
 *
 * **结构化声明，不 import 具体包** —— CLI 不该跟某个链路实现耦合。
 * 换一个链路实现（tailscale/ssh），只要它也开一段端口、也说得出自己是谁，这段照跑。
 */
interface NodeLike {
  /** 这台机器在中枢那边叫什么 */
  alias: string;
  /** 真的在监听时才有 */
  address: { host: string; port: number } | null;
  start(): Promise<void>;
  /** 局域网里能用哪些地址连过来（可选，只为打得好看） */
  lanAddresses?(): string[];
  /** 配对要用的那一行（可选，只为打得好看） */
  pairingInfo?(): {
    code: string; expiresAt: number; state: 'live' | 'used' | 'burned';
    addresses: string[]; loopbackOnly: boolean;
  };
}

/**
 * `butler node` —— 当节点：把这台电脑的 agent 摊给中枢用。
 *
 * 跟 `butler run` 是**同一条流水线**（读配置 → 装容器 → 等退出），
 * 只差两件事：要的是 `ctx.node` 而不是 `ctx.core`，以及下面那道安全闸。
 */
async function runNode(args: Args): Promise<number> {
  if (!existsSync(args.config)) return noConfig(args.config, true);
  console.log(`读配置：${args.config}`);
  for (const p of args.patches) console.log(`  补丁：${p}`);

  let b: Booted;
  try {
    b = await boot({ configPath: args.config, patches: args.patches });
  } catch (error) {
    console.error(`\n配置读不了：${(error as Error).message}`);
    return 1;
  }

  console.log('\n装载：');
  report(b);

  if (b.failures.length) {
    console.error(`\n有 ${b.failures.length} 个插件没装上来。修好再启动，或者先跑 butler doctor 看看。`);
    await b.dispose();
    return 1;
  }

  // ── 安全闸：节点上不该有微信通道 ──
  // 这不是洁癖：同一个微信号被两个进程同时长轮询，消息会**随机**落到其中一边。
  // 用户看到的是"有时回有时不回"，而两边日志都正常 —— 极难查。
  // 所以宁可拒绝启动，也不让这个状态出现。
  if (b.has('channel')) {
    console.error('\n这份配置里有微信通道 —— 节点不该登录微信。');
    console.error('同一个微信号被两个进程同时收信，消息会随机分到两边，看起来就是"时好时坏"。');
    console.error('节点那份配置只留 agent 和 node 两行；收微信的那台机器用 butler run。');
    await b.dispose();
    return 1;
  }

  const node = (b.ctx as { node?: NodeLike }).node;
  if (!node) {
    console.error('\n配置里没有节点那一行 —— agent 就位了，但没人开端口给中枢连。');
    console.error('缺的那行长这样：{ "id": "node", "name": "@butler/link-lan/node", "config": { "alias": "家里那台" } }');
    await b.dispose();
    return 1;
  }

  try {
    // 节点也要能自己思考才干活。但它很可能**没有浏览器**（你是 SSH 进来的），
    // 所以这一关只等 60 秒：坐在这台机器前的人来得及贴，远程的人不至于干等十分钟。
    const dsh = dshAgentHome(b.loaded);
    if (dsh) await askForNodeKey(dsh, args);

    await node.start();
  } catch (error) {
    console.error(`\n起不来：${error instanceof Error ? error.message : String(error)}`);
    await b.dispose();
    return 1;
  }

  console.log(`\n节点「${node.alias}」上线了。`);
  const addr = node.address;
  if (addr) console.log(`  监听：${addr.host}:${addr.port}`);

  // ── 把这一行打给用户，就是全部的安装了 ──
  //
  // 以前这里写的是"去中枢那台机器的配置里，把它填进 link 的 peers，再加上一把
  // 两边都一样的密钥"。对一个不懂技术的人来说，那一步就是终点：文件在哪、
  // 引号要不要、密钥抄错一位 —— 每一种都是"连不上，但不说为什么"。
  //
  // 现在只有一句话要做：**把下面这一行发到微信里。**
  const info = node.pairingInfo?.();
  const lan = info?.addresses.length ? info.addresses : (node.lanAddresses?.() ?? []);

  if (info) {
    if (lan.length) {
      console.log('\n  把这台电脑交给管家 —— 在收微信的那台机器上，用微信发下面这一行');
      console.log('  （可以复制，别手打）：\n');
      for (const a of lan) console.log(`      配对 ${a} ${info.code}`);
    } else {
      // 没网卡地址时不能说"配对 0.0.0.0:41338" —— 那个地址中枢够不着，
      // 用户照着发只会得到"连不上"，而且猜不出为什么
      console.log('\n  这台电脑现在没有局域网地址（没连上网络？）。连上网再重起这个命令。');
    }
    // 只听本机还照样打一行让人去配对，等于让他撞一次墙：中枢在另一台机器上，
    // 一定会得到"连不上"，而且从这句话里看不出是自己配错了。
    if (info.loopbackOnly) {
      console.log('\n  ⚠ 这份配置里只听本机（host 是 127.0.0.1）—— 别的电脑连不上它。');
      console.log('    要让别的电脑能连，把配置里 host 改成 0.0.0.0 再重起。');
    }

    const minutes = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60_000));
    console.log(`\n  配对码 ${info.code} 只能用一次，${minutes} 分钟后作废。`);
    console.log('  过期或者抄错了，重起这个命令就会换一个新的。');
  }

  await serve('（Ctrl-C 下线）');

  console.log('\n正在下线…');
  await b.dispose();
  console.log('已下线。');
  return 0;
}

/**
 * 上线，然后等一个退出信号。
 *
 * 两件事都是踩出来的，别顺手改掉：
 *
 * ① **必须自己 hold 住事件循环。** 光挂一个信号监听是没用的：一个还没 resolve
 *    的 Promise 不算"活"，`process.once('SIGINT')` 也不算 —— 没有别的 handle 时
 *    Node 会直接退出。（实测：命令打印完"上线了"就自己退了，看起来像启动失败。）
 *    真实场景里通道有自己的轮询 handle 撑着，所以这个 bug 平时不显形 ——
 *    但"看起来在线"和"真的在线"是两回事，常驻进程就该自己说清楚。
 *
 * ② **先装好处理器，再宣布"上线了"。** 反过来会有一个真实的竞态窗口：
 *    用户（或脚本）一看到"上线了"就按 Ctrl-C，而那一刻处理器还没装上，
 *    进程会被默认动作直接砍死 —— 内核的 stop() 不会跑，微信那边的连接
 *    不会体面断开。窗口很窄，但它是真的（测试里稳定复现过）。
 */
async function serve(hint: string): Promise<void> {
  const keepAlive = setInterval(() => { /* 只为 hold 住事件循环 */ }, 1 << 30);

  let bye!: () => void;
  const done = new Promise<void>((resolve) => { bye = resolve; });
  process.once('SIGINT', bye);
  process.once('SIGTERM', bye);

  console.log(`\n${hint}`);

  try {
    await done;
  } finally {
    // `once` 跑过就自己摘了；没跑过的话（比如正常流程之外）在这儿补摘，别留悬挂监听
    process.off('SIGINT', bye);
    process.off('SIGTERM', bye);
    clearInterval(keepAlive);
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  if (args.version) { console.log(version()); return; }
  if (args.help) { console.log(HELP); return; }
  if (!args.command) { console.log(HELP); process.exitCode = 1; return; }

  // 参数别互相串门：--dry-run 是 autostart 的，--no-open 只有会起页面的命令有
  if (args.again && args.command !== 'run' && args.command !== 'node') {
    console.error('--again 只有 run / node 认（只有它们会问你要 key）。\n');
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (args.out && args.command !== 'report') {
    console.error('--out 只有 report 认（别的命令不生成文件给你）。\n');
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (args.dryRun && args.command !== 'autostart') {
    console.error('--dry-run 只有 autostart 认（别的命令都是"你说一句它做一件"）。\n');
    console.error(HELP);
    process.exitCode = 1;
    return;
  }
  if (!args.open && args.command !== 'run' && args.command !== 'node') {
    console.error('--no-open 只有 run / node 认（只有它们会起那个页面）。\n');
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  if (args.command === 'init') {
    process.exitCode = runInit(args);
    return;
  }
  if (args.command === 'doctor') {
    process.exitCode = await runDoctor(args);
    return;
  }
  if (args.command === 'report') {
    process.exitCode = await runReport(args);
    return;
  }
  if (args.command === 'node') {
    process.exitCode = await runNode(args);
    return;
  }
  if (args.command === 'autostart') {
    process.exitCode = runAutostart(args);
    return;
  }
  if (args.command !== 'run') {
    console.error(`不认识这个子命令：${args.command}\n`);
    console.error(HELP);
    process.exitCode = 1;
    return;
  }

  process.exitCode = await run(args);
}

/**
 * `butler init` —— 把家安好，然后告诉用户**接下来做什么**。
 *
 * 这一条命令存在的唯一理由：让一个完全不懂技术的人**没有配置文件要写**。
 * 所以它一次把该有的都写好，而且**只写缺的**（后一条更重要：用户可能已经
 * 在里面加过设备、改过目录，一次"初始化"把他改的东西抹掉是不可接受的）。
 */
/** 给小白看的行名。行 id 是我们内部叫法，不该让他念英文 */
const ROW_LABELS: Record<string, string> = { memory: '记忆', approval: '审批', link: '链路' };

const rowLabel = (id: string): string => ROW_LABELS[id] ?? id;

/**
 * `butler report` —— 出事了就发这个。
 *
 * 只说两件事，而且要说人话：**文件在哪**、**里面没有你的 key**。
 * （报告本身是给人看的，但用户要发出去的是那个文件，所以路径必须显眼。）
 */
async function runReport(args: Args): Promise<number> {
  const text = await collectReport({ configPath: args.config, patches: args.patches });
  const file = writeReport(text, { ...(args.out ? { out: args.out } : {}) });

  console.log('报告写好了：\n');
  console.log(`  ${file}`);
  console.log('\n  里面**没有**你的模型 key、token 和链接密钥（都已经隐去）。');
  console.log('  把那个文件整个发给帮你的人就行 —— 它在你自己电脑上，我们看不到。\n');
  console.log('  想知道里面写了什么？用记事本打开看一眼再发，也完全可以。');
  return 0;
}

function runInit(args: Args): number {
  // **不给 `--im` 就是不换**（沿用配置里原来那个，由 setup 按现有配置决定）。
  // 给了就必须认识 —— 但别在这里替用户默认成微信：他重跑一次 init 不该被换回去。
  const im = args.im;
  if (im !== undefined && !IM_NAMES.includes(im)) {
    console.error(`不认识这个 IM：${im}。现在支持的是 ${IM_NAMES.join('、')}。`);
    return 2;
  }
  const link = args.link ?? 'lan';
  if (!LINK_NAMES.includes(link)) {
    console.error(`不认识这条链路：${link}。现在支持的是 ${LINK_NAMES.join('、')}。`);
    return 2;
  }
  const r = initButlerHome({
    configPath: args.config,
    node: args.node,
    ...(im === undefined ? {} : { im }),
    link,
  });

  console.log('把家安好了：\n');
  for (const f of r.written) console.log(`  写好了  ${f}`);
  for (const f of r.kept) console.log(`  已经有了，没动  ${f}`);
  if (r.switchedFrom) {
    console.log(`\n  收信通道换成了「${r.im}」—— 原来那一行是 ${r.switchedFrom}`);
    console.log('  （就换了这一行，位置没动；别的东西一个字都没动）');
  }
  if (r.added.length) {
    console.log(`\n  又补上了 ${r.added.length} 样：${r.added.map(rowLabel).join('、')}`);
    console.log('  （新版本里多出来的东西。你原来改过的，一个字都没动）');
  }
  if (r.stateFileAdded) {
    console.log('\n  顺手把内核行的 stateFile 补上了 —— 从此"谁是主人"会落盘，重启不会被别人顶掉。');
    console.log('  （原来缺这个字段：认主只在内存里，重启之后第一个说话的人又会成为主人）');
  }
  if (r.topUpSkipped) {
    console.log(`\n  ⚠️ 有该补的行没补上：${r.topUpSkipped}`);
    console.log('  跑一次 butler doctor，它会告诉你缺哪一行。');
  }

  const patch = r.written.concat(r.kept).find((f) => f.endsWith('.patch.yml'))
    ?? join(dirname(args.config), 'dsh.patch.yml');

  // ⚠️ 这里**不要**再让用户去打开那个 YAML 改模型通道 ——
  //    那是整条路上最容易让人放弃的一步，现在由引导页代劳了。
  if (args.node) {
    console.log('\n这台是「被遥控的那台」。接下来：\n');
    console.log('  butler node');
    console.log('\n第一次会先让你贴一下模型 key（会自动开一个网页，粘一下就行），');
    console.log('然后屏幕上打出一行「配对 …」—— 把它发到微信里，中枢就认得这台了。');
  } else if (r.im === 'telegram') {
    console.log('\n这台是「收 Telegram 的那台」。接下来：\n');
    console.log('  1. 在 Telegram 里找 @BotFather 发 /newbot，建一个机器人');
    console.log('     （它会把一串 token 给你，长这样：123456:ABC-DEF…）');
    console.log('  2. butler run');
    console.log('\n第一次它会开两个网页，**都不用你改任何文件**：');
    console.log('  1. 先让你把那串 bot token 贴进去');
    console.log('  2. 再让你贴模型 key（AI 要靠它思考）');
  } else if (r.im === 'feishu') {
    console.log('\n这台是「收飞书的那台」。接下来：\n');
    console.log('  1. 先弄一个飞书应用（两种办法，挑一个）：');
    // 命令按这个包**实际装在哪儿**给：写死 `packages/...` 只在源码树里成立，
    // 用 install.sh 装的人没有 packages/（那是 tarball 装进 ~/.butler/prefix）
    console.log(`     · ${scanHint(dirname(r.configPath))}`);
    console.log('       （不用开发者后台、不用公网 IP；扫完它把两个值直接存进这台电脑）');
    console.log('     · 或去 open.feishu.cn 建一个「企业自建应用」，');
    console.log('       在「凭证与基础信息」里抄下 app_id 和 app_secret');
    console.log('  2. butler run');
    console.log('\n第一次它会问你两件事，都不用改任何文件：');
    console.log('  1. 应用的 app_id 和 app_secret（扫码那条路存过的话，它会自动跳过）');
    console.log('  2. 模型 key（AI 要靠它思考）');
    console.log('\n⚠️ 飞书这条通道还没做过真机验收 —— 真出问题，大概率在权限点上。');
  } else {
    console.log('\n这台是「收微信的那台」。接下来：\n');
    console.log('  butler run');
    console.log('\n第一次它会做两件事，都不用你改任何文件：');
    console.log('  1. 开一个网页，让你把模型 key 贴进去（AI 要靠它思考）');
    console.log('  2. 再出一个二维码，用手机微信扫一下');
  }

  console.log('\n（想先看一眼：butler doctor —— 它会把哪里没配好说出来。）');
  return 0;
}

/** 节点上等人贴 key 的时间：够坐在机器前的人贴完，又不至于让 SSH 进来的人干等 */
const NODE_KEY_TIMEOUT_MS = 60_000;

/**
 * 节点的模型 key 那一关。
 *
 * 跟中枢的区别只有一条：**等得短**。中枢那台一定有人坐着（他刚双击安装包），
 * 节点却可能是机房里的一台机器 —— 十分钟的空白等待会被当成"卡死了"。
 */
async function askForNodeKey(dsh: { patchFile: string; home: string }, args: Args): Promise<void> {
  const ref = keyRefOf(existsSync(dsh.patchFile) ? readFileSync(dsh.patchFile, 'utf8') : '');
  const outcome = await ensureModelKey({
    dshHome: dsh.home,
    ref,
    log: (line) => console.log(line),
    timeoutMs: NODE_KEY_TIMEOUT_MS,
    ...(args.open ? {} : { autoOpen: false }),
    ...(args.again ? { force: true } : {}),
  });
  if (outcome === 'skipped') {
    console.log(`\n⚠ 这台还没有模型 key（${ref}）—— 没有它，派给它的活干不了。`);
    console.log('  对着这台机器的浏览器跑一次 `butler run`，会开同一个页面（贴完 Ctrl-C 就行）。');
  }
}

/**
 * 自检。
 *
 * ⚠️ **它不改任何东西，也永远不抛错。** 用户跑到 doctor 这一步，说明已经
 * "没反应"了 —— 这时候最不能发生的就是"诊断工具自己也炸了"。
 * 所以 doctor() 内部把异常都收成了检查项，这里只管打出来和给退出码。
 *
 * 退出码有意义：0 = 可以跑，非 0 = 还有要修的。脚本里可以直接 `butler doctor || exit`。
 */
async function runDoctor(args: Args): Promise<number> {
  // 通道凭据也要按 `run` 的方式先填进那一行 —— 否则用户明明已经贴过 token，
  // 自检却说"还没有填"，那这个诊断工具就是在骗人。这里**只读**：不起页面、不问人。
  // （配置不存在时交给 doctor 自己去报"文件不存在"）
  const rows = existsSync(args.config) ? loadConfig(args.config, args.patches).rows : undefined;
  if (rows) injectChannelSecrets(rows, secretsFileOf(dirname(args.config)));
  const r = await doctor({ configPath: args.config, patches: args.patches, ...(rows ? { rows } : {}) });
  process.stdout.write(formatDoctor(r));
  return r.ok ? 0 : 1;
}

/**
 * 是不是"被当成命令跑"的（而不是被 import 的）。
 *
 * ⚠️ 不能直接拿 `process.argv[1]` 跟 `import.meta.url` 比：
 * `butler` 这个 bin 是**符号链接**，argv[1] 是链接的路径，而 Node 会把主模块
 * 解析成真实路径 —— 直接比会永远不相等，于是**命令一行都不会跑**。
 * 两边都取 realpath 才对。
 */
function isMain(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error(`出错了：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { main, HELP };
