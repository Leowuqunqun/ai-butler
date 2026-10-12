#!/usr/bin/env node
/**
 * 假 `tailscale` CLI。
 *
 * 为什么可以拿假的测：这条链路里**只有"问名册"这一步**是 Tailscale 特有的，
 * 后面全是 `link-lan` 那套 HTTP + SSE（那部分有自己的真节点测试）。
 * 真 CLI 的输出形状已经用真机抓下来当夹具了（见 `test/tailnet.mjs`）。
 *
 * 用环境变量摆布：
 *   STUB_TAILNET_FILE  把这份 JSON 原样打出去
 *   STUB_TAILNET_MODE  ok（默认）/ fail（退出码 1）/ garbage（不是 JSON）/ hang（卡住）
 */
import { readFileSync } from 'node:fs';

const mode = process.env.STUB_TAILNET_MODE ?? 'ok';

if (mode === 'fail') {
  process.stderr.write('Tailscale is not running\n');
  process.exit(1);
}
if (mode === 'garbage') {
  process.stdout.write('this is not json at all\n');
  process.exit(0);
}
if (mode === 'hang') {
  // 什么都不做，就是不退出 —— 外面那个超时该把它杀掉
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(readFileSync(process.env.STUB_TAILNET_FILE, 'utf8'));
}
