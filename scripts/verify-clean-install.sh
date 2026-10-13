#!/bin/sh
# ============================================================================
# 干净环境端到端：把"小白第一次用"整条路走一遍。
#
#   sh scripts/verify-clean-install.sh
#
# 纪律（这三条是这个脚本存在的理由）：
#   · 只在**临时家目录**和**临时前缀**里动手 —— 真 ~/.butler 一个字节都不碰
#   · 不碰真的自启动：只验 `autostart --dry-run`（`on` 会在本机真装登录项）
#   · 不登微信、不贴 key（要真人扫码，故意不测）—— 所以也不跑 `butler run`
#
# 走的是**真正发出去的那个包**：先打 bundle，再解开到一个临时目录，用解出来的
# install.sh 装。这样"分发包里少了个文件""workspace: 没被替换"这类问题当场就暴露。
# ============================================================================
set -eu

# `--no-node`：故意把 node 从 PATH 里拿走，走"本机根本没装 Node"那条路
# （下载官方 tarball + 校验 SHA256 + 壳脚本把那个 Node 钉住）。
# 这是真机上最常见、而我们平时**根本测不到**的一种机器 —— 也是"小白第一次装"
# 最容易翻车的一步（下载地址、校验、解压、npm 用哪个 Node 跑）。
NO_NODE=0
for arg in "$@"; do
  case "${arg}" in
    --no-node) NO_NODE=1 ;;
    *) echo "不认识的参数：${arg}（只有 --no-node）" >&2; exit 2 ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
HOME_DIR="${TMP}/home"
PREFIX="${TMP}/prefix"
DL="${TMP}/download"
mkdir -p "${HOME_DIR}" "${DL}"

# 收尾：只删我们自己造的临时目录（路径是我们刚建的，不是算出来的）
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT INT TERM

