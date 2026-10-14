#!/bin/sh
# ============================================================================
# 飞书验收手册（docs/CHANNEL-FEISHU.md 第十二节）的**离线演练**。
#
#   sh scripts/rehearse-feishu-manual.sh
#
# 手册里真正要人做的只有一件事：**拿手机扫码**（进真企业、建自建应用、收一条消息）。
# 除了那一步，其余每一步都能在这台机器上按手册的顺序走一遍 —— 这个脚本就是走它：
#
#   第 0 步  butler --version / butler doctor 的通道那行
#   探针那条  doctor 印出来的命令**真的存在**、而且 --dry 跑得通
#   第 5 步  butler init --im feishu → butler run（假凭据 ⇒ 手册预期的那句失败）
#
# 纪律：
#   · 只在**临时家目录**里动手；跑完还要核对真 ~/.butler 的 sha 没变（没变才打印 ✅）
#   · 凭据是**假**的（cli_fake_…），而且反着查一遍：假 secret 不许出现在任何输出里
#   · `butler run` 会被 kill —— 所以先给个假模型 key（DEEPSEEK_API_KEY），
#     否则它会停在"贴模型 key"那张页面上，根本走不到飞书那一步（第 58 轮量出来的）
#
# 自检（脚本自己的反向控制）：把 BUTLER_CLI 指到一个什么都不干、什么都不打印的替身上，它必须**红**：
#   printf '#!/bin/sh\nexit 0\n' > /tmp/butler-stub.sh && chmod +x /tmp/butler-stub.sh
#   BUTLER_CLI=/tmp/butler-stub.sh sh scripts/rehearse-feishu-manual.sh    # 期望：非零退出
# 这就是"断言不是摆设"的判据 —— 全绿但换个假 CLI 也全绿，那这个脚本没在验任何东西。
# （注意别写 /bin/true：macOS 上没有这个文件，那样红的是"找不到 CLI"，红得不是地方。）
# ============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CLI="${BUTLER_CLI:-${ROOT}/packages/cli/lib/cli.js}"
REAL_HOME="${HOME}/.butler"

