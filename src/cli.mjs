#!/usr/bin/env node
/**
 * wechat-agent-bridge —— 把微信变成你的 agent 遥控器。
 *
 * 子命令：
 *   qr                 起一个会自动换码的扫码页（推荐，浏览器里扫）
 *   login              终端模式登录：不断打印当前二维码文件路径
 *   run                常驻：收微信消息 → 交给 agent → 回话
 *   status             当前配置、绑定账号、后端、最近流水
 *   send <文本>        主动给已绑定账号发一条（不用等它先说话）
 *   sendfile <路径> [配文]
 *   backends           列出内置 agent 后端
 *   audit [n]          看最近 n 条收发流水
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store, DEFAULTS } from './store.mjs';
import { IlinkClient, ILINK_BASE } from './ilink.mjs';
import { Bridge } from './bridge.mjs';
import { loadBackend, listBuiltins } from './backends/index.mjs';
import { QrPage } from './qr-page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const rest = argv.slice(1);

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

function flag(name, fallback = null) {
  const withEq = rest.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--')) return rest[i + 1];
  return fallback;
}
/** 位置参数（跳过 --flag 及其值） */
function positional() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      if (!a.includes('=') && rest[i + 1] && !rest[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const store = new Store(ROOT);
const cfg = store.loadConfig();

function clientFromToken() {
  const t = store.readToken();
  if (!t?.botToken) {
    console.error('还没登录。先跑：  node src/cli.mjs qr');
    process.exit(1);
  }
  return new IlinkClient({
    baseUrl: t.baseUrl || ILINK_BASE,
    botToken: t.botToken,
    ilinkUserId: t.ilinkUserId,
    botType: cfg.botType,
    log,
  });
}

// ───────────────────────────── qr / login ─────────────────────────────

/** 两种登录只是"把码给用户看"的方式不同，登录流程本身共用 */
async function doLogin({ mode }) {
  const accountId = flag('account') ?? cfg.allowFrom?.[0] ?? '';

  if (mode === 'qr') {
    const page = new QrPage({ port: Number(flag('port', process.env.BRIDGE_QR_PORT ?? 8099)), log });
    const url = await page.start();
    console.log('');
    console.log(`  扫码页已就绪，在浏览器打开：  ${url}`);
    console.log('  （码过期会自动换新的，不用刷新页面）');
    console.log('');

    const client = new IlinkClient({ botType: cfg.botType, log });
    try {
      const creds = await client.login({
        onQr: ({ content, cycle }) => { page.update({ content, cycle }); log(`新二维码（第 ${cycle} 张）`); },
        onStatus: (s) => page.setStatus(s),
        timeoutMs: Number(flag('minutes', 12)) * 60 * 1000,
      });
      store.writeToken(creds);
      store.writeCursor('');
      page.finish({ accountId: creds.ilinkUserId || accountId });
      log(`✅ 绑定成功 baseUrl=${creds.baseUrl} userId=${creds.ilinkUserId || '?'}`);
      // 让页面把"绑定成功"显示完再退
      await new Promise((r) => setTimeout(r, 2500));
      await page.stop();
      console.log(`\n下一步：  node src/cli.mjs run    （建议放后台：nohup … &）`);
    } catch (e) {
      page.fail(e.message);
      await new Promise((r) => setTimeout(r, 3000));
      await page.stop();
      console.error(`登录失败：${e.message}`);
      process.exit(1);
    }
    return;
  }

  // 终端模式：不断打印当前有效的二维码文件路径
  const { default: QRCode } = await import('qrcode');
  const qrDir = join(store.dir, 'qr');
  mkdirSync(qrDir, { recursive: true });
  const client = new IlinkClient({ botType: cfg.botType, log });
  try {
    const creds = await client.login({
      onQr: async ({ content, cycle }) => {
        const png = join(qrDir, `qr-${Date.now()}.png`);
        await QRCode.toFile(png, content, { width: 420, margin: 2 });
        console.log(`QR_IMAGE=${png}`);
        console.log(`QR_CYCLE=${cycle}`);
      },
      timeoutMs: Number(flag('minutes', 12)) * 60 * 1000,
    });
    store.writeToken(creds);
    store.writeCursor('');
    log(`✅ 绑定成功 baseUrl=${creds.baseUrl} userId=${creds.ilinkUserId || '?'}`);
  } catch (e) {
    console.error(`登录失败：${e.message}`);
    process.exit(1);
  }
}

// ───────────────────────────── run ─────────────────────────────

async function doRun() {
  const token = store.readToken();
  if (!token?.botToken) {
    console.error('还没登录。先跑：  node src/cli.mjs qr');
    process.exit(1);
  }

  const backend = await loadBackend(cfg.agent?.backend, ROOT);
  const ilink = new IlinkClient({
    baseUrl: token.baseUrl || ILINK_BASE,
    botToken: token.botToken,
    ilinkUserId: token.ilinkUserId,
    botType: cfg.botType,
    log,
  });

  log(`桥已启动。后端=${backend.name} workspace=${cfg.workspace || ROOT} 白名单=${cfg.allowFrom?.length ? cfg.allowFrom.join(',') : '(空，首条来信认主)'}`);

  const bridge = new Bridge({ root: ROOT, store, config: cfg, ilink, backend, log });

  const shutdown = async (sig) => {
    log(`收到 ${sig}，退出`);
    await bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  bridge.start();
  // 永远不 resolve
  await new Promise(() => {});
}

// ───────────────────────────── status ─────────────────────────────

async function doStatus() {
  const token = store.readToken();
  const sessions = store.readSessions();
  let backend;
  try {
    backend = await loadBackend(cfg.agent?.backend, ROOT);
  } catch (e) {
    backend = { name: `❌ ${e.message}` };
  }
  const w = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

  console.log('\n登录');
  w('状态', token ? '✅ 已绑定' : '❌ 未登录（跑 qr）');
  if (token) {
    w('账号 userId', token.ilinkUserId || '(未知)');
    w('baseUrl', token.baseUrl);
    w('绑定时间', token.confirmedAt ? new Date(token.confirmedAt).toLocaleString() : '(未知)');
  }
  console.log('\nAgent');
  w('后端', backend.name);
  w('工作目录', cfg.workspace || ROOT);
  if (cfg.agent?.backend === 'dsh') {
    w('dsh profile', cfg.agent.dsh?.profile);
    w('patch 文件', `${cfg.agent.dsh?.patchFile} ${fileOk(cfg.agent.dsh?.patchFile) ? '✅' : '❌ 不存在'}`);
    w('DSH_HOME', cfg.agent.dsh?.home);
  }
  console.log('\n行为');
  w('白名单 allowFrom', cfg.allowFrom?.length ? cfg.allowFrom.join(', ') : '(空 —— 第一条来信自动认主)');
  w('首条认主', cfg.bindFirstSender ? '开' : '关');
  w('引用原问题', cfg.quoteReply ? '开（↩ 前缀，协议无原生引用）' : '关');
  w('排队提示', cfg.queueAck ? '开' : '关');
  w('超时', `${Math.round(cfg.agentTimeoutMs / 1000)}s`);
  w('单条上限', `${cfg.maxReplyChars} 字`);
  w('会话数', Object.keys(sessions).length);

  const recent = store.recentAudit(5);
  if (recent.length) {
    console.log('\n最近流水');
    for (const r of recent) {
      const t = (r.text ?? '').replace(/\s+/g, ' ').slice(0, 46);
      const extra = r.error ? ` [${r.error}]` : (r.ignored ? ' [已忽略]' : '');
      console.log(`  ${r.ts.slice(11, 19)} ${r.dir === 'in' ? '←' : '→'} ${t}${extra}`);
    }
  }
  console.log('');
}

function fileOk(p) {
  if (!p) return false;
  try { readFileSync(p); return true; } catch { return false; }
}

// ───────────────────────────── send / sendfile ─────────────────────────────

async function doSend() {
  const text = positional().join(' ');
  if (!text) {
    console.error('用法：  node src/cli.mjs send "文本"');
    process.exit(1);
  }
  const to = flag('to') ?? cfg.allowFrom?.[0];
  if (!to) {
    console.error('没有收件人。先登录并让目标账号给 bot 发一条消息，或用 --to <userId> 指定。');
    process.exit(1);
  }
  const ilink = clientFromToken();
  const n = await ilink.sendText(to, text, { maxChars: cfg.maxReplyChars });
  console.log(`已发送（${n} 条）-> ${to}`);
}

async function doSendFile() {
  const pos = positional();
  const file = pos[0];
  const caption = pos.slice(1).join(' ');
  if (!file) {
    console.error('用法：  node src/cli.mjs sendfile <路径> [配文]');
    process.exit(1);
  }
  const to = flag('to') ?? cfg.allowFrom?.[0];
  if (!to) {
    console.error('没有收件人。用 --to <userId> 指定。');
    process.exit(1);
  }
  const ilink = clientFromToken();
  if (caption) await ilink.sendText(to, caption, { maxChars: cfg.maxReplyChars });
  const sent = await ilink.sendFile(to, resolve(file), {});
  console.log(`已发送附件 ${sent.fileName}（${sent.size} 字节）-> ${to}`);
}

// ───────────────────────────── 杂项 ─────────────────────────────

function doBackends() {
  console.log('\n内置 agent 后端：');
  for (const b of listBuiltins()) console.log(`  ${b.name.padEnd(8)} ${b.file}`);
  console.log('\n接自己的 agent：写一个导出 run(ctx) 的模块，然后在配置里指过去：');
  console.log('  "agent": { "backend": "./my-backend.mjs" }');
  console.log('契约见 src/backends/index.mjs 头部注释。\n');
}

function doAudit() {
  const n = Number(positional()[0] || 20);
  for (const r of store.recentAudit(n)) {
    const t = (r.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    console.log(`${r.ts} ${r.dir === 'in' ? '←' : '→'} ${t}${r.error ? ` [${r.error}]` : ''}`);
  }
}

function doConfig() {
  console.log(JSON.stringify({ ...DEFAULTS, ...cfg, _comment: '默认值与你的覆盖已合并；文件在 state/config.json' }, null, 2));
}

function doHelp() {
  console.log(`
wechat-agent-bridge —— 把微信变成你的 agent 遥控器

  node src/cli.mjs qr                 起扫码页登录（推荐，--port 换端口）
  node src/cli.mjs login              终端模式登录（打印二维码文件路径）
  node src/cli.mjs run                常驻收消息
  node src/cli.mjs status             看配置 / 绑定 / 最近流水
  node src/cli.mjs send "文本"        主动发一条
  node src/cli.mjs sendfile <路径> [配文]
  node src/cli.mjs backends           列出内置 agent 后端
  node src/cli.mjs audit [n]          看最近 n 条流水
  node src/cli.mjs config             打印合并后的配置

所有参数也可以写进 state/config.json。第一次跑任何命令都会自动生成一份默认配置。
`);
}

// ───────────────────────────── 分发 ─────────────────────────────

switch (cmd) {
  case 'qr': await doLogin({ mode: 'qr' }); break;
  case 'login': await doLogin({ mode: 'tty' }); break;
  case 'run': await doRun(); break;
  case 'status': await doStatus(); break;
  case 'send': await doSend(); break;
  case 'sendfile': await doSendFile(); break;
  case 'backends': doBackends(); break;
  case 'audit': doAudit(); break;
  case 'config': doConfig(); break;
  default: doHelp(); break;
}
