#!/usr/bin/env node
/**
 * 变异测试 —— 这一个脚本验的不是代码，是**测试本身**。
 *
 *   pnpm mutate                 # 全部：故意把代码改坏，看有没有测试喊疼
 *   pnpm mutate --list          # 只列出要砸哪些地方（不跑）
 *   pnpm mutate --only quote    # 只砸名字里含 quote 的那几处
 *   pnpm mutate --quick         # 跳过要走 e2e 脚本的那几条（clean-room 那两条各要一两分钟）
 *   pnpm mutate --keep          # 留着那份副本，跑完告诉你路径（排查用）
 *
 * 为什么需要它：**"测试全绿"不等于"每条主张真有测试盯着"**。
 * 第一次跑就抓到一处假绿 —— 把 `doctor` 里「模型 key 缺了必须 ✗」改成恒真，
 * 整个 cli 套件一片绿，只有 clean-room e2e 抓得到，而 e2e 太慢、没人会为一次
 * 改动去跑。那处补完用例之后，这个脚本的职责就是**一直盯着这一类洞**。
 *
 * ⚠️ 血的教训（这个脚本的安全设计全是从它来的）：
 *    上一版用 `cp -al`（**硬链接**）当副本 —— 写文件是截断同一个 inode，
 *    所以变异会**漏回原仓**，掐进程时更是留下一处改动在工作区里。
 *    于是这里三道保险：
 *      1. 副本必须是**真副本**（逐文件比对 inode，相同就拒绝跑）
 *      2. **原仓全树哈希**：每一步之后再算一次，只要变了就立刻停（退出码 3）
 *      3. 一切写操作只发生在副本里 —— 就算被 `kill -9`，最坏也只是副本脏了
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = 'packages/core/src/index.ts';
const TG = 'packages/channel-telegram/src/index.ts';
const CLI = 'packages/cli/src';
const FEISHU = 'packages/channel-feishu/src/index.ts';

/**
 * 每一条 = 一个**承诺**，以及"怎么把它改坏"。
 *
 * `claim` 是要复述给人听的那句承诺；`files` 是变异；`pkg` 是重编哪个包；
 * `tests` 是应该喊疼的用例；`e2e: true` 表示只有 clean-room 端到端抓得到（那条脚本是历史唯一一条）；
 * `e2e: 'scripts/xxx.sh'` 指定**别的**脚本当 witness（第 63 轮起，飞书手册的离线演练走这条）。
 */
