#!/usr/bin/env node
/**
 * 假的 dsh 可执行文件 —— 按"任务文案"演出不同的 NDJSON 流。
 *
 * 为什么要一个真进程：agent-dsh 的全部行为都在**子进程边界**上
 * （参数顺序、流式解析、超时、被掐断、非零退出码、stderr 里的会话锁）。
 * 用一个假的模块去替身，这些恰恰都测不到。
 */

const argv = process.argv.slice(2);
const task = argv[argv.length - 1] ?? '';

/** 兜底自杀：万一哪天测试忘了收尾，别把整个测试套件挂住 */
const guard = setTimeout(() => process.exit(98), 30_000);
guard.unref();

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sessionIdOf() {
  const i = argv.indexOf('--session-id');
  return i >= 0 ? argv[i + 1] : undefined;
}

function sleep(ms) {
  return new Promise((r) => { setTimeout(r, ms); });
}

// 不管演哪一出，第一件事都是报自己的 session
const sid = sessionIdOf() ?? `fake-${Date.now()}`;
emit({ type: 'session', sessionId: sid, cwd: process.cwd() });

switch (task) {
  case 'ok':
    emit({ type: 'text', text: '中间那段不算数' });
    emit({ type: 'final', text: '干完了' });
    break;

  case 'tools':
    emit({ type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'src/index.ts' } });
    emit({ type: 'tool_result', callId: 'c1', status: 'completed', result: '...' });
    emit({ type: 'thinking', text: '这条不该外传' });
    emit({ type: 'tool_call', callId: 'c2', tool: 'bash', input: { command: 'npm test' } });
    emit({ type: 'tool_result', callId: 'c2', status: 'error', result: '失败了' });
    emit({ type: 'final', text: '跑完了' });
    break;

  case 'no-input':
    emit({ type: 'tool_call', callId: 'c1', tool: 'mystery', input: {} });
    emit({ type: 'final', text: '好' });
    break;

  case 'garbage':
    process.stdout.write('这不是 JSON\n');
    process.stdout.write('\n');
    process.stdout.write('{"type":"final","text":"半路有杂音也活下来了"}\n');
    process.stdout.write('{"半个 json\n');
    break;

  case 'err':
    emit({ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: '模型没配 key' } } });
    break;

  case 'fail':
    process.stderr.write('【插件告警】某个插件没加载\n');
    process.stderr.write('真原因在这一行\n');
    process.exitCode = 3;
    break;

  case 'lock':
    process.stderr.write('Error: session "abc" is already owned by an active write handle\n');
    process.exitCode = 1;
    break;

  case 'lock-once':
    // 只有"带着旧会话"时才报占用；开新会话就能过。
    // 用来端到端验证核心层的恢复动作（丢掉旧会话、重试一次）。
    if (sessionIdOf()) {
      process.stderr.write('Error: session "abc" is already owned by an active write handle\n');
      process.exitCode = 1;
    } else {
      emit({ type: 'final', text: '换了个新会话，过了' });
    }
    break;

  case 'silent-nonzero':
    process.exitCode = 7;
    break;

  case 'env':
    // 验证两件必须成立的事：私有的 DSH_HOME、以及 cwd 真的生效
    emit({ type: 'final', text: JSON.stringify({ home: process.env.DSH_HOME, cwd: process.cwd() }) });
    break;

  case 'echo-args':
    emit({ type: 'final', text: JSON.stringify(argv) });
    break;

  case 'slow':
    // 先报一条进度，再慢慢磨 —— 用来验证"进度真的被播报出去了"
    emit({ type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'config.ts' } });
    await sleep(400);
    emit({ type: 'final', text: '磨完了' });
    break;

  case 'hang':
    emit({ type: 'tool_call', callId: 'c1', tool: 'sleep', input: { forever: true } });
    await sleep(60_000);
    break;

  case 'no-final':
    emit({ type: 'text', text: '我说了话但没 final' });
    break;

  default:
    emit({ type: 'final', text: `不认识的任务：${task}` });
}
