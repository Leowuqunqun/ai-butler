#!/bin/sh
# ============================================================================
# 升级演练：**已经装着老版本的机器**上，重跑一次安装命令会怎样。
#
#   sh scripts/verify-upgrade.sh
#
# 为什么要它：`verify-clean-install.sh` 走的是"干净机器第一次装"。可用户真正的处境常常是
# **住着的房子** —— 里面已经有配置、有凭据、有收件箱。升级要同时证明**四件事**：
#
#   · 新版该来的东西来了（这里：飞书那个包 + 它的探针）
#   · **老的东西真被换掉了** —— 程序本体的版本换了（0.1.0 → 新的），树里没有残留的老版本包。
#     merge 安装（`mkdir -p`）最容易糊弄过去的就是这条：新文件来了，跑的还是旧的
#   · 他原来的东西**一个字节都没变**（配置 / 凭据 / 凭据权限）
#   · 升级后那两条命令真能用（`butler doctor`、`butler init --im feishu`），而且
#     换通道**只换那一行**（第 23 轮的保证）
#
# 纪律（和干净安装那个脚本一样）：
#   · 只在临时 HOME 里动手 —— 真 ~/.butler 一个字节都不碰
#     （`install.sh` 里 `HOME_DIR="${HOME}"`、`BUTLER_DIR="${HOME_DIR}/.butler"`，
#      所以把 HOME 指到临时目录，整间房子就都是临时的）
#   · 不碰真的自启动：一律 `--no-start`，也不加 `--add-path`
#   · 不登微信、不贴 key（要真人扫码，故意不测）
#   · **`step` / `ok` / `bad` 的标题里不许出现反引号** —— 它们在**双引号**里，反引号就是**命令替换**：
#     写 `step "… `butler run` …"` 会在拼这行标题的时候**真的把 butler run 跑起来**（还没重定向、
#     还没人来收它）。这个坑仓库里踩过两次：一次在 install.sh 的 heredoc 里（教训记在
#     make-installer-bundle.sh），一次就在本脚本 —— 卡死 27 分钟，我一度以为"后台起进程的壳有问题"，
#     其实是标题里的反引号。想在标题里强调命令名，用「」或者干脆不加引号。
#
# 走的是**发布出来的真包**：v0.1.0（旧）→ latest（新）。中间那步就是用户要敲的
# `curl … | sh` —— 所以这个脚本本身也是对"那条命令能不能用"的验收。
# ============================================================================
set -eu

TMP=$(mktemp -d)
# 收尾：先把可能还挂着的 `butler run` 送走，再删临时目录（真 ~/.butler 从没进过这里 —— 全程只动临时 HOME）。
# 按 pid 文件送一次，再按**这个临时前缀**匹配兜一次底：万一 pid 拿错了，也不许留下没人管的进程。
stop_run() {
  if [ -f "${TMP}/run.pid" ]; then
    kill -INT "$(cat "${TMP}/run.pid")" 2>/dev/null || true
    sleep 1
    kill -9 "$(cat "${TMP}/run.pid")" 2>/dev/null || true
    rm -f "${TMP}/run.pid"
  fi
  pkill -9 -f "${PREFIX}/app/node_modules/@butler/cli/lib/cli.js" 2>/dev/null || true
}
trap 'stop_run; rm -rf "${TMP}"' EXIT

FAKE_HOME="${TMP}/home"
BUTLER="${FAKE_HOME}/.butler"
PREFIX="${BUTLER}/prefix"
REPO="https://github.com/Leowuqunqun/ai-butler/releases"

ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; exit 1; }
step() { printf '\n%s\n' "$*"; }

# 可移植的 sha256 / 权限（macOS 用 shasum，Linux 用 sha256sum）
sha()  { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
         else sha256sum "$1" | awk '{print $1}'; fi; }
perm() { ls -l "$1" | cut -c1-10; }

# 用某个前缀里的 butler 敲一条命令（HOME 隔离在临时房子里）
butler() { env HOME="${FAKE_HOME}" "${PREFIX}/bin/butler" "$@"; }

# `doctor` 会因为"还没登录微信""配置缺行"这类**如实报告**而非零退出 —— 所以不看退出码，
# 只看它说了什么（把它当断言失败就会冤枉它）。
doctor() { butler doctor > "$1" 2>&1 || true; }