const MUTATIONS = [
  {
    name: '引用规则：把"该引用"变成永远不引用',
    claim: '终结性回复引用用户那句话',
    pkg: './packages/core',
    files: [[CORE, '    if (!this.config.quoteReply) return undefined;',
      '    if (this.config.quoteReply) return undefined;']],
    tests: ['packages/core/test/core.mjs', 'packages/core/test/routing.mjs',
      'packages/core/test/route.mjs', 'packages/seam-channel/test/seam.mjs'],
  },
  {
    name: '引用规则：过程性消息也跟着引用',
    claim: '过程性消息（"还在处理…"）不引用 —— 不然很吵',
    pkg: './packages/core',
    files: [[CORE, '      void this.say(msg, `还在处理…（已 ${secs}s）${tail}`);',
      '      void this.say(msg, `还在处理…（已 ${secs}s）${tail}`, this.quoteOf(msg));']],
    tests: ['packages/core/test/core.mjs'],
  },
  {
    name: '凭据：引导页存的那串盖掉手写的',
    claim: '配置里手写的值优先级最高，谁都不许覆盖',
    pkg: './packages/cli',
    files: [[`${CLI}/secrets.ts`,
      "    if (typeof current === 'string' && current.trim() !== '') continue;",
      "    if (typeof current === 'string' && current.trim() === '\\0') continue;"]],
    tests: ['packages/cli/test/secrets.mjs', 'packages/cli/test/switch-im.mjs'],
  },
  {
    name: '谁能指挥它：认主之后不再说清"是谁"',
    claim: '手册第十二节让用户从 doctor 上看这个 id —— 想钉死认主、或者想换人写 allowFrom，都得先知道它是谁（第 64 轮把这个 id 补上去的）',
    pkg: './packages/core',
    files: [[CORE,
      "`已认主（第一个跟它说话的人）：${owner}。别人发消息它会一声不吭`",
      "`已认主（第一个跟它说话的人）。别人发消息它会一声不吭`"]],
    tests: ['packages/core/test/core.mjs'],
  },
  {
    name: '谁能指挥它：认主没落盘时也不再说是谁',
    claim: '没落盘那一支同样要说清是谁 —— 只说"没落盘"而不说主人是谁，用户还是不知道该把哪个 id 写回去',
    pkg: './packages/core',
    files: [[CORE,
      "`已认主（第一个跟它说话的人）：${owner} —— ⚠️ 但这次认主**没落盘**",
      "`已认主（第一个跟它说话的人）—— ⚠️ 但这次认主**没落盘**"]],
    tests: ['packages/core/test/core.mjs'],
  },
  {
    name: '--again：跳过时不再把旧 token 注入回去',
    claim: '`--again` 是"再问一次"，跳过就还用原来那把（不然换 key 能把管家弄哑）',
    pkg: './packages/cli',
    files: [[`${CLI}/onboarding.ts`,
      "    const filled = injectChannelSecrets(rows, file);\n    if (filled.length > 0 && outcomes.includes('saved')) {",
      "    const filled = outcomes.includes('saved') ? injectChannelSecrets(rows, file) : [];\n    if (filled.length > 0 && outcomes.includes('saved')) {"]],
    tests: ['packages/cli/test/onboarding.mjs'],
  },
  {
    name: 'keyState：不认启动环境里的 key 了',
    claim: '环境变量里的 key 赢，这时候写文件是不生效的（所以别去写）',
    pkg: './packages/cli',
    files: [[`${CLI}/credentials.ts`,
      "  if ((env[ref] ?? '') !== '') return 'env';",
      "  if ((env[ref] ?? '') === '\\0') return 'env';"]],
    tests: ['packages/cli/test/credentials.mjs', 'packages/cli/test/onboarding.mjs'],
  },
  {
    name: '自检：连不上网就报红',
    claim: '连不上 Telegram 说"这次没查"、不算故障（网一断就报红会让人修不存在的问题）',
    pkg: './packages/channel-telegram',
    files: [[TG,
      "          ok: true,\n          detail: '没查（这次连不上 Telegram）—— 不影响别的检查',",
      "          ok: false,\n          detail: '没查（这次连不上 Telegram）—— 不影响别的检查',"]],
    tests: ['packages/channel-telegram/test/plugin.mjs'],
  },
  {
    name: '自检：token 被作废了也说"好着呢"',
    claim: 'token 被对面拒了（401/404）必须判 ✗，并给出 `--again` 这条出路',
    pkg: './packages/channel-telegram',
    files: [[TG, '        ok: false,\n        detail: msg,', '        ok: true,\n        detail: msg,']],
    tests: ['packages/channel-telegram/test/plugin.mjs'],
  },
  {
    name: 'doctor：模型 key 缺了也说 ✓',
    claim: '「模型 key」三种状态都得说真话（缺了 ✗ / 存了 ✓ / 环境里来的如实说）',
    pkg: './packages/cli',
    files: [[`${CLI}/doctor.ts`, "      ok: state !== 'missing',", '      ok: false,']],
    tests: ['packages/cli/test/doctor.mjs', 'packages/cli/test/cli.mjs',
      'packages/cli/test/switch-im.mjs'],
  },
  {
    name: '出站图片：又变回"当成文件发"',
    claim: '图片按图片发（对面看到的是图片，不是一个附件）',
    files: [['packages/channel-wechat/src/plugin.mjs',
      '      kind: mediaKindOf(path),', "      kind: 'file',"]],
    tests: ['packages/channel-wechat/test/plugin.mjs', 'packages/channel-wechat/test/ilink.mjs'],
  },
  {
    name: '出站图片：上传时 media_type 仍是文件',
    claim: '发图片时 media_type=1、item 是 image_item（协议层最容易写混的一处）',
    files: [['packages/channel-wechat/src/ilink.mjs',
      '      media_type: isImage ? UploadMediaType.IMAGE\n        : isVideo ? UploadMediaType.VIDEO : UploadMediaType.FILE,',
      '      media_type: UploadMediaType.FILE,']],
    tests: ['packages/channel-wechat/test/ilink.mjs'],
  },
  {
    name: '首次运行：不开浏览器也谎称已经自动打开',
    claim: '--no-open（自启动走的就是它）时**照实说**没开浏览器，别让人等一个不出现的窗口',
    pkg: './packages/cli',
    files: [['packages/cli/src/onboarding.ts',
      `  opts.log(opened\n    ? '（页面已经自动打开；在手机上复制、到这台电脑的浏览器里粘贴也行）'\n    : '（这次没自动开浏览器 —— 把上面这个地址复制到浏览器里打开就行）');`,
      `  opts.log('（页面已经自动打开；在手机上复制、到这台电脑的浏览器里粘贴也行）');`]],
    tests: ['packages/cli/test/onboarding.mjs'],
  },
  {
    name: '出站视频：media_type 又写回文件',
    claim: '视频按视频发（手机拍的 .mov/.mp4 该在对面直接能播）',
    files: [['packages/channel-wechat/src/ilink.mjs',
      '      media_type: isImage ? UploadMediaType.IMAGE\n        : isVideo ? UploadMediaType.VIDEO : UploadMediaType.FILE,',
      '      media_type: isImage ? UploadMediaType.IMAGE : UploadMediaType.FILE,']],
    tests: ['packages/channel-wechat/test/ilink.mjs'],
  },
  {
    name: 'install.sh：壳脚本不再钉住 Node（改靠 PATH 里的 node）',
    claim: '装出来的 butler 把安装时挑好的 Node 钉死（本机没 Node / Node 太老也照样跑）',
    e2e: true,
    files: [['install.sh',
      'exec "${NODE_BIN}" "${CLI_JS}" "\\$@"',
      'exec node "${CLI_JS}" "\\$@"']],
  },
  {
    name: 'PATH：管家找不找得到 butler 永远说 ✓',
    claim: '管家自己找得到 butler 吗 —— 找不到时必须如实报 ✗ 并给出路（报绿的话，主人永远不知道"在微信里让它自己做"那条路是断的）',
    pkg: './packages/core',
    files: [['packages/core/src/butler-path.ts',
      '  const found = findButlerOnPath(pathValue);\n  if (found) {',
      '  const found = findButlerOnPath(pathValue);\n  if (true) {']],
    tests: ['packages/core/test/core.mjs'],
  },
  {
    name: '记忆：清单里的编号和「忘掉第 N 条」差一位',
    claim: '「记忆」列出来的第 N 条，就是「忘掉第 N 条」要删的那一条（差一位就会删错一条，而且是静默删错）',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      '      const hit = entries[index - 1];',
      '      const hit = entries[index];']],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '记忆：记过的东西不再贴给 agent',
    claim: '每一轮请求前都贴上「我记得的事」—— 所以"你记得我什么"不用命中任何命令也答得对',
    pkg: './packages/core',
    files: [['packages/core/src/memory.ts',
      '  const shown = entries.slice(0, MEMORY_PREAMBLE_MAX);',
      '  const shown = entries.slice(0, 0);']],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '记忆：含隐私的文件不再只有本人可读',
    claim: '记忆目录 0700（"我的工作目录是 ~/work"这种内容写在盘上就是隐私）',
    pkg: './packages/memory-file',
    files: [['packages/memory-file/src/store.ts',
      'mkdirSync(dir, { recursive: true, mode: 0o700 })',
      'mkdirSync(dir, { recursive: true, mode: 0o755 })']],
    tests: ['packages/memory-file/test/memory.mjs'],
  },
  {
    name: 'install.sh：PATH 每次都追加',
    claim: '重复安装不重复写 PATH（幂等，可重跑）',
    e2e: true,
    files: [['install.sh',
      '      if [ -f "${RC}" ] && grep -q "AI 管家（butler）PATH" "${RC}" 2>/dev/null; then',
      '      if false; then']],
  },
  {
    name: '审批：没过期的也当成过期结算掉',
    claim: '只有**真的**过期了才按"不许"结算（把没到期的也结掉 = 该问的不问了）',
    pkg: './packages/approval-im',
    files: [['packages/approval-im/src/mailbox.ts',
      '    if (Date.parse(req.expiresAt) > now) continue;',
      '    if (false) continue;']],
    tests: ['packages/approval-im/test/approval.mjs'],
  },
  {
    name: '审批：主人说"允许"，账上却记成"不许"',
    claim: '账本如实记结局（批了 = allowed-once；这是事后唯一能查的东西）',
    pkg: './packages/approval-im',
    files: [['packages/approval-im/src/index.ts',
      "      outcome: decision === 'allow' ? 'allowed-once' : 'rejected',",
      "      outcome: 'rejected',"]],
    tests: ['packages/approval-im/test/approval.mjs'],
  },
  {
    name: '审批：连问题都没记下来，却放行',
    claim: '记不下来 = 问都没问成 → `unavailable`（让 dsh 按拒绝处理），绝不"那就当允许吧"',
    pkg: './packages/approval-im',
    files: [['packages/approval-im/src/answerer.ts',
      "      return 'unavailable';",
      "      return 'allowed-once';"]],
    tests: ['packages/approval-im/test/answerer.mjs'],
  },
  {
    name: '审批：清单变了还拿旧编号硬猜',
    claim: '编号只按主人**看过的那份清单**算；清单变了就重新念，绝不拿旧编号猜是哪一件',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      '    const stale = this.approvalPrinted.length !== total\n      || list.some((r, i) => this.approvalPrinted[i] !== r.id);',
      '    const stale = false;']],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '升级：补行时把已有的行又加了一遍',
    claim: '老配置补行只补**缺的**（多一行就是两个记忆插件抢同一个文件）',
    pkg: './packages/cli',
    files: [['packages/cli/src/setup.ts',
      '  return abilityRows(home).filter((r) => !shape.ids.has(r.id)).map((r) => r.id);',
      '  return abilityRows(home).map((r) => r.id);']],
    tests: ['packages/cli/test/setup.mjs'],
  },
  {
    name: '升级：读不动的配置也敢往里补',
    claim: '配置读不动时一行都不补（猜着改用户的文件比不补更糟）',
    pkg: './packages/cli',
    files: [['packages/cli/src/setup.ts',
      "    return { skipReason: '这份配置读不出来（不是合法的 JSON）' };",
      '    return null;']],
    tests: ['packages/cli/test/setup.mjs'],
  },
  {
    name: '审批：接不上也说"接得住"',
    claim: '那根线接不上必须报 ✗（离线测不到它，doctor 是唯一的眼睛）',
    pkg: './packages/cli',
    files: [['packages/cli/src/doctor.ts',
      '  } else if (!isAbsolute(answerer.name) || !existsSync(answerer.name)) {',
      '  } else if (false) {']],
    tests: ['packages/cli/test/doctor.mjs'],
  },
  {
    name: '升级：run 看见老配置却一声不吭',
    claim: 'run 不写文件，但**必须说一句** —— 不说的话他碰到的是一连串"它就是不动"',
    pkg: './packages/cli',
    files: [['packages/cli/src/cli.ts',
      '  const missing = missingAbilityRows(args.config);\n  if (missing.length) {',
      '  const missing = missingAbilityRows(args.config);\n  if (missing.length && false) {']],
    tests: ['packages/cli/test/setup.mjs'],
  },
  {
    name: '引导页：压根不验就存',
    claim: '模型 key 存下去之前必须**当场**问对方一句 —— 贴错了不会报错，只会在几小时后表现为"管家不回你"',
    pkg: './packages/cli',
    files: [['packages/cli/src/onboarding.ts',
      '      const verdict = prompt.verify && !force ? await prompt.verify(key) : null;',
      '      const verdict = null;']],
    tests: ['packages/cli/test/onboarding.mjs'],
  },
  {
    name: '引导页：验了，但拿定了的错也放过去',
    claim: '对方明确说"key 不对/没钱"时**不许存**（存一把错的等于埋一个哑雷）',
    pkg: './packages/cli',
    files: [['packages/cli/src/onboarding.ts',
      '      if (verdict && !verdict.ok && verdict.blocking) {',
      '      if (verdict && !verdict.ok && false) {']],
    tests: ['packages/cli/test/onboarding.mjs'],
  },
  {
    name: '验 key：把"连不上"说成"key 不对"',
    claim: '**绝不许冤枉一把可能好用的 key** —— 连不上/超时/对方 5xx 只能算"没法确认"',
    pkg: './packages/cli',
    files: [['packages/cli/src/model-key.ts',
      "      ok: false,\n      blocking: false,\n      why: '没能连上对方（网络不通或者太慢），没法确认这把 key',",
      "      ok: false,\n      blocking: true,\n      why: '没能连上对方（网络不通或者太慢），没法确认这把 key',"]],
    tests: ['packages/cli/test/model-key.mjs'],
  },
  {
    name: '验 key：401 当成没事',
    claim: '对方说"这把 key 不对"时必须拦住，并给出"去哪重新复制"那一步',
    pkg: './packages/cli',
    files: [['packages/cli/src/model-key.ts',
      '  if (status === 401 || status === 403) {',
      '  if (status === 9999) {']],
    tests: ['packages/cli/test/model-key.mjs'],
  },
  {
    name: '引导页：知道自己在做什么的人也被堵死',
    claim: '校验是**替人把关**、不是**替人做主** —— 他自己确认过就必须能存下去（换了模型服务商的人会撞上这条）',
    pkg: './packages/cli',
    files: [['packages/cli/src/onboarding.ts',
      '      const verdict = prompt.verify && !force ? await prompt.verify(key) : null;',
      '      const verdict = prompt.verify ? await prompt.verify(key) : null;']],
    tests: ['packages/cli/test/onboarding.mjs'],
  },
  {
    name: '报告：密钥原样抄进去',
    claim: '报告里**一个 key 都不许有** —— 用户要把它发给别人，漏一把就是事故',
    pkg: './packages/cli',
    files: [['packages/cli/src/report.ts',
      'export function redact(text: string): string {\n  return text',
      'export function redact(text: string): string {\n  return text;\n  void text']],
    tests: ['packages/cli/test/report.mjs'],
  },
  {
    name: '报告：碰见坏文件就整个崩',
    claim: '配置读不动、日志没有，报告**照样得出得来** —— 那正是最需要它的时候',
    pkg: './packages/cli',
    files: [['packages/cli/src/report.ts',
      "  } catch {\n    put('  这份配置读不出来（不是合法的 JSON）—— 这件事本身要告诉帮你的人');\n    return;\n  }",
      "  } catch {\n    throw new Error('配置读不动，报告不做了');\n  }"]],
    tests: ['packages/cli/test/report.mjs'],
  },
  {
    name: '报告：写出来的文件谁都能看',
    claim: '报告落到盘上要跟凭据一个待遇（0600）',
    pkg: './packages/cli',
    files: [['packages/cli/src/report.ts',
      "  writeFileSync(file, text, { mode: 0o600 });",
      "  writeFileSync(file, text, { mode: 0o644 });"]],
    tests: ['packages/cli/test/report.mjs'],
  },
  {
    name: '授权：自动放行冒名写成"主人批的"',
    claim: '靠长期授权放行时，账本必须写 `grant` —— 出了事不能冤枉主人说他批过',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      "        await approval.answer(req.id, 'allow', 'grant');",
      "        await approval.answer(req.id, 'allow', 'owner');"]],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '授权：读不动就装作没这回事',
    claim: '授权记录读不动时必须**如实说**，并且一条都不算数',
    pkg: './packages/core',
    files: [['packages/core/src/grants.ts',
      "    return { grants: [], broken: '这份授权记录读不出来（不是合法的 JSON）' };",
      "    return { grants: [] };"]],
    tests: ['packages/core/test/grants.mjs'],
  },
  {
    name: '授权：同一类记了两条',
    claim: '同一类授权只能有一条 —— 两条的话「取消授权 1」只收掉一半，他以为收回了',
    pkg: './packages/core',
    files: [['packages/core/src/grants.ts',
      "  const next = grants.filter((g) => g.kind !== kind);",
      "  const next = grants.slice();"]],
    tests: ['packages/core/test/grants.mjs'],
  },
  {
    name: '授权：越界的编号也照样收',
    claim: '「取消授权 9」不许动任何一条 —— 他没看清单就报的编号，一个都不该生效',
    pkg: './packages/core',
    files: [['packages/core/src/grants.ts',
      "  if (index < 1 || index > grants.length) return { removed: null, grants };",
      "  if (false) return { removed: null, grants };"]],
    tests: ['packages/core/test/grants.mjs'],
  },
  {
    name: '开场白：刚认下主人时不说那句',
    claim: '认下主人之后必须**先说一句** —— 他刚扫完码，安静会被当成"没装好"',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      "    if (this.newOwner === msg.fromId) {",
      "    if (false) {"]],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '开场白：每次重启都唠叨一遍',
    claim: '开场白**一辈子只说一次** —— 每次重启都说，他会烦，而烦了就不看了',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      "    if (this.sessions.helloed()) return;",
      "    if (false) return;"]],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '开场白：把行话也写给小白看',
    claim: '给他看的话里不许出现行话 —— 看这句话的人不知道自己有个终端',
    pkg: './packages/core',
    files: [['packages/core/src/welcome.ts',
      "    '我是你的管家 —— 这台电脑现在归你遥控了。',",
      "    '我是你的管家 —— ctx.agent 已就绪，npm 包已装。',"]],
    tests: ['packages/core/test/welcome.mjs'],
  },
  {
    name: '配对：收下了却不落盘',
    claim: '配对收下的设备当场落盘 —— 中枢重启不该把用户配过的关系弄丢',
    pkg: './packages/link-tailscale',
    files: [['packages/link-tailscale/src/index.ts', '    savePeers(this.peersFile, [...this.adopted.values()]);',
      '    savePeers(this.peersFile, []);']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  {
    name: '配对：连的时候用链路的默认端口，而不是那台自己报的',
    claim: '端口按那台机器自己报的来（写死默认端口的话，节点不在 41338 上就永远连不上）',
    pkg: './packages/link-tailscale',
    files: [['packages/link-tailscale/src/index.ts', '    const port = found.port ?? this.config.port;',
      '    const port = this.config.port;']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  {
    name: '配对：连的时候用共享密钥，而不是那台自己那把',
    claim: '每台用自己那把密钥 —— 一台泄漏不等于全都泄漏',
    pkg: './packages/link-tailscale',
    files: [['packages/link-tailscale/src/index.ts', '    return found.secret || this.config.secret;',
      '    return this.config.secret;']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  {
    name: '发现：探配对过的设备时把每台自己那把密钥丢了',
    claim: '发现的时候也按每台自己那把密钥探活（不然配对过的设备全显示离线）',
    pkg: './packages/link-tailscale',
    files: [['packages/link-tailscale/src/index.ts', '        secret: peer.secret ?? this.config.secret,',
      '        secret: this.config.secret,']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  {
    name: '忘掉：只删内存里的，名册文件不动',
    claim: '「忘掉」要真的从名册里删掉，而且要落盘（不然重启它又回来了）',
    pkg: './packages/link-tailscale',
    files: [['packages/link-tailscale/src/index.ts', '    this.adopted.delete(deviceId);',
      '    void deviceId;']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  {
    name: '地址判据：把 utun 也当成"抄了没用"的网卡滤掉',
    claim: 'macOS 上尾巴地址就在 utun 上，滤掉它 = 节点屏幕上打不出那句能抄的话',
    pkg: './packages/link-lan',
    files: [['packages/link-lan/src/identity.ts', '  return !/^(docker|br-|veth|lo)/.test(name);',
      '  return !/^(docker|br-|veth|lo|utun|tun|tap)/.test(name);']],
    tests: ['packages/link-tailscale/test/pair.mjs'],
  },
  // ── 记忆自动抽取（round 28）────────────────────────────────
  {
    name: '记忆：空的和超长的也照记不误',
    claim: '内容为空 / 超长 / 套着另一个标记的，一条都不许记（宁可漏认）',
    pkg: './packages/core',
    files: [['packages/core/src/memory.ts',
      "      if (body && body.length <= MAX_FACT && !body.includes('[[') && !body.includes(']]')) fact = body;",
      '      if (body) fact = body;']],
    tests: ['packages/core/test/memory-auto.mjs'],
  },
  {
    name: '记忆：句中出现的标记也算数',
    claim: '只认"整行就是标记"这一种写法 —— 混在句子中间的一个字都不记',
    pkg: './packages/core',
    files: [['packages/core/src/memory.ts',
      '    const whole = MARK_LINE.exec(line);',
      "    const whole = /\\[\\[记住[:：][ \\t]*(.*?)[ \\t]*\\]\\]/.exec(line);"]],
    tests: ['packages/core/test/memory-auto.mjs'],
  },
  {
    name: '记忆：句中的标记不摘，跟着回答发出去',
    claim: '摘得比认得宽：任何位置出现的标记都不许让主人看见',
    pkg: './packages/core',
    files: [['packages/core/src/memory.ts',
      "    kept.push(line.replace(MARK_ANY, '').trimEnd());",
      '    kept.push(line.trimEnd());']],
    tests: ['packages/core/test/memory-auto.mjs'],
  },
  {
    name: '记忆：一次记了第一条，不是最后一条',
    claim: '一次最多认一条，多了认最后一条（越靠后越像最终结论）',
    pkg: './packages/core',
    files: [['packages/core/src/memory.ts',
      "      if (body && body.length <= MAX_FACT && !body.includes('[[') && !body.includes(']]')) fact = body;",
      '      if (!fact && body) fact = body;']],
    tests: ['packages/core/test/memory-auto.mjs'],
  },
  {
    name: '记忆：存不进去就把这一轮也炸掉',
    claim: '记账失败绝不能连累回答 —— 主人要的是答案，不是一条写不进去的报错',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      '      this.log(`⚠ 记忆没写进去：${errText(error)}`);\n      return stripped;',
      '      this.log(`⚠ 记忆没写进去：${errText(error)}`);\n      throw error;']],
    tests: ['packages/core/test/memory-auto.mjs'],
  },
  {
    name: '自检：从来没配置过，却让人去"修好"那份不存在的文件',
    claim: '文件不在（压根没配置过）和文件坏了是两回事：前者给一行能抄的命令（butler init），后者才说修好它',
    pkg: './packages/cli',
    files: [['packages/cli/src/doctor.ts',
      '      fix: !options.configPath || existsSync(options.configPath)',
      '      fix: true']],
    tests: ['packages/cli/test/doctor.mjs'],
  },
  {
    name: '限时授权：期限读不懂也照记（等于当成了永远）',
    claim: '期限那句没读懂就一条都不许记 —— 没看懂当永远，是最坏的一种猜法',
    pkg: './packages/core',
    files: [['packages/core/src/index.ts',
      '      if (win && !win.ok) {',
      '      if (false) {']],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '限时授权：过点了还算数',
    claim: '限时授权一到点就自动不算数（退回每次都问），不用主人记着来收',
    pkg: './packages/core',
    files: [['packages/core/src/grants.ts',
      '  return grants.filter((g) => !g.until || Date.parse(g.until) > now);',
      '  return grants.slice();']],
    tests: ['packages/core/test/grants.mjs'],
  },
  {
    name: '限时授权：老记录（没写期限）反而不算数了',
    claim: '没写期限的老记录 = 永远算数；这次改动不许把老授权弄丢',
    pkg: './packages/core',
    files: [['packages/core/src/grants.ts',
      '  return grants.filter((g) => !g.until || Date.parse(g.until) > now);',
      '  return grants.filter((g) => typeof g.until === \'string\' && Date.parse(g.until) > now);']],
    tests: ['packages/core/test/grants.mjs'],
  },
  {
    name: '授权提示里不提"只免这一阵子"的说法',
    claim: '决定的那一刻就要教他带期限怎么给 —— 不然限时授权等于藏起来了',
    pkg: './packages/core',
    files: [['packages/core/src/approval.ts',
      "    '（只想这一阵子别问：回「以后这类都行 1，一小时」——到点我自己恢复，不用你记着来收。）',",
      "    '',"]],
    tests: ['packages/core/test/commands.mjs'],
  },
  {
    name: '自检：插件抛了就静默跳过（报告看起来更干净）',
    claim: '某个插件的 check() 抛了，必须显成"没过"占一条 —— 静默跳过等于替它掩饰',
    pkg: './packages/core',
    files: [['packages/core/src/selfcheck.ts',
      "  } catch (error) {\n    return [{\n      where: target.label,\n      name: '自检本身出错了',\n      ok: false,\n      detail: error instanceof Error ? error.message : String(error),\n      fix: UNKNOWN_FIX,\n    }];\n  }",
      "  } catch (error) {\n    return [];\n  }"]],
    tests: ['packages/core/test/selfcheck.mjs', 'packages/core/test/commands.mjs'],
  },
  {
    name: '自检：check() 返回的不是清单，也当没看见',
    claim: '返回的不是一份检查清单 = 没测出来，也算没过（不许静默少一项）',
    pkg: './packages/core',
    files: [['packages/core/src/selfcheck.ts',
      "    if (!Array.isArray(got)) {\n      return [{\n        where: target.label,\n        name: '自检没测出来',\n        ok: false,\n        detail: `这一层的自检返回的不是一份检查清单（拿到的是 ${typeof got}）`,\n        fix: UNKNOWN_FIX,\n      }];\n    }",
      "    if (!Array.isArray(got)) {\n      return [];\n    }"]],
    tests: ['packages/core/test/selfcheck.mjs'],
  },
  {
    name: '自检：一项都没查成，却说成"都正常"',
    claim: '「一项都没查」和「都正常」是两回事 —— 混为一谈正是这份报告最坏的错法',
    pkg: './packages/core',
    files: [['packages/core/src/selfcheck.ts',
      `  if (total === 0) return '什么都没查到 —— 这一圈没有任何一层提供自检，所以这份报告**说明不了"没问题"**。';`,
      `  if (bad === 0) return '都正常 —— 能收能答。';`]],
    tests: ['packages/core/test/selfcheck.mjs'],
  },
  {
    name: '自检：连自检自己都没跑起来，还说"都正常"',
    claim: '自检整个挂了的时候，绝不能说成"都正常" —— 那是拿假绿蒙主人',
    pkg: './packages/core',
    files: [['packages/core/src/selfcheck.ts',
      "    '我这份自检没跑起来：',",
      "    '都正常。',"]],
    tests: ['packages/core/test/selfcheck.mjs'],
  },
  {
    name: '自检：问的时候把 this 丢了',
    claim: '有些 check() 要用自己的 config（telegram 就是），必须 .call(实例) 留住 this',
    pkg: './packages/core',
    files: [['packages/core/src/selfcheck.ts',
      "    const got = await check.call(target.instance);   // 有些实现要用自己的 config，得留住 this",
      "    const got = await check();"]],
    tests: ['packages/core/test/selfcheck.mjs'],
  },
  {
    name: '开场白里不提那条逃生口（自检）',
    claim: '不懂技术的人碰到的头号问题是"发消息没反应"，而开场白是他唯一会读的一段',
    pkg: './packages/core',
    files: [['packages/core/src/welcome.ts',
      "    '万一我半天不理你：先回「自检」，我自己查一遍、告诉你哪儿不对；',\n",
      ""]],
    tests: ['packages/core/test/welcome.mjs'],
  },
  {
    name: '微信自检：没登录也报绿',
    claim: '没有登录态就必须报红 —— 绿了等于告诉主人"你能收到消息"，而事实相反',
    pkg: './packages/channel-wechat',
    files: [['packages/channel-wechat/src/plugin.mjs',
      "    if (token?.botToken) {",
      "    if (true) {"]],
    tests: ['packages/channel-wechat/test/plugin.mjs'],
  },
  {
    name: '微信自检：把"登录态存过"说成"已登录"',
    claim: 'token 文件在 ≠ 现在还有效 —— 说成"已登录"是主人既没法核实也没法反驳的假绿',
    pkg: './packages/channel-wechat',
    files: [['packages/channel-wechat/src/plugin.mjs',
      "        detail: `登录态存过（${when} 扫的码）—— 这只说明存过，说明不了现在还有效；`",
      "        detail: `已登录（${when} 扫的码）`,"]],
    tests: ['packages/channel-wechat/test/plugin.mjs'],
  },
  {
    name: '开场白只教「回自检」，不管"连自检都没人回"',
    claim: '它彻底不回的时候，回「自检」一样没人听 —— 那条路必须留给"再装一次"',
    pkg: './packages/core',
    files: [['packages/core/src/welcome.ts',
      "    '要是连这句也没人回，就再双击一次装我的那个文件（install.command）—— 我会重新起来，',\n",
      ""]],
    tests: ['packages/core/test/welcome.mjs'],
  },

  // ── 第 63 轮：把**飞书验收手册的离线演练**也变成 witness ──
  // 下面四条的 `e2e` 写的是脚本路径（见 runner 里对 e2e 的说明）。每条各打掉演练里的一条断言，
  // 所以"演练 20 项 ✅"从此有东西盯着 —— 不再依赖"我还记得手工做一次突变控制"。
  // ⚠️ 这四条也顺手补上了 e2e 分支原来**不重编**的洞（变异点在 `.ts` 上时，副本里的 lib/
  //    还是原代码，裁决就成了关于"什么都没发生"的）。
  {
    name: '飞书私聊准入：doctor 不再报告这一条',
    claim: 'doctor 会说出「谁能私聊它」（默认 open 等于企业里同公司的人都能私聊它，得当众说清）',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    // ⚠️ 锚点必须是**默认那条路**会走到的那个 `name`。第一版改的是下面 `ok: false` 那处的名字，
    //    而默认（open）走的是 `ok: true` 这条 return —— 字符串还在别处，doctor 照样打出来，
    //    于是这条突变**没牙**（`mutate` 当场用「★ 还是绿的」把它抓了出来）。
    files: [[FEISHU,
      "    if (cliIds.length === 0) return { name: '飞书私聊准入', ok: true, detail };",
      "    if (cliIds.length === 0) return { name: '私聊准入', ok: true, detail };"]],
  },
  {
    name: '飞书私聊准入：报 allowlist 时不再说名单里有几条',
    claim: '报 dmMode=allowlist 时说清名单里有几条（不说的话，"我配了白名单"和"配了个空名单"看起来一样）',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    files: [[FEISHU, '`（名单 ${this.config.dmAllowlist.length} 条）`', "''"]],
  },
  {
    name: '飞书私聊准入：填成应用 id（cli_…）也不再吭声',
    claim: 'dmAllowlist 里出现应用 id（cli_…）时必须报 ✗ —— 那不是发送者，等于谁也没放行，而表面上"我配了白名单"',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    files: [[FEISHU, 'if (cliIds.length === 0)', 'if (true)']],
  },
  {
    name: '飞书私聊准入：dmMode 写错在装载时不再报错',
    claim: 'dmMode 写错（比如 allowList）在**装载时**直接报错，不会悄悄按 open 放行 —— 静默放行是最坏的失败',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    files: [[FEISHU, 'z.union(DM_MODES.map((mode) => z.const(mode)))', 'z.string()']],
  },
  // 第 66 轮：手册第十二节「跑通的标志」列的那 5 句，现在由演练逐句盯着（两头都要对得上：
  // 手册那节里有、探针源码里也有一条**打印它**的语句）。下面两条各打掉一个方向。
  {
    name: '手册承诺的探针输出：探针不再打印『收到一条消息：』',
    claim: '手册说跑通的标志里有 `收到一条消息：`，那探针源码里就必须真有一条打印它的语句',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    files: [['packages/channel-feishu/probe/smoke.mjs',
      "console.log('收到一条消息：')",
      "console.log('收到一条来信：')"]],
  },
  {
    // ⚠️ 这一条是**故意**留成这个形状的：字符串还在文件里，只是退化成一句注释。
    //    判据要是"grep 得到这个字符串"，它就**照样绿** —— 而探针根本不会再打印它。
    //    第 66 轮真踩到过这一步：按行号找「长连接已建立。机器人身份：」，第一处命中的
    //    正是 `smoke.mjs` 第 39 行那句注释（它在解释"这行字会被官方日志淹掉"）。
    name: '手册承诺的探针输出：只剩注释、没有打印语句（"只 grep 字符串"会放过）',
    claim: '判据必须是"这句话在一条 console.* 语句里"，不是"文件里出现过这句话" —— 注释里出现过不算',
    pkg: './packages/channel-feishu',
    e2e: 'scripts/rehearse-feishu-manual.sh',
    files: [['packages/channel-feishu/probe/smoke.mjs',
      'console.log(`长连接已建立。机器人身份：${me.name}（${me.openId}）`);',
      '// 长连接已建立。机器人身份：……（这条打印被拿掉了，注释还在）']],
  },
];

// ─────────────────────────── 参数 ───────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (flag('-h') || flag('--help')) {
  console.log(`变异测试 —— 验的不是代码，是测试本身。

  pnpm mutate              全部：故意把代码改坏，看有没有测试喊疼
  pnpm mutate --list       只列出要砸哪些地方（不跑）
  pnpm mutate --only quote 只砸名字/承诺里含 quote 的那几处
  pnpm mutate --quick      跳过要走 e2e 脚本的那几条（clean-room 那两条各要一两分钟）
  pnpm mutate --keep       留着那份副本，跑完告诉你路径（排查用）

退出码：0 = 每一处都被测试抓到；1 = 有"没被盯住"的（那就是洞）；
        2 = 参数/锚点问题；3 = 原仓被动到了（立刻停）。`);
  process.exit(0);
}

const only = valueOf('--only');
const quick = flag('--quick');
const keep = flag('--keep');

let picked = MUTATIONS;
if (only) picked = picked.filter((m) => m.name.includes(only) || (m.claim ?? '').includes(only));
const matchedOnly = picked.length; // --only 到底匹配上几处（在 --quick 过掉之前）
if (quick) picked = picked.filter((m) => !m.e2e);

if (flag('--list')) {
  for (const m of picked) console.log(`${m.e2e ? '[e2e]' : '[unit]'} ${m.name}\n       承诺：${m.claim}`);
  console.log(`\n共 ${picked.length} 处${quick ? '（--quick：跳过了 e2e 那些条）' : ''}`);
  process.exit(0);
}

if (!picked.length) {
  // ⚠️ 这里的报错必须**说实话**。原来不管什么原因都写「--only … 没匹配上任何一处」——
  //    于是 `pnpm mutate --only 飞书私聊准入 --quick` 会说 --only 没匹配上，而其实是**匹配上了**，
  //    只是那几条都是 e2e、又被 --quick 滤掉了（第 63 轮我照着那句话去查 Unicode 规范化，
  //    查错了地方、白花三轮）。把人引到错地方的错误信息，比没有错误信息更坏。
  if (only && matchedOnly > 0) {
    console.error(`--only ${only} 匹配上了 ${matchedOnly} 处，但它们**全是 e2e**，被 --quick 滤掉了。去掉 --quick 再试。`);
  } else if (only) {
    console.error(`--only ${only} 没匹配上任何一处。用 --list 看看有哪些。`);
  } else {
    console.error('--quick 之后一处都不剩了（清单里只有 e2e 条目？）。');
  }
  process.exit(2);
}

// ─────────────────────── 副本 + 绊线 ───────────────────────

/** 原仓"体检"：排除 .git / node_modules / dist（其余全算，lib 也算 —— 编译产物也是它能被弄脏的地方） */
const SKIP = new Set(['.git', 'node_modules', 'dist']);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function treeHash() {
  const h = createHash('sha256');
  for (const p of walk(ROOT).sort()) {
    h.update(relative(ROOT, p));
    h.update(readFileSync(p));
  }
  return h.digest('hex');
}

const die = (msg, code = 2) => { console.error(`\n✖ ${msg}`); process.exit(code); };

// ⚠️ 注意拷到**不存在的**路径上：`cpSync` 的目标若已存在，语义会变成"拷进它里面"，
//    于是所有相对路径都错一层。mkdtemp 建的那层只用来当父目录。
const copy = join(mkdtempSync(join(tmpdir(), 'butler-mutate-')), 'repo');
console.log(`原仓   ${ROOT}`);
console.log(`副本   ${copy}`);
process.on('exit', () => { if (!keep && existsSync(copy)) rmSync(copy, { recursive: true, force: true }); });

const baseline = treeHash();

/**
 * 保险 2 分两层，因为我们既不想漏掉真漏洞、也不想因为"你顺手改了个文档"就误报：
 *   · **致命**：变异点自己（以及它编译出来的 lib）—— 那才是漏回原仓唯一可能的位置
 *   · **提示**：原仓别的文件在这期间变了就提一句，但不打断（那是你自己的事）
 */
const fatal = [];
for (const m of picked) {
  for (const [f] of m.files) {
    fatal.push(f);
    if (f.includes('/src/') && f.endsWith('.ts')) fatal.push(f.replace('/src/', '/lib/').replace(/\.ts$/, '.js'));
  }
}
const hashOf = (files) => {
  const h = createHash('sha256');
  for (const f of [...new Set(files)].sort()) {
    h.update(f);
    h.update(existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f)) : Buffer.from(''));
  }
  return h.digest('hex');
};
const fatalBase = hashOf(fatal);
console.log(`基线   ${baseline.slice(0, 16)}…（原仓全树）+ ${fatalBase.slice(0, 12)}…（变异点）\n`);

cpSync(ROOT, copy, { recursive: true });

/*
 * ⚠️ 修掉**绝对**软链 —— 这是本框架自己的一个盲点，2026-10 被一处"跨包承诺"当场照出来。
 *
 * pnpm 给工作区里的包做的是**绝对**软链（指向 ROOT）。`cpSync` 把软链原样拷过来，
 * 于是副本里的测试 `import '@butler/link-lan'` 时，读到的**还是原仓那一份** ——
 * 改副本里的那个包，测试根本看不见。
 *
 * 后果特别阴：变异"没红"会被读成"这条承诺没被测试盯住"（看上去只是测试不够），
 * 而真相是**跨包的那类变异一律假绿** —— 承诺从来没被验证过。
 *
 * 只修 `@butler/*` 这些工作区链接：指到仓外（pnpm 的 store）的一律不动。
 */
for (const base of [join(copy, 'node_modules'), ...readdirSync(join(copy, 'packages')).map((d) => join(copy, 'packages', d, 'node_modules'))]) {
  const scope = join(base, '@butler');
  if (!existsSync(scope)) continue;
  for (const name of readdirSync(scope)) {
    const link = join(scope, name);
    let to;
    try { to = readlinkSync(link); } catch { continue; }        // 不是软链就跳过
    const inside = relative(ROOT, resolve(link, '..', to));
    if (inside.startsWith('..') || isAbsolute(inside)) continue; // 指向仓内的才修
    rmSync(link);
    symlinkSync(join(copy, inside), link);
  }
}

// 保险 1：副本必须是真副本。硬链接会让"改副本"变成"改原仓"，上一版就是这么翻车的。
for (const m of picked) {
  for (const [f] of m.files) {
    const a = statSync(join(ROOT, f)).ino;
    const b = statSync(join(copy, f)).ino;
    if (a === b) die(`${f} 在副本和原仓里是同一个 inode —— 这不是副本，拒绝继续`);
  }
}
console.log('保险 1 ✅ 副本是真副本（inode 全都不同）\n');

// ─────────────────────────── 跑 ───────────────────────────

function run(cmd, args, timeout = 15 * 60 * 1000) {
  try {
    const out = execFileSync(cmd, args, { cwd: copy, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    return { code: e.status ?? (e.signal ? -1 : 1), out, timedOut: e.signal === 'SIGTERM' };
  }
}

const results = [];

for (const m of picked) {
  const snap = new Map();
  let note = '';
  let verdict = '';

  try {
    for (const [f, from, to] of m.files) {
      const p = join(copy, f);
      const s = readFileSync(p, 'utf8');
      snap.set(f, s);
      const hits = s.split(from).length - 1;
      if (hits !== 1) throw new Error(`锚点对不上（${f}：期望 1 处，实际 ${hits} 处）`);
      writeFileSync(p, s.replace(from, to));
    }

    // 重编变异点所属的包，并确认产物**真的变了** —— 否则"没红"可能只是没编译到。
    // ⭐ 第 63 轮：原来只有 `node --test` 那条路会重编，`e2e` 那条**不重编**。对 `install.sh`
    //    这类 shell 目标是无害的（本来就不用编译），但变异点一旦落在 `.ts` 上，副本里的
    //    `lib/` 还是**原代码** —— 于是"红了 / 还是绿的"这个裁决是关于"什么都没发生"的。
    //    （`finally` 里那句会把产物再编回去。）
    const recompile = () => {
      if (!m.pkg) return;
      const libOf = (f) => join(copy, f.replace('/src/', '/lib/').replace(/\.ts$/, '.js'));
      const before = m.files.filter(([f]) => f.endsWith('.ts')).map(([f]) => [f, readFileSync(libOf(f), 'utf8')]);
      run('pnpm', ['--filter', m.pkg, 'run', 'build']);
      for (const [f, was] of before) {
        if (readFileSync(libOf(f), 'utf8') === was) throw new Error(`编译产物没变（${f}）—— 这次不算数`);
      }
    };

    if (m.e2e) {
      recompile();
      // `e2e: true` = 历史上唯一那条 clean-room 脚本；写成**字符串**可以指定别的脚本。
      // 第 63 轮起，飞书验收手册的离线演练（`scripts/rehearse-feishu-manual.sh`）也在这里当 witness。
      const script = typeof m.e2e === 'string' ? m.e2e : 'scripts/verify-clean-install.sh';
      const r = run('sh', [script]);
      const bad = [...r.out.matchAll(/❌[^\n]*/g)].map((x) => x[0]);
      verdict = r.code !== 0 ? 'red' : 'green';
      note = bad[0] ?? (r.timedOut ? '超时' : `退出码 ${r.code}`);
    } else {
      recompile();
      const r = run('node', ['--test', ...m.tests]);
      const n = Number(/ℹ fail (\d+)/.exec(r.out)?.[1] ?? -1);
      verdict = (r.code !== 0 || n > 0) ? 'red' : 'green';
      const first = /✖ [^\n]*/.exec(r.out)?.[0] ?? '';
      note = n >= 0 ? `${n} 条失败　${first}` : `退出码 ${r.code}`;
    }
  } catch (e) {
    verdict = 'skip';
    note = e.message;
  } finally {
    for (const [f, s] of snap) writeFileSync(join(copy, f), s);
    if (m.pkg) run('pnpm', ['--filter', m.pkg, 'run', 'build']);
  }

  const mark = verdict === 'red' ? '红了 ✅' : verdict === 'green' ? '★ 还是绿的' : '⚠ 不算数';
  console.log(`${mark}  ${m.name}`);
  console.log(`          ${note}`);

  // 保险 2：变异点只要有一个字节变了，立刻停（别的地方变了只提一句）
  if (hashOf(fatal) !== fatalBase) {
    console.log('');
    die('原仓里的**变异点**被改动了 —— 已停下，先修原仓（副本在 ' + copy + '）', 3);
  }
  if (treeHash() !== baseline) {
    console.log('          （提一句：原仓有别的文件在这期间变了 —— 不是这次砸的）');
  }

  results.push({ ...m, verdict, note });
}

// ─────────────────────────── 结论 ───────────────────────────

const red = results.filter((r) => r.verdict === 'red').length;
const green = results.filter((r) => r.verdict === 'green');
const skipped = results.filter((r) => r.verdict === 'skip');

console.log(`\n${'─'.repeat(64)}`);
console.log(`砸了 ${results.length} 处：${red} 处见血，${green.length} 处**没被任何测试盯住**`
  + (skipped.length ? `，${skipped.length} 处不算数` : ''));
console.log(`保险 2 ✅ 原仓变异点自始至终没变（${fatalBase.slice(0, 12)}…）`);
if (keep) console.log(`副本留着：${copy}`);

if (green.length) {
  console.log('\n没被盯住的（这些"承诺"目前只是嘴上说说）：');
  for (const g of green) console.log(`  · ${g.name}\n    承诺：${g.claim}\n    建议：补一条会红的用例，再把它加进这份清单`);
}
if (skipped.length) {
  console.log('\n不算数的（锚点没对上 / 编译产物没变 —— 清单该跟着代码一起更新）：');
  for (const s of skipped) console.log(`  · ${s.name}：${s.note}`);
}

process.exit(green.length || skipped.length ? 1 : 0);
