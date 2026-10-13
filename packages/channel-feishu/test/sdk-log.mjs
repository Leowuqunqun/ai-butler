/**
 * 官方 SDK 自己的日志往哪儿去（第 45 轮）。
 *
 *   node --test test/sdk-log.mjs
 *
 * 这个文件存在的理由：**"关掉日志"很容易，难的是"别把该看见的也关掉"**。
 * 官方 README 那张表写着 `loggerLevel` 默认 `info` —— 看着像"传个 'warn' 就降噪了"，
 * 实际上 `LoggerLevel` 是个**数字**枚举（`fatal=0` … `info=3` … `trace=5`），传字符串进去
 * 跟任何枚举值都不相等 ⇒ **一条都不打**，连 warn/error 都没了。那不是降噪，是全静音：
 * 真出问题时用户在终端里什么都看不到。所以下面两条既钉"我们怎么接"，也钉"官方啥行为"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLarkChannel } from '@larksuite/channel';

import { larkOptionsOf, sdkLoggerOf } from '../lib/index.js';

/** 一个把收到的每一次调用记下来的假 logger（形状和 Cordis 的一样：格式串 + 参数） */
function spy() {
  const got = [];
  const at = (level) => (...args) => got.push([level, ...args]);
  return {
    got,
    log: { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') },
  };
}

test('★ 分流：error/warn 原样出去，info/debug/trace 降到 debug —— 但一条都不丢', () => {
  const s = spy();
  const lg = sdkLoggerOf(s.log);

  lg.info('[info]: client ready');
  lg.debug('d');
  lg.trace('t');
  lg.warn('出事了');
  lg.error('真出事了');

  assert.deepEqual(
    s.got.map((g) => g[0]),
    ['debug', 'debug', 'debug', 'warn', 'error'],
    'info/debug/trace 一路降到 debug（默认不打印，但没丢）；warn/error 照原样',
  );
  // 整条**当对象打**：官方塞进来的参数里可能带 %s/%d 这类字样，
  // 直接当格式串拼进去会被再解释一遍（printf 风格的老坑）。
  assert.deepEqual(s.got[0].slice(1), ['feishu sdk: %o', ['[info]: client ready']]);
});

test('★ 没有 logger 也不能炸（装载早期 ctx.logger 可能还没起来）', () => {
  const lg = sdkLoggerOf(undefined);
  for (const level of ['error', 'warn', 'info', 'debug', 'trace']) lg[level]('x');
});

test('★★ 交给官方的选项：有 logger，而且**没有** loggerLevel', () => {
  const s = spy();
  const opts = larkOptionsOf(
    {
      appId: 'cli_test_only',
      appSecret: 'not-a-real-secret',
      home: '/tmp/butler-feishu-sdklog-',
      requireMention: true,
      allowChats: [],
      seenLimit: 200,
      maxFileMb: 30,
      checkTimeoutMs: 1000,
    },
    s.log,
  );

  assert.equal(typeof opts.logger?.info, 'function', '要把我们自己的 logger 交给官方');
  assert.equal(typeof opts.logger?.warn, 'function');
  assert.ok(
    !('loggerLevel' in opts),
    '⚠️ 不能传 loggerLevel：它是数字枚举，而 README 那张表写的是字符串 —— 传了就一条都不打',
  );
  // 顺手钉住既有的那条规矩：空白名单**不传** groupAllowlist
  assert.deepEqual(opts.policy, { requireMention: true });
});

test('★★ 钉住官方行为：它真会把日志送进传入的 logger，而多传一个 loggerLevel 就会全灭', async () => {
  const s = spy();
  const ch = createLarkChannel({
    appId: 'cli_test_only',
    appSecret: 'not-a-real-secret',
    logger: s.log,
  });
  assert.ok(s.got.length > 0, '官方在构造期就会调我们传进去的 logger（"client ready" 那两句）');
  await ch.dispose?.();

  // 反向：多加一个 loggerLevel（哪怕值就是它文档里的默认值 "info"）⇒ 一条都没有。
  // 这条是**给未来**立的：哪天官方把字符串也认了，这里会红，我们就知道可以简化了。
  const s2 = spy();
  const ch2 = createLarkChannel({
    appId: 'cli_test_only',
    appSecret: 'not-a-real-secret',
    logger: s2.log,
    loggerLevel: 'info',
  });
  assert.equal(s2.got.length, 0, 'loggerLevel 一出现，官方就什么都不打了（⚠️ 所以别传它）');
  await ch2.dispose?.();
});