mkdir -p "${FAKE_HOME}"

step "① 先装一个老版本（v0.1.0 —— 那时候还没有飞书）"
mkdir -p "${TMP}/old"
curl -fsSL -o "${TMP}/old.tgz" "${REPO}/download/v0.1.0/butler-installer-0.1.0.tar.gz" \
  || bad "下不下来 v0.1.0 的包（没网？）"
tar xzf "${TMP}/old.tgz" -C "${TMP}/old"
HOME="${FAKE_HOME}" sh "${TMP}/old/install.sh" --no-start > "${TMP}/old.log" 2>&1 \
  || { tail -20 "${TMP}/old.log"; bad "装 v0.1.0 失败"; }
[ -x "${PREFIX}/bin/butler" ] || bad "老版本没装上（${PREFIX}/bin/butler 不在）"
# ⚠️ 微信那条通道的包名是 `wechat-agent-bridge`（**不是** `@butler/channel-wechat`）——
#    配置行里写的就是 `wechat-agent-bridge/plugin`。别凭印象猜包名：断言错了会冤枉老版本。
for p in cli wechat-agent-bridge; do
  [ -d "${PREFIX}/app/node_modules/@butler/${p}" ] || [ -d "${PREFIX}/app/node_modules/${p}" ] \
    || { ls "${PREFIX}/app/node_modules/@butler" "${PREFIX}/app/node_modules" 2>/dev/null | head -30; \
         bad "老版本里没有 ${p}，包不对"; }
done
if [ -d "${PREFIX}/app/node_modules/@butler/channel-feishu" ]; then bad "老版本里不该有飞书"; fi
OLD_VER=$(node -p "require('${PREFIX}/app/node_modules/@butler/cli/package.json').version" 2>/dev/null || echo "?")
[ "${OLD_VER}" = "0.1.0" ] || bad "老版本装出来的 cli 版本是 ${OLD_VER}，不是 0.1.0 —— 这个演练的前提不成立"
ok "v0.1.0 装好了（cli 版本 ${OLD_VER}），里面**没有**飞书（符合预期）"

step "② 让这间「房子」像用户那台：老版本自己生成的配置 + 一点"他自己改的""
butler init > "${TMP}/init-old.log" 2>&1 || { tail -20 "${TMP}/init-old.log"; bad "老版本 butler init 失败"; }
[ -f "${BUTLER}/config.json" ] || bad "老版本没写出 config.json"
# 标记一下"这是用户改过的"，升级必须把它原样留着
node -e '
const f = process.argv[1], fs = require("fs");
const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.note = "用户自己改过的东西";
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
' "${BUTLER}/config.json"
mkdir -p "${BUTLER}/state"
printf '%s\n' '{"version":1,"channels":{"wechat":{"token":"irreplaceable"}}}' > "${BUTLER}/state/secrets.json"
chmod 600 "${BUTLER}/state/secrets.json"
CHANNEL_BEFORE=$(node -e 'const c=require(process.argv[1]);console.log(JSON.stringify(c.plugins.find(r=>r.id==="channel")))' "${BUTLER}/config.json")
BEFORE_CFG=$(sha "${BUTLER}/config.json")
BEFORE_SEC=$(sha "${BUTLER}/state/secrets.json")
ok "放好了：老版本生成的 config.json（带 note 标记）+ state/secrets.json（0600）"

step "③ 用**发布出来的**新 install.sh 就地升级（就是用户要敲的那条命令）"
curl -fsSL -o "${TMP}/install.sh" "${REPO}/latest/download/install.sh" || bad "下不下来新 install.sh"
HOME="${FAKE_HOME}" sh "${TMP}/install.sh" --no-start > "${TMP}/new.log" 2>&1 \
  || { tail -20 "${TMP}/new.log"; bad "就地升级失败"; }
ok "升级跑完了（没报错）"

step "④ 该来的来了吗 —— 而且**老的真被换掉了**"
[ -d "${PREFIX}/app/node_modules/@butler/channel-feishu" ] || bad "飞书那个包没装上"
ok "channel-feishu 在了"
[ -f "${PREFIX}/app/node_modules/@butler/channel-feishu/probe/smoke.mjs" ] || bad "探针没跟着来"
ok "探针也在（save.mjs / smoke.mjs / run.sh）"

