#!/bin/sh
# ============================================================================
# 升级演练：**已经装着老版本的机器**上，重跑一次安装命令会怎样。
#
#   sh scripts/verify-upgrade.sh
#
# 为什么要它：`verify-clean-install.sh` 走的是"干净机器第一次装"。可用户真正的处境常常是
# **住着的房子** —— 里面已经有配置、有凭据、有收件箱。升级要同时证明三件事：
#
#   · 新版该来的东西来了（这里：飞书那个包 + 它的探针）
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
#
# 走的是**发布出来的真包**：v0.1.0（旧）→ latest（新）。中间那步就是用户要敲的
# `curl … | sh` —— 所以这个脚本本身也是对"那条命令能不能用"的验收。
# ============================================================================
set -eu

TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

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
ok "v0.1.0 装好了，里面**没有**飞书（符合预期）"

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

step "④ 该来的来了吗"
[ -d "${PREFIX}/app/node_modules/@butler/channel-feishu" ] || bad "飞书那个包没装上"
ok "channel-feishu 在了"
[ -f "${PREFIX}/app/node_modules/@butler/channel-feishu/probe/smoke.mjs" ] || bad "探针没跟着来"
ok "探针也在（save.mjs / smoke.mjs / run.sh）"

step "⑤ 他原来的东西动了吗"
[ "$BEFORE_CFG" = "$(sha "${BUTLER}/config.json")" ] || bad "config.json 被动过了"
ok "config.json 一个字节没变"
[ "$BEFORE_SEC" = "$(sha "${BUTLER}/state/secrets.json")" ] || bad "凭据被动过了"
ok "state/secrets.json 一个字节没变"
[ "$(perm "${BUTLER}/state/secrets.json")" = "-rw-------" ] || bad "凭据权限被改了"
ok "凭据还是 0600"

step "⑥ 升级后 `butler init` 补能力行：补上缺的，别的（含收信那行）一个字不动"
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

printf '\n✅ 升级演练通过：该来的来了，原来的一个字节没变，换通道只换那一行。\n'