pass=0
step() { printf '\n=== %s ===\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; exit 1; }

[ -f "${CLI}" ] || bad "找不到 CLI：${CLI}（先 pnpm build）"

TMP=$(mktemp -d)
HOME_DIR="${TMP}/home"
mkdir -p "${HOME_DIR}"

# ⚠️ 命门：这个脚本**绝不许**碰到真家。先把"我们等下用的家"钉死在临时目录里。
case "${HOME_DIR}" in
  "${TMP}"/*) : ;;
  *) bad "临时家不在 mktemp 目录里：${HOME_DIR}" ;;
esac

# 真家的指纹：跑完必须一模一样（文件不在也算一种状态）
real_fp() {
  if [ -f "${REAL_HOME}/config.json" ]; then
    shasum -a 256 "${REAL_HOME}/config.json" | awk '{print $1}'
  else
    printf '（没有 config.json）\n'
  fi
}
REAL_BEFORE=$(real_fp)

# 假的，一眼看得出是假的；而且这个值会拿去反查"有没有泄漏"
FAKE_ID='cli_fake_rehearsal'
FAKE_SECRET='fake-secret-must-not-leak-58'

butler() { env HOME="${HOME_DIR}" "$@"; }
cli() { butler "${CLI}" "$@"; }

# ─────────────────────── 第 0 步 ───────────────────────

step "第 0 步：版本与 doctor（手册第一节）"

VERSION=$(cli --version 2>&1 | head -1)
printf ' 版本：%s\n' "${VERSION}"
case "${VERSION}" in
  [0-9]*.[0-9]*.[0-9]*) : ;;
  *) bad "版本号不像 x.y.z：${VERSION}" ;;
esac
# 手册说的是「0.2.1 起」。比大小别用字符串比 —— 拆成三个数比。
awk -F. -v v="${VERSION}" 'BEGIN {
  split(v, a, "."); if (a[1] > 0) exit 0; if (a[2] > 2) exit 0; if (a[2] == 2 && a[3] >= 1) exit 0; exit 1
}' || bad "版本 ${VERSION} 低于手册对应的 0.2.1"
ok "版本 ${VERSION} ≥ 0.2.1"

cli doctor > "${TMP}/doctor-before.log" 2>&1 || true
grep -q '还没有配置过' "${TMP}/doctor-before.log" \
  || bad "init 之前 doctor 没说清楚「还没有配置过」"
grep -q 'butler init' "${TMP}/doctor-before.log" || bad "init 之前 doctor 没告诉他去跑 butler init"
ok "init 之前：doctor 说的是人话（下一步跑什么）"

# ─────────────────────── init → 引导页 ───────────────────────

step "第 5 步之前半：butler init --im feishu"

cli init --im feishu > "${TMP}/init.log" 2>&1 || bad "butler init --im feishu 没成功"
CONFIG="${HOME_DIR}/.butler/config.json"
[ -f "${CONFIG}" ] || bad "init 没写 config.json"
grep -q '@butler/channel-feishu' "${CONFIG}" || bad "配置里那条通道不是 channel-feishu"
ok "init 写好了配置，通道行是 @butler/channel-feishu"

# 引导页那条探针命令：手册承诺「照着敲就行」⇒ 文件**必须真的在**。
# 只认反引号里的 `node <路径> …`；路径里带着包自己的位置，所以源码树/装机都对。
PROBE_CMD=$(sed -n 's/.*`node \([^`]*smoke\.mjs\)[^`]*`.*/\1/p' "${TMP}/init.log" | head -1)
[ -n "${PROBE_CMD}" ] || bad "引导页里没找到那条探针命令（手册承诺它一定会印）"
[ -f "${PROBE_CMD}" ] || bad "引导页印的探针路径**不存在**：${PROBE_CMD}"
ok "引导页那条探针命令指着一个真文件：$(basename "${PROBE_CMD}")"

# 同一句也印在 doctor 里（手册：「butler doctor 就会印出你能照着敲的那条完整命令」）
if grep -q 'smoke.mjs' "${TMP}/doctor-before.log"; then
  ok "doctor 也印了同一条探针命令"
else
  printf '  ⚠️  这次 doctor 没印探针命令（凭据目录还不存在，属于正常路径）\n'
fi

# --dry：不联网、不扫码，只证明这条命令本身能起来
butler node "${PROBE_CMD}" --dry > "${TMP}/probe-dry.log" 2>&1 \
  || bad "探针 --dry 跑不通（那条命令是给用户照抄的）"
ok "探针 --dry 跑得通"

# ─────────────────────── 假凭据 → doctor ───────────────────────

step "第 5 步之前半分：写上（假的）凭据，看 doctor 怎么说"

mkdir -p "${HOME_DIR}/.butler/state"
printf '{"version":1,"channels":{"feishu":{"appId":"%s","appSecret":"%s"}}}' \
  "${FAKE_ID}" "${FAKE_SECRET}" > "${HOME_DIR}/.butler/state/secrets.json"
chmod 600 "${HOME_DIR}/.butler/state/secrets.json"

cli doctor > "${TMP}/doctor-after.log" 2>&1 || true
grep -q '✓  channel  @butler/channel-feishu' "${TMP}/doctor-after.log" \
  || bad "doctor 里没看到通道装载成功那行"
ok "doctor：channel @butler/channel-feishu 装上了"

# 假凭据必然拿不到 tenant_access_token —— 手册要的是「他说人话，而不是一句 code」
grep -q '拿应用信息没成功' "${TMP}/doctor-after.log" || bad "doctor 没说登录态没拿到"
grep -q '凭据不属于这个应用' "${TMP}/doctor-after.log" || bad "doctor 没给出第一种可能（凭据不对）"
grep -q '应用缺权限' "${TMP}/doctor-after.log" || bad "doctor 没给出第二种可能（权限没开）"
grep -q '改动要发新版才生效' "${TMP}/doctor-after.log" \
  || bad "doctor 没提醒「改配置不发版不生效」这个大坑"
ok "doctor：登录态失败时说清了两种可能，还点了「改配置要发版」"

grep -q '飞书去重表' "${TMP}/doctor-after.log" || bad "doctor 没报告去重表"
ok "doctor：去重表那行在（M-a 的幂等靠它）"

# ─────────────────────── butler run ───────────────────────

step "第 5 步后半：butler run（假凭据 ⇒ 手册预期的那句失败）"

# 假模型 key：不然它会停在"贴模型 key"那张页面上，走不到飞书这一步。
# ⚠️ 两个坑都踩过（第 58 轮）：
#   ① 重定向要罩住**整个子 shell** —— 只罩 env 那条命令的话，EXIT= 会漏到脚本自己的 stdout 上；
#   ② 得用 if，不能写成 `run; printf EXIT=$?` —— `set -e` **会被子 shell 继承**，
#      run 一返回 1 子 shell 就当场退了，printf 根本轮不到（退出码永远是"没有"）。
( if env HOME="${HOME_DIR}" DEEPSEEK_API_KEY='sk-fake-rehearsal' \
      BUTLER_LOG_LEVEL=debug "${CLI}" run; then
    printf 'EXIT=0\n'
  else
    printf 'EXIT=%s\n' "$?"
  fi ) > "${TMP}/run.log" 2>&1 &
RUN_PID=$!
waited=0
while [ "${waited}" -lt 40 ]; do
  sleep 1
  waited=$((waited + 1))
  kill -0 "${RUN_PID}" 2>/dev/null || break
done
if kill -0 "${RUN_PID}" 2>/dev/null; then
  kill "${RUN_PID}" 2>/dev/null || true
  wait "${RUN_PID}" 2>/dev/null || true
  bad "butler run 40 秒还没自己退出（手册说这条路会带着原因退出来）"
fi
wait "${RUN_PID}" 2>/dev/null || true

grep -q '内核启动：通道=feishu' "${TMP}/run.log" || bad "内核没以 feishu 通道启动"
ok "内核启动：通道=feishu"
grep -q 'client ready' "${TMP}/run.log" || bad "官方 SDK 没起来（debug 档下应能看到 client ready）"
ok "官方 SDK 起来了（client ready）"
grep -q 'not_connected' "${TMP}/run.log" || bad "没看到长连接失败的原因（not_connected）"
grep -q '是"上线"这一步没过' "${TMP}/run.log" || bad "没看到那句给用户的话"
ok "连不上时说清了原因，也说了「插件装上了、是上线没过」"
RUN_EXIT=$(grep '^EXIT=' "${TMP}/run.log" || printf '（没有 EXIT= 那行）\n')
[ "${RUN_EXIT}" = 'EXIT=1' ] || bad "butler run 的退出码不是 1，实际：${RUN_EXIT}"
ok "butler run 带着原因自己退出来了（EXIT=1）"

# 假凭据进得去，说明它没停在"贴模型 key"那步 —— 也就是真走到了飞书
if grep -q '模型 key：还没有' "${TMP}/run.log"; then
  bad "它停在了「贴模型 key」那一步，没走到飞书（演练没覆盖到该覆盖的地方）"
fi
ok "模型 key 那一步被跳过了（环境变量给了），确实走到了飞书"

# 不许开引导页（那会印一条带一次性 token 的链接）
if grep -q 'http://127.0.0.1' "${TMP}/run.log"; then
  bad "run 里出现了本地引导页链接（假凭据不该走到那儿）"
fi
ok "没有开出引导页链接"

# ─────────────────────── 私聊准入（第 59/60 轮） ───────────────────────

step "谁能在私聊里跟它说话（手册第十二节那段）"

# 手册给用户的动作是"往 config.json 里那条通道的 config 下加两行"。这里就照做。
# ⚠️ 补丁必须**幂等**，而且**要会补逗号** —— 这两条都是我写第一版时踩的：
#    ① 直接往 appSecret 后面插，第二次调用插出重复键 ⇒ 先删旧行、再插；
#    ② appSecret 是那个对象里**最后一个键**，它后面本来没有逗号 —— 插进来两行之后
#       `"appSecret": ""` 和 `"dmMode"` 之间就缺一个逗号，整个 config.json 当场不是 JSON
#       （doctor 只会说"不是合法的 JSON"，看不出是哪儿少的）。所以插入时给 appSecret 补逗号。
#    这也正是**用户手改会踩的同一个坑**，手册里为此专门加了一句提醒。
patch_dm() {   # $1 = dmMode 值；$2 = dmAllowlist（JSON 数组字面量）
  grep -v '"dmMode":\|"dmAllowlist":' "${CONFIG}" > "${CONFIG}.new" || true
  grep -q '"id": "channel"' "${CONFIG}.new" \
    || { rm -f "${CONFIG}.new"; bad "删掉 dm 那两行之后 config 不像配置了，中止"; }
  mv "${CONFIG}.new" "${CONFIG}"
  awk -v mode="$1" -v list="$2" '
    /"appSecret"/ && !done {
      line = $0
      sub(/,[[:space:]]*$/, "", line)          # 幂等：本来就带逗号先去掉
      printf "%s,\n", line                     # 插在中间 ⇒ 这一行现在必须有逗号
      printf "          \"dmMode\": \"%s\",\n          \"dmAllowlist\": %s\n", mode, list
      done = 1
      next
    }
    { print }
    END { if (!done) exit 1 }
  ' "${CONFIG}" > "${CONFIG}.new" \
    || { rm -f "${CONFIG}.new"; bad "往 config.json 里插 dmMode 失败（找不到 appSecret 那一行）"; }
  mv "${CONFIG}.new" "${CONFIG}"
  # ⚠️ 自证一笔：这个补丁是我手搓的 JSON 编辑，第一版连着写坏两次（少了逗号、又多了尾逗号），
  #    而报出来的却是"不是合法的 JSON" —— 看着像产品的问题，其实是补丁自己的 bug。
  #    所以每打一次补丁就让它自己证明产出的还是合法 JSON；不合法就红在**这里**，别再往下赖。
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${CONFIG}" \
    || bad "补丁之后 config.json 不是合法 JSON —— 这是演练脚本自己的 bug，不是产品的问题"
}

# ① 没写这两个字段 = 默认 open：手册说这等于"企业里谁都能私聊它" ⇒ 要如实说，但**不是错误**
cli doctor > "${TMP}/doctor-dm-default.log" 2>&1 || true
grep -q '飞书私聊准入' "${TMP}/doctor-dm-default.log" || bad "doctor 没报「飞书私聊准入」这一条"
grep -q 'dmMode=open' "${TMP}/doctor-dm-default.log" || bad "默认没被如实说成 open"
grep -q '谁都能私聊它' "${TMP}/doctor-dm-default.log" || bad "默认 open 没被说成人话"
ok "默认：doctor 报 dmMode=open，并说清它的含义"

# ② 手册教你填的是**发送者** id（ou_…）：应该报 ✓，不许误报成 ✗
patch_dm 'allowlist' '["ou_someone_real"]'
cli doctor > "${TMP}/doctor-dm-good.log" 2>&1 || true
grep -q 'dmMode=allowlist' "${TMP}/doctor-dm-good.log" || bad "allowlist 没被报出来"
grep -q '名单 1 条' "${TMP}/doctor-dm-good.log" || bad "没说清名单里有几条"
if grep -q '✗  飞书私聊准入' "${TMP}/doctor-dm-good.log"; then
  bad "合法的 allowlist 被报成了 ✗"
fi
ok "配对了：doctor 说 dmMode=allowlist（名单 1 条），没误报 ✗"

# ③ 手册点名警示的那个坑：填成应用 id（cli_…）⇒ 必须报 ✗，并说清去哪儿抄真正的 id
patch_dm 'allowlist' '["cli_wrong_thing"]'
cli doctor > "${TMP}/doctor-dm-bad.log" 2>&1 || true
grep -q '等于没放行' "${TMP}/doctor-dm-bad.log" || bad "cli_ 那条错配没被报出来"
grep -q 'senderId' "${TMP}/doctor-dm-bad.log" || bad "没告诉用户去哪儿抄真正的 senderId"
ok "填成应用 id：doctor 报出来了，并指了 senderId 那条路"

# ④ 手册承诺「dmMode 写错（比如 allowList）会在**装载时**直接报错，不会悄悄按 open 放行」。
#    这条最值得离线验一遍：官方对不认识的 dmMode 是照 open 处理的，"静默放行"是最坏的失败。
patch_dm 'allowList' '[]'
cli doctor > "${TMP}/doctor-dm-typo.log" 2>&1 || true

# ⚠️ 这里原来写的是 `grep 'dmMode'` —— 那是个**假断言**：拼错之后自检会照常打出
#    `dmMode=allowList`，这条 grep 就被那个"邻字符串"满足了（第 61 轮用突变控制抓到的：
#    把 schema 换回 z.string() 它**照样绿**）。所以两头都要钉死：
#    ① 要看到**枚举校验**那句错（这是"装载时就报错"的唯一证据）；
#    ② 不许出现任何 `dmMode=` —— 出现了就说明它被"接受"了，也就是手册警告的那种静默放行。
grep -q 'but got "allowList"' "${TMP}/doctor-dm-typo.log" \
  || bad "拼错的 dmMode 没在装载时报错（手册承诺会报）"
if grep -q 'dmMode=' "${TMP}/doctor-dm-typo.log"; then
  bad "拼错的 dmMode 被接受了（自检照常打出 dmMode=…）—— 手册说这会在装载时就报错"
fi
ok "拼错的 dmMode：装载时真的报错了（枚举校验），没有悄悄按 open 走"

# ─────────────────────── 反泄漏 ───────────────────────

step "反着查一遍：假凭据不许出现在任何输出里"

for f in "${TMP}/doctor-before.log" "${TMP}/init.log" "${TMP}/probe-dry.log" \
         "${TMP}/doctor-after.log" "${TMP}/run.log" \
         "${TMP}/doctor-dm-default.log" "${TMP}/doctor-dm-good.log" \
         "${TMP}/doctor-dm-bad.log" "${TMP}/doctor-dm-typo.log"; do
  if grep -q "${FAKE_SECRET}" "${f}"; then
    bad "$(basename "${f}") 里出现了 app_secret 的值"
  fi
done
ok "九份输出里都没有 app_secret 的值"

# ─────────────────────── 真家没被动过 ───────────────────────

step "收尾：真 ~/.butler 一个字节都没动"

REAL_AFTER=$(real_fp)
[ "${REAL_BEFORE}" = "${REAL_AFTER}" ] \
  || bad "真家被动过了！跑之前 ${REAL_BEFORE}，跑之后 ${REAL_AFTER}"
ok "真家指纹一致（${REAL_AFTER}）"

printf '\n全部走完：%s 项 ✅。\n' "${pass}"
printf '（唯一走不了的是「拿手机扫码进真企业」那一步 —— 那只能人来做。）\n'