pass=0
step() { printf '\n=== %s ===\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; exit 1; }

# ─────────────────────── 0. 打并解开分发包 ───────────────────────

step "0. 打分发包（和发给小白的是同一个东西）"
sh "${ROOT}/scripts/make-installer-bundle.sh" > "${TMP}/bundle.log" 2>&1 \
  || { cat "${TMP}/bundle.log"; bad "打 bundle 失败"; }
BUNDLE=$(ls "${ROOT}"/dist/butler-installer-*.tar.gz | head -1)
tar -xzf "${BUNDLE}" -C "${DL}"
ok "解开 $(basename "${BUNDLE}") → $(ls "${DL}" | tr '\n' ' ')"
[ -f "${DL}/install.sh" ] || bad "分发包里没有 install.sh"
[ "$(ls "${DL}"/tarballs/*.tgz | wc -l | tr -d ' ')" -ge 11 ] || bad "tarball 不够 11 个"
[ -f "${DL}/GETTING-STARTED.md" ] || bad "分发包里没有上手清单 GETTING-STARTED.md"
ok "install.sh / install.command / README.txt / GETTING-STARTED.md / tarballs 都在"

# ⚠️ 说明里不许写死"打包时所在的那个目录" —— 收件人解压到别处，照抄就是一条不存在的路径。
#    （真踩到过：README.txt 里印着打包机的绝对路径。bundle 脚本里另有一道同样的门。）
if grep -q "$(cd "${ROOT}" && pwd)" "${DL}/README.txt"; then
  bad "README.txt 里写死了打包机的路径 ✗（收件人那儿没有这个目录）"
fi

#   ★ 出事了那张纸，给的是不是**小白做得到**的动作？
#   真踩到过：这一栏原先只印一条带全路径的终端命令，而拿到这张纸的人
#   恰恰是"不懂技术、只会在访达里双击"的那位 —— 等于没给绳子。
grep -q "再双击一次 install.command" "${DL}/README.txt" || bad "README.txt 的出事了那栏，小白照着做不了"
ok "出事了那栏给的是小白做得到的动作（再双击一次）"

#   ★ 同一件事的第二面：开机自启。原先那一栏只印了一条全路径命令，
#   而这张纸的读者不知道什么是终端 —— 产品里明明有一条"在微信里跟它说"的路。
grep -q "在微信里直接跟它说" "${DL}/README.txt" || bad "开机自启那条，小白还是只能去开终端"
ok "开机自启也给了不用终端的路（在微信里跟它说）"
ok "README.txt 教的是"把文件夹拖进终端"，不是一条只在本机存在的路径"

# ─────────────────────── 1. dry-run 必须真的什么都不做 ───────────────────────

step "1. 先 --dry-run：只说要干什么"
sh "${DL}/install.sh" --home "${HOME_DIR}" --prefix "${PREFIX}" --dry-run > "${TMP}/dry.log" 2>&1 \
  || { cat "${TMP}/dry.log"; bad "dry-run 自己失败了"; }
grep -q "dry-run" "${TMP}/dry.log" || bad "dry-run 的输出里没有计划"
grep -q "butler run" "${TMP}/dry.log" || bad "dry-run 里没说最后会启动"
[ ! -e "${PREFIX}" ] || bad "dry-run 竟然建了目录 ✗"
[ -z "$(ls -A "${HOME_DIR}")" ] || bad "dry-run 竟然往家目录写了东西 ✗"
ok "计划念出来了，临时家目录还是空的"

# ─────────────────────── 2. 真装（离线 tarball）───────────────────────

if [ "${NO_NODE}" = 1 ]; then
  step "2. 真装：PATH 里没有 node（走"下载 + 校验 SHA256"那条路）"
  printf '  ★ 这台机器没装 Node：装的过程要联网下载（约 50MB）并校验官方 SHA256\n'
  INSTALL="env PATH=/usr/bin:/bin SHELL=/bin/bash"
else
  step "2. 真装：从 tarball 装进私有前缀"
  INSTALL="env SHELL=/bin/bash"
fi
# 故意不引号：$INSTALL 是一串要拆开的命令前缀
${INSTALL} sh "${DL}/install.sh" --home "${HOME_DIR}" --prefix "${PREFIX}" \
  --no-start --add-path > "${TMP}/install.log" 2>&1 \
  || { tail -20 "${TMP}/install.log"; bad "安装失败"; }
[ -x "${PREFIX}/bin/butler" ] || { tail -20 "${TMP}/install.log"; bad "装完没有 butler"; }
ok "装好了：${PREFIX}/bin/butler"

# 装了啥也不许漏到家目录外面：这里只看"该有的在、不该有的没有"
if [ "${NO_NODE}" = 1 ]; then
  [ -x "${HOME_DIR}/.butler/runtime/bin/node" ] || bad "没下到自己的 Node（runtime 里没有 node）"
  grep -q "${HOME_DIR}/.butler/runtime" "${PREFIX}/bin/butler" \
    || bad "壳脚本没有钉住下载来的那个 Node（那 PATH 里没 node 就还是跑不起来）"
  ok "本机没 Node 也装上了：自己下了一份、校验了 SHA256，壳脚本钉住的就是它"
fi
[ -d "${HOME_DIR}/.butler/logs" ] || bad "logs 目录没建"
[ -d "${HOME_DIR}/.butler/npm-cache" ] || bad "npm 缓存没塞进 ~/.butler（会拉屎到别处）"
grep -q "AI 管家（butler）PATH" "${HOME_DIR}/.bashrc" || bad "--add-path 没写进 .bashrc"
ok "数据都在 ~/.butler 里，PATH 也加好了（幂等：可重跑）"

# 再跑一次 --add-path：不许重复追加
${INSTALL} sh "${DL}/install.sh" --home "${HOME_DIR}" --prefix "${PREFIX}" \
  --no-start --add-path > "${TMP}/install2.log" 2>&1 || bad "第二次安装失败"
[ "$(grep -c 'AI 管家（butler）PATH' "${HOME_DIR}/.bashrc")" = 1 ] || bad "PATH 那行被重复加了"
ok "重复安装不重复写 PATH（而且没把已装的搞坏）"

# ─────────────────────── 3. 装出来的命令真能用 ───────────────────────

BUTLER="env HOME=${HOME_DIR} ${PREFIX}/bin/butler"

step "3. 装出来的 butler 真能用（全部离线，不登微信）"
${BUTLER} --help > "${TMP}/help.log" 2>&1 || bad "butler --help 失败"
grep -q "autostart" "${TMP}/help.log" || bad "--help 里没有 autostart"
ok "--help 正常，且看得到 autostart"

# ★ 壳脚本必须钉住 Node：把 PATH 弄成"根本没有 node"，装出来的 butler 也得能跑。
#   这条专门盯着一个真 bug：symlink 到 `#!/usr/bin/env node` 的话，
#   干净机器上"没装 Node"（最常见的一种）会直接起不来。
if env -i PATH=/nonexistent "${PREFIX}/bin/butler" --help > "${TMP}/bare.log" 2>&1; then
  grep -q "butler" "${TMP}/bare.log" || bad "没 node 的 PATH 下输出不对"
  ok "PATH 里没有 node 也照样能跑（安装时挑的那个 Node 被钉住了）"
else
  bad "PATH 里没有 node 就起不来 —— shebang 的锅，见 install.sh 里那段注释"
fi

# ★ 从来没配置过时，doctor 要说"还没配置过、跑 butler init"。
#   文件**不在**和文件**坏了**是两回事 —— 以前这两条路给的是同一句话（"先把这份配置文件修好"），
#   于是一个刚装完、什么都还没配的人，被告知去修一份**不存在**的文件。
${BUTLER} doctor > "${TMP}/doctor-fresh.log" 2>&1 || true   # 没配好就是非零，正常
grep -q "还没有配置过" "${TMP}/doctor-fresh.log" || { cat "${TMP}/doctor-fresh.log"; bad "没配置过时 doctor 没说清楚"; }
grep -q "butler init" "${TMP}/doctor-fresh.log" || bad "没配置过时 doctor 没给出能抄的那一行"
if grep -q "修好" "${TMP}/doctor-fresh.log"; then
  bad "没配置过却让人去修那份不存在的文件 ✗"
fi
ok "还没配置过：doctor 给的是 butler init，不是"去把文件修好""

${BUTLER} init > "${TMP}/init.log" 2>&1 || { tail -10 "${TMP}/init.log"; bad "butler init 失败"; }
[ -f "${HOME_DIR}/.butler/config.json" ] || bad "init 没写 config.json"
ok "butler init 写好了配置：$(cat "${HOME_DIR}/.butler/config.json" | tr -d '\n' | cut -c1-60)…"

${BUTLER} doctor > "${TMP}/doctor.log" 2>&1 || true   # doctor 允许报"还没 key"这类问题
grep -qE "key|模型" "${TMP}/doctor.log" || bad "doctor 没提模型 key"
ok "butler doctor 能跑，并且如实说了模型 key 的状态"

# ★ 管家自己找得到 butler 吗 —— 判据在**管家进程内部**（量的是它自己的 PATH），
#   所以只能在这儿看：壳脚本把 <prefix>/bin 放进那个进程的 PATH，doctor 问内核的
#   check()（微信里的「自检」问的是同一条）。这一项过了，"在微信里跟它说一句、
#   让它自己设开机自启"才从"也许行"变成"行" —— 而那张纸上给的就是这条路（不让他开终端）。
grep -q "管家自己找得到 butler" "${TMP}/doctor.log" \
  || { cat "${TMP}/doctor.log"; bad "doctor 里没有'管家自己找得到 butler 吗'这一项（内核那条自检没接上）"; }
grep -q "✓  管家自己找得到 butler" "${TMP}/doctor.log" \
  || { cat "${TMP}/doctor.log"; bad "管家自己的 PATH 里没有 butler —— 壳脚本没把 <prefix>/bin 放进去"; }
ok "管家自己找得到 butler（判据跑在管家进程内部，doctor 里看得见）"

# ★ 装完之后，doctor 印给你的那条探针命令，指的是**这个安装里**的那份吗？
#
#   `probe-path.ts` 按**包自己的位置**算路径（`lib/probe-path.js` → `../probe/smoke.mjs`），
#   所以"算出来的那条路"和"用户手里真有的东西"是不是同一个，只有**真装一遍**才知道 ——
#   源码树里永远是对的，而源码树恰恰是用户没有的那份。
#
#   离线那半已经有用例守着（`channel-feishu/test/tarball.mjs`：npm pack → 解开 → --dry，
#   注释里还记着 `files: ["lib"]` 曾经把探针漏在包外，而 11 处文字都在承诺它）；
#   这一项补的是另一半：**真装进 prefix、真 init --im feishu、doctor 真印出来**。
${BUTLER} init --im feishu > "${TMP}/init-feishu.log" 2>&1 || { tail -10 "${TMP}/init-feishu.log"; bad "init --im feishu 失败"; }
${BUTLER} doctor > "${TMP}/doctor-feishu.log" 2>&1 || true   # 还没填凭据/key，非零是正常的
PROBE_CMD=$(grep -o 'node [^`]*probe/smoke\.mjs[^`]*' "${TMP}/doctor-feishu.log" | head -1 || true)
[ -n "${PROBE_CMD}" ] || { cat "${TMP}/doctor-feishu.log"; bad "doctor 没给出探针那条命令（用户就只剩「去开放平台建应用」一条路了）"; }
PROBE_FILE=$(printf '%s' "${PROBE_CMD}" | sed -E 's/^node (.*probe\/smoke\.mjs).*$/\1/')
# ⚠️ 比"在不在这个前缀里"之前，两边都要先取**真实路径**：macOS 上 `mktemp -d` 给的是
#   `/var/…`，而包自己算出来的是 `/private/var/…`（`import.meta.url`）—— 文本上不相等，
#   其实是同一个地方。第一次写这一条时就是这么误报的：探针明明就在那儿，断言却说"不是
#   这个安装里那份"。这个坑 `channel-feishu/test/tarball.mjs` 的注释里写着（"两边都取
#   真实路径再比"），还是踩了一次 —— 所以这里也把话留在现场。
PREFIX_REAL=$(cd "${PREFIX}" && pwd -P)
PROBE_DIR_REAL=$(cd "$(dirname "${PROBE_FILE}")" 2>/dev/null && pwd -P || printf '%s' '')
case "${PROBE_DIR_REAL}" in
  "${PREFIX_REAL}"/*) ;;
  *) bad "探针命令指的不是这个安装里那份（${PROBE_FILE}）—— 用户照抄只会 No such file" ;;
esac
[ -f "${PROBE_FILE}" ] || bad "探针命令指的文件不在（${PROBE_FILE}）"
printf '%s' "${PROBE_CMD}" | grep -q -- '--save' || bad "探针命令没带 --save（不带只会连一下，不会把凭据存下来）"
ok "doctor 给的探针命令指向这个安装里那份，而且真的在"

# 真跑一次 `--dry`：不联网、不写盘，但会把依赖（官方 SDK）真加载一遍 ——
# 装出来的树里少依赖、或者探针被写成了只能在源码树里跑，都在这里炸。
if command -v node > /dev/null 2>&1; then NODE_BIN=$(command -v node); else NODE_BIN="${HOME_DIR}/.butler/runtime/bin/node"; fi
[ -x "${NODE_BIN}" ] || bad "找不到 node 来跑探针（PATH 里没有，管家自己的 runtime 里也没有）"
env HOME="${HOME_DIR}" "${NODE_BIN}" "${PROBE_FILE}" --dry > "${TMP}/probe-dry.log" 2>&1 \
  || { cat "${TMP}/probe-dry.log"; bad "装出来的探针 --dry 跑不起来"; }
grep -q "dry run" "${TMP}/probe-dry.log" || bad "探针 --dry 的输出不对（不是探针自己那段话）"
grep -q "通了就证明五件事" "${TMP}/probe-dry.log" || bad "探针 --dry 没说清「连上之后能证明什么」"
ok "装出来的探针真能跑（--dry：不联网不写盘，但依赖真的加载了）"

# ─────────────────────── 4. 自启动：只 dry-run ───────────────────────

step "4. 自启动只 dry-run（真的 on 会在本机装登录项，测试里不干）"
${BUTLER} autostart --dry-run > "${TMP}/autostart.log" 2>&1 || { cat "${TMP}/autostart.log"; bad "autostart --dry-run 失败"; }
grep -q "no-open" "${TMP}/autostart.log" || bad "自启动的命令里没有 --no-open（登录会弹浏览器）"
[ ! -e "${HOME_DIR}/Library/LaunchAgents/com.butler.hub.plist" ] || bad "dry-run 竟然写了 plist ✗"
[ ! -e "${HOME_DIR}/.config/systemd/user/butler.service" ] || bad "dry-run 竟然写了 service ✗"
${BUTLER} autostart > "${TMP}/status.log" 2>&1 || bad "autostart 状态查询失败"
grep -q "没装" "${TMP}/status.log" || bad "没装却不报没装"
ok "dry-run 只说不做；状态查询说"没装""

# ───────────────────────── ★ 引导页：真的 serve 得出来吗 ─────────────────────────
#
# 小白一路上最关键的那个面 —— 贴模型 key、扫码，都在这个页面上完成。
# 在此之前验收**从没访问过它**：它只在单元测试里跑过，而"干净装完到底起不起来"
# 恰恰是另一回事（第一版验收就是这么抓到发布物级 bug 的）。
#
# 起法就跟自启动用的一样：`butler run --no-open`（起页面、不弹浏览器）。
PAGE_LOG="${TMP}/page.log"
env HOME="${HOME_DIR}" "${PREFIX}/bin/butler" run --no-open > "${PAGE_LOG}" 2>&1 &
PAGE_PID=$!
PAGE_URL=""
for _ in $(seq 1 40); do
  PAGE_URL=$(grep -o 'http://127\.0\.0\.1:[0-9][^ ]*' "${PAGE_LOG}" 2>/dev/null | head -1 || true)
  [ -n "${PAGE_URL}" ] && break
  kill -0 "${PAGE_PID}" 2>/dev/null || break
  sleep 0.5
done
if [ -z "${PAGE_URL}" ]; then
  echo "--- butler run 的输出 ---"; cat "${PAGE_LOG}" || true
  kill "${PAGE_PID}" 2>/dev/null || true
  bad "干净装完，引导页没起来（小白到这一步就卡住了）"
fi
echo "${PAGE_URL}" | grep -q '^http://127\.0\.0\.1:' || bad "引导页不在 127.0.0.1 上（${PAGE_URL}）"
ok "引导页起来了，而且只报 127.0.0.1（外网连不上）"

if command -v curl > /dev/null 2>&1; then FETCH="curl -fsSL --max-time 5"; else FETCH="wget -qO- -T 5"; fi
PAGE_HTML=$(${FETCH} "${PAGE_URL}" 2> /dev/null || true)
kill "${PAGE_PID}" 2>/dev/null || true
wait "${PAGE_PID}" 2>/dev/null || true
[ -n "${PAGE_HTML}" ] || bad "引导页回了个空（${PAGE_URL}）"
case "${PAGE_HTML}" in *"<form"* | *"<input"*) ;; *) bad "引导页不像个能填的页面（没有 form/input）" ;; esac
ok "引导页真能打开，而且是个能填的页面（贴 key / 扫码都在这儿）"

# ─────────────────────── 5. 卸载保留数据 ───────────────────────

step "5. 卸载：程序删掉，配置/登录态留着"
sh "${DL}/install.sh" --home "${HOME_DIR}" --prefix "${PREFIX}" --uninstall > "${TMP}/uninstall.log" 2>&1 \
  || { tail -10 "${TMP}/uninstall.log"; bad "卸载失败"; }
[ ! -e "${PREFIX}" ] || bad "卸载了但前缀还在"
[ -f "${HOME_DIR}/.butler/config.json" ] || bad "卸载把用户配置一起删了 ✗（应该留着）"
ok "程序没了，${HOME_DIR}/.butler 还在（卸载脚本里明说了它在哪）"

printf '\n═══════════════════════════════════════\n'

printf '✅ 干净环境端到端通过：%d 项检查\n' "${pass}"
printf '   （没测的：真扫码登录微信、真贴模型 key、真装自启动 —— 都要真人，故意不干）\n'
printf '═══════════════════════════════════════\n'