# ⚠️ 光"新东西来了"不够。安装是 **merge**（`mkdir -p "${APP}"`，不是 wipe），所以要专门问一句：
#    程序**本体**真的换了版本吗？树里还有没有残留的老版本包？
#    （两个发布包按**包名**比过：0.1.0 的 15 个包名在 0.2.0 里全都在 —— 没有"真僵尸"。所以这里
#      要盯的正是"同名包有没有被真的换成新版本"，而不是"多出来了什么"。）
NEW_VER=$(node -p "require('${PREFIX}/app/node_modules/@butler/cli/package.json').version" 2>/dev/null || echo "?")
[ "${NEW_VER}" != "${OLD_VER}" ] || bad "升级后 cli 还是 ${NEW_VER} —— 程序本体没被换掉（merge 安装的经典坑）"
ok "程序本体真换了版本：${OLD_VER} → ${NEW_VER}"
LEFT=$(node -e '
const fs = require("fs"), p = require("path"), d = process.argv[1], old = process.argv[2], bad = [];
for (const n of fs.readdirSync(d)) {
  const f = p.join(d, n, "package.json");
  if (fs.existsSync(f) && JSON.parse(fs.readFileSync(f, "utf8")).version === old) bad.push(n);
}
console.log(bad.join(" "));
' "${PREFIX}/app/node_modules/@butler" "${OLD_VER}")
[ -z "${LEFT}" ] || bad "升级后树里还留着 ${OLD_VER} 的包：${LEFT}"
UNSCOPED=$(node -p "require('${PREFIX}/app/node_modules/wechat-agent-bridge/package.json').version" 2>/dev/null \
        || node -p "require('${PREFIX}/app/node_modules/@butler/wechat-agent-bridge/package.json').version" 2>/dev/null \
        || echo "?")
[ "${UNSCOPED}" != "${OLD_VER}" ] || bad "那个不在 @butler 作用域下的包还是 ${UNSCOPED}，没被换"
ok "树里没有残留的老版本包（不在 @butler 作用域下的那个是 ${UNSCOPED}）"

step "⑤ 他原来的东西动了吗"
[ "$BEFORE_CFG" = "$(sha "${BUTLER}/config.json")" ] || bad "config.json 被动过了"
ok "config.json 一个字节没变"
[ "$BEFORE_SEC" = "$(sha "${BUTLER}/state/secrets.json")" ] || bad "凭据被动过了"
ok "state/secrets.json 一个字节没变"
[ "$(perm "${BUTLER}/state/secrets.json")" = "-rw-------" ] || bad "凭据权限被改了"
ok "凭据还是 0600"

step "⑥ 升级后「butler init」补能力行：补上缺的，别的（含收信那行）一个字不动"
doctor "${TMP}/doctor1.log"
grep -q "channel" "${TMP}/doctor1.log" || { tail -25 "${TMP}/doctor1.log"; bad "doctor 里没有 channel 那行"; }
ok "butler doctor 能跑（它如实报"微信还没登录"这类，退出码非零不算故障）"

butler init > "${TMP}/init-top.log" 2>&1 || { tail -20 "${TMP}/init-top.log"; bad "升级后 butler init 失败"; }
grep -q '"note": "用户自己改过的东西"' "${BUTLER}/config.json" || bad "init 把用户自己加的键弄丢了"
ok "用户自己加的键还在"
[ "$CHANNEL_BEFORE" = "$(node -e 'const c=require(process.argv[1]);console.log(JSON.stringify(c.plugins.find(r=>r.id==="channel")))' "${BUTLER}/config.json")" ] \
  || bad "不带 --im 的 init 把收信那行换掉了（第 23 轮修的就是这个）"
ok "收信那行没被动（不带 --im 时不许换回去）"

step "⑦ 换通道：只换那一行，而且换完飞书那行真能装载"
butler init --im feishu > "${TMP}/init-feishu.log" 2>&1 || { tail -20 "${TMP}/init-feishu.log"; bad "butler init --im feishu 失败"; }
grep -q "channel-feishu" "${BUTLER}/config.json" || bad "init --im feishu 没写进配置"
ok "收信通道换成了飞书"
grep -q '"note": "用户自己改过的东西"' "${BUTLER}/config.json" || bad "换通道时把用户自己加的键弄丢了"
[ "$BEFORE_SEC" = "$(sha "${BUTLER}/state/secrets.json")" ] || bad "换通道动了凭据"
ok "别的（note、凭据）一个字节没动"

doctor "${TMP}/doctor2.log"
grep -q "@butler/channel-feishu" "${TMP}/doctor2.log" || { tail -30 "${TMP}/doctor2.log"; bad "升级后飞书那行装载失败"; }
if grep -q "装不上插件" "${TMP}/doctor2.log"; then tail -30 "${TMP}/doctor2.log"; bad "升级后飞书那行报"装不上插件""; fi
ok "飞书那行在新的安装里**真的装载成功**（doctor 里看得见它）"

# 探针只走 --dry：不用扫码、不碰网络、也不写文件
node "${PREFIX}/app/node_modules/@butler/channel-feishu/probe/smoke.mjs" --dry \
  --home="${BUTLER}" > "${TMP}/dry.log" 2>&1 \
  || { tail -20 "${TMP}/dry.log"; bad "探针跑不起来（这就是用户要敲的那条）"; }
grep -q "dry run" "${TMP}/dry.log" || bad "探针 --dry 没输出该有的东西"
ok "探针 --dry 通了（升级后，用户那条扫码命令真的存在且能跑）"

step "⑧ 第三条命令 butler run：端上来的得是**飞书**的引导页（不扫码、不联网）"
# 此刻配置里已经是飞书那行、凭据里只有微信的 token —— 正是用户 `init --im feishu` 之后、
# 还没扫码之前的样子。通道凭据那道门在模型 key 之前（插件的 config 是构造时读进去的），
# 所以这时 run 的下一件事就是"问你要飞书应用的 app_id"。
# ⚠️ 起进程这一段有两处踩过的坑（都写在文件头的纪律里）：
#    ① 标题里别用反引号（会变成命令替换，真的把 butler run 跑起来）；
#    ② 后台起进程要在**专门的子壳**里取 `$!`，否则拿到的可能是壳自己，SIGINT 到不了里面的 node。
( env HOME="${FAKE_HOME}" "${PREFIX}/bin/butler" run --no-open > "${TMP}/run.log" 2>&1 & echo $! > "${TMP}/run.pid" )
RUN_PID=$(cat "${TMP}/run.pid")
# 它必须**立刻**把日志文件建出来 —— 建不出来说明连启动都失败了，别在这儿干等 20 秒
sleep 1
[ -f "${TMP}/run.log" ] || bad "run 一启动就没了（看上面，或者手动跑一次）"
URL=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  URL=$(grep -o "http://127\.0\.0\.1:[0-9]*/s/[0-9a-f]*/" "${TMP}/run.log" 2>/dev/null | head -1 || true)
  if [ -n "${URL}" ]; then break; fi
  sleep 1
done
if [ -z "${URL}" ]; then stop_run; tail -20 "${TMP}/run.log"; bad "run 没把引导页地址打出来"; fi
ok "引导页起来了（地址里那串随机数不打印）"
grep -q "app_id" "${TMP}/run.log" || { stop_run; bad "引导页问的不是飞书的 app_id —— 那问的是什么？"; }
ok "它问的是飞书应用的 app_id（不是微信那种二维码）"

curl -s --max-time 5 "${URL}" > "${TMP}/page.html" || { stop_run; bad "页面打不开（地址就在上面那个）"; }
for k in app_id smoke.mjs 飞书; do
  grep -q "${k}" "${TMP}/page.html" || { stop_run; bad "页面上没有「${k}」"; }
done
ok "页面上有：app_id、飞书那两样、以及探针那条命令"

stop_run
sleep 1
if ps -p "${RUN_PID}" >/dev/null 2>&1; then
  bad "Ctrl-C 之后它没收工（第 21 轮修过一次，怎么又回来了）"
fi
ok "Ctrl-C 之后它自己收工了（没留一个没人管的监听端口）"

printf '\n✅ 升级演练通过：该来的来了、**老的真被换掉了**、原来的一个字节没变、换通道只换那一行、run 端的是飞书那页。\n'
