/**
 * 「第一次启动，自己去登录」—— 这件事的全部逻辑。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────
 *
 * 以前 `butler run` 在没有登录态时会**直接报错**，让人"先在命令行跑一次
 * `wechat-agent-bridge qr`"。对开发者这没问题，对一个不懂技术的人：
 * 他刚敲完 `butler run`，得到的是一句让他去敲**另一条命令**的话 ——
 * 而那条命令的名字他自己是不可能猜出来的。
 *
 * 所以现在 `butler run` 自己把这件事做完：
 *
 *   起一个本地扫码页（只监听 127.0.0.1）→ **自动把浏览器打开** → 等扫码
 *   → 把登录态写下来 → 继续上线，中间不需要第二条命令。
 *
 * 为什么是"网页"而不是终端里打印二维码：iLink 的码**只活约 90 秒**，
 * 而且终端里的二维码在很多字体下根本扫不出来。网页可以自动换码，从容地扫。
 *
 * ── 这个模块为什么单独存在 ────────────────────────────────────────
 *
 * 它**不 import 真客户端、也不 import 真页面** —— 两个都由调用方传进来。
 * 于是整条流程（开浏览器、码进页面、写登录态、成功/失败怎么收场）都能在
 * **完全离线**的情况下测：真起一个本地 HTTP 页面，喂一个假客户端。
 *
 * @module wechat-agent-bridge/login
 */

import { spawn } from 'node:child_process';

/** 给用户扫码的时间。够长（抽根烟回来还能扫），也不至于永远挂着 */
export const LOGIN_TIMEOUT_MS = 12 * 60 * 1000;

/** 登录成功后，让页面把"绑定成功"显示一会儿再关 */
const SETTLE_MS = 2500;
/** 失败后，让页面把错误显示一会儿再关 —— 关太快用户什么都没看见 */
const FAIL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 该用哪条命令打开浏览器。
 *
 * 纯函数（拿平台当参数），因为"macOS 用 `open`、Linux 用 `xdg-open`、
 * Windows 是 `cmd /c start`"这三件事值得被钉住 —— 猜错的表现是
 * **什么都弹不出来**，而用户只会以为"它没反应"。
 */
export function openCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * 真去开浏览器。**开不出来就当没发生**：
 * 打不开浏览器不该让登录失败 —— 页面的地址已经在终端里打出来了，手抄也能扫。
 */
export function browserOpener(platform = process.platform, spawnFn = spawn) {
  return (url) => {
    const { cmd, args } = openCommand(platform, url);
    try {
      const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
      // 有些机器上 `open` 不存在（精简的 Linux），会异步抛 ENOENT —— 吃掉
      child.on?.('error', () => {});
      child.unref?.();
    } catch {
      /* 打不开就算了，登录照常 */
    }
  };
}

/** 把底层的错误翻成"用户接下来该做什么" */
function actionable(error, timeoutMs) {
  const msg = error?.message ?? String(error);
  // 被取消（用户 Ctrl-C）不是故障，别给他解释半天
  if (/取消/.test(msg)) return error;
  if (/超时/.test(msg)) {
    return new Error(`${msg} —— 重新跑一次 butler run 会重新出码`);
  }
  return new Error(`扫码登录失败：${msg}（检查这台机器能不能上网，然后重新跑一次 butler run）`);
}

/**
 * 起扫码页 → 等扫码 → 把登录态落盘。
 *
 * @param {object} o
 * @param {{login: Function}} o.client    iLink 客户端（测试里是假的）
 * @param {{writeToken: Function, writeCursor: Function}} o.store
 * @param {object} o.page                 扫码页（QrPage 或同形状的替身）
 * @param {(s: string) => void} o.log
 * @param {(url: string) => void} [o.open] 打开浏览器（默认真的开）
 * @param {() => boolean} [o.shouldStop]  用户中途 Ctrl-C 时返回 true
 * @param {number} [o.timeoutMs]
 * @returns {Promise<object>} 登录凭据
 */
export async function loginWithQrPage({
  client, store, page, log,
  open = browserOpener(),
  shouldStop,
  timeoutMs = LOGIN_TIMEOUT_MS,
  settleMs = SETTLE_MS,
  failMs = FAIL_MS,
}) {
  const url = await page.start();

  log('');
  log('  用微信扫这个码登录 —— 页面已经给你打开了：');
  log(`  ${url}`);
  log('  （码过期会自动换新的，不用刷新页面）');
  log('');

  open(url);

  let creds;
  try {
    creds = await client.login({
      onQr: ({ content, cycle }) => page.update({ content, cycle }),
      onStatus: (s) => page.setStatus(s),
      timeoutMs,
      shouldStop,
    });
  } catch (error) {
    page.fail(error?.message ?? String(error));
    await sleep(failMs);
    await page.stop();
    throw actionable(error, timeoutMs);
  }

  store.writeToken(creds);
  // 换了账号就是换了一条消息流，旧的游标必须清掉
  store.writeCursor('');
  page.finish({ accountId: creds?.ilinkUserId ?? '' });
  log('✅ 绑定成功 —— 现在可以用微信给它发消息了');

  await sleep(settleMs);
  await page.stop();
  return creds;
}
