#!/bin/sh
# ============================================================================
# AI 管家 —— 引导器
#
#   sh install.sh                装好，然后立刻启动（浏览器会弹出引导页）
#   sh install.sh --dry-run      只说要干什么，一个字节都不动
#   sh install.sh --no-start     装好但不启动
#   sh install.sh --uninstall    卸载（默认保留 ~/.butler 里的数据）
#
# 它做的四件事：
#   1. 找一个够新的 Node（>= 20）。没有就从**官方**下一个固定版本，并校验 SHA256
#   2. 把 AI 管家装进 ~/.butler/prefix（一个私有项目，不碰你系统的 npm 全局目录）
#   3. 告诉你 `butler` 怎么进 PATH（**不擅自改你的 dotfiles**，除非你给 --add-path）
#   4. 启动它（`butler run`），浏览器弹出引导页 —— 扫码、贴 key，就完了
#
# 两条设计纪律：
#   · **不要 root。** 一个管家凭什么叫你 sudo。所以 Node 装在 ~/.butler/runtime 里，
#     包装在 ~/.butler/prefix 里，缓存也塞在 ~/.butler 里（不在你家目录到处拉屎）。
#   · **--dry-run 必须真的什么都不做。** 谁都想先看一眼它要干什么再决定。
# ============================================================================
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)

# 固定 Node 版本，不用 latest：装出来的东西要可复现，SHA256 才有意义
NODE_VERSION="${BUTLER_NODE_VERSION:-v24.14.0}"
NODE_MIN_MAJOR=20
# 以后发布到 npm 用这个包名（还没发布时请用 --source 指一个目录，见下）
PKG_NPM="${BUTLER_NPM_PACKAGE:-@butler/cli}"

DRY=0
START=1
UNINSTALL=0
ADD_PATH=0
HOME_DIR="${HOME}"
PREFIX=""
SOURCE=""

say() { printf '%s\n' "$*"; }
die() { say "❌ $*" >&2; exit 1; }
# dry-run 时把命令念出来，真跑时照跑
run() {
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] $*"
  else
    "$@"
  fi
}

usage() {
  cat <<'EOF'
用法：sh install.sh [选项]

  --dry-run          只说要干什么，一个字节都不动
  --no-start         装好但不启动
  --uninstall        卸载（保留 ~/.butler 里的配置/登录态/收件箱，并告诉你它在哪）
  --add-path         帮你往 shell 启动文件里加一行 PATH（不加就只打印提示）
  --home <目录>      换个家目录（默认 ${HOME}；测试用）
  --prefix <目录>    装到哪（默认 <家目录>/.butler/prefix）
  --source <路径|URL|包名>
                     从哪装。给**目录**=装里面所有 .tgz（分发包就是这么装的）；
                     也可以给 npm 包名或 git 地址。默认：有 ./tarballs 就用它，
                     否则用 @butler/cli
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --no-start) START=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --add-path) ADD_PATH=1 ;;
    --home) HOME_DIR="${2:?--home 后面要跟一个目录}"; shift ;;
    --home=*) HOME_DIR="${1#--home=}" ;;
    --prefix) PREFIX="${2:?--prefix 后面要跟一个目录}"; shift ;;
    --prefix=*) PREFIX="${1#--prefix=}" ;;
    --source) SOURCE="${2:?--source 后面要跟一个路径或包名}"; shift ;;
    --source=*) SOURCE="${1#--source=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$1（--help 看用法）" ;;
  esac
  shift
done

[ -n "${HOME_DIR}" ] || die "拿不到家目录（\$HOME 是空的）—— 用 --home 指定一个"
BUTLER_DIR="${HOME_DIR}/.butler"
PREFIX="${PREFIX:-${BUTLER_DIR}/prefix}"
RUNTIME="${BUTLER_DIR}/runtime"
LOG_DIR="${BUTLER_DIR}/logs"

# ─────────────────────────── 卸载 ───────────────────────────

if [ "$UNINSTALL" = 1 ]; then
  say "卸载 AI 管家"
  # 先摘自启动：顺序反了的话 butler 已经被删，自启动就摘不掉了
  if [ -x "${PREFIX}/bin/butler" ]; then
    say "① 先摘掉自启动（如果装过）"
    if [ "$DRY" = 1 ]; then
      say "  [dry-run] ${PREFIX}/bin/butler autostart off"
    else
      HOME="${HOME_DIR}" "${PREFIX}/bin/butler" autostart off || say "  （摘自启动时出了点问题，往下继续）"
    fi
  else
    say "① 没有装好的 butler，跳过自启动那一步"
    say "  （如果以前装过，手动删掉这些：~/Library/LaunchAgents/com.butler.hub.plist"
    say "    或 ~/.config/systemd/user/butler.service）"
  fi
  say "② 删掉程序目录：${PREFIX}"
  run rm -rf "${PREFIX}"
  say "③ **保留**你的数据：${BUTLER_DIR}"
  say "  配置、微信登录态、收件箱都在这里。想彻底清干净：rm -rf ${BUTLER_DIR}"
  say "✅ 卸载完成。"
  exit 0
fi

# ─────────────────────────── 1. Node ───────────────────────────

node_major() {
  "$1" -v 2>/dev/null | sed 's/^v//; s/\..*//' || true
}

have_node() {
  [ -n "${1:-}" ] && [ -x "${1:-}" ] && [ "$(node_major "$1")" -ge "${NODE_MIN_MAJOR}" ] 2>/dev/null
}

NODE_BIN=""
# 优先用机器上现成的：用户自己的 nvm/homebrew 那份最新、最不会有意外
if command -v node >/dev/null 2>&1 && have_node "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  say "① Node：用你机器上的 ${NODE_BIN}（$("$NODE_BIN" -v)）"
elif have_node "${RUNTIME}/bin/node"; then
  NODE_BIN="${RUNTIME}/bin/node"
  say "① Node：用上次下好的 ${NODE_BIN}（$("$NODE_BIN" -v)）"
else
  OS=$(uname -s | tr 'A-Z' 'a-z')
  ARCH=$(uname -m)
  case "${ARCH}" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "不认识的 CPU：${ARCH}。去 https://nodejs.org/en/download 手动装个 Node ${NODE_MIN_MAJOR}+ 再跑这个脚本" ;;
  esac
  case "${OS}" in
    darwin|linux) ;;
    *) die "这个引导器现在只认 macOS 和 Linux（你是 ${OS}）。Windows 请手动装 Node 后跑：npm i -g ${PKG_NPM}" ;;
  esac

  FILE="node-${NODE_VERSION}-${OS}-${ARCH}.tar.gz"
  BASE="https://nodejs.org/dist/${NODE_VERSION}"
  say "① Node：机器上没有够新的 Node（要 >= ${NODE_MIN_MAJOR}），从官方下 ${NODE_VERSION}"

  if command -v curl >/dev/null 2>&1; then
    FETCH="curl -fsSL -o"
  elif command -v wget >/dev/null 2>&1; then
    FETCH="wget -q -O"
  else
    die "既没有 curl 也没有 wget，下不了 Node。手动装一个 Node ${NODE_MIN_MAJOR}+ 再跑这个脚本"
  fi

  TMP="${BUTLER_DIR}/tmp-install"
  run mkdir -p "${TMP}" "${RUNTIME}" "${LOG_DIR}"
  say "   下：${BASE}/${FILE}"
  run sh -c "${FETCH} '${TMP}/${FILE}' '${BASE}/${FILE}'"
  run sh -c "${FETCH} '${TMP}/SHASUMS256.txt' '${BASE}/SHASUMS256.txt'"

  if [ "$DRY" = 0 ]; then
    WANT=$(grep " ${FILE}\$" "${TMP}/SHASUMS256.txt" | awk '{print $1}')
    [ -n "${WANT}" ] || die "官方校验表里没有 ${FILE} —— 不敢装"
    if command -v sha256sum >/dev/null 2>&1; then
      GOT=$(sha256sum "${TMP}/${FILE}" | awk '{print $1}')
    else
      GOT=$(shasum -a 256 "${TMP}/${FILE}" | awk '{print $1}')
    fi
    [ "${WANT}" = "${GOT}" ] || die "校验不过！官方说 ${WANT}，下下来的是 ${GOT} —— 一个字节都没装"
    say "   校验通过 ✅（SHA256 和官方一致）"
  fi

  say "   解开到：${RUNTIME}"
  run tar -xzf "${TMP}/${FILE}" -C "${RUNTIME}" --strip-components=1
  run rm -rf "${TMP}"
  NODE_BIN="${RUNTIME}/bin/node"
fi

# ─────────────────────────── 2. 装 CLI ───────────────────────────

NODE_DIR=$(dirname "${NODE_BIN}")
NPM_CLI="${NODE_DIR}/../lib/node_modules/npm/bin/npm-cli.js"
[ -f "${NPM_CLI}" ] || NPM_CLI="${NODE_DIR}/lib/node_modules/npm/bin/npm-cli.js"
if [ ! -f "${NPM_CLI}" ] && [ "$DRY" = 0 ]; then
  die "这个 Node 里没有 npm（${NPM_CLI} 不在）—— 换一个完整的官方 Node 再跑"
fi

# 装到哪：优先 --source；分发包里就是 ./tarballs；最后才走 npm 包名
SPECS=""
FROM_DIR=""
if [ -n "${SOURCE}" ]; then
  if [ -d "${SOURCE}" ]; then FROM_DIR="${SOURCE}"; else SPECS="${SOURCE}"; fi
elif [ -d "${HERE}/tarballs" ]; then
  FROM_DIR="${HERE}/tarballs"
fi

# ⚠️ 装成**一棵树**（一个私有项目里的依赖），不是 11 个全局包。
# 当初按 `npm i -g *.tgz` 装过：npm 会把每个包当独立的全局包，各自的依赖
# 嵌套在各自的目录里 —— 于是 @butler/agent-dsh 找不到隔壁的
# @deepseek-ai/schemastery，三个插件全装不上（干净环境验收当场抓到的）。
# 装成一棵树和"发布后 npm i -g @butler/cli"的形状是一样的。
APP="${PREFIX}/app"
run mkdir -p "${APP}"
# 先给它一个自己的项目根：不然 npm 会往上找到别的 package.json，装到不该装的地方去
if [ "$DRY" = 1 ]; then
  say "  [dry-run] 写 ${APP}/package.json（私有项目根）"
else
  printf '%s\n' '{ "name": "butler-app", "private": true }' > "${APP}/package.json"
fi

if [ -n "${FROM_DIR}" ]; then
  if ! ls "${FROM_DIR}"/*.tgz >/dev/null 2>&1; then
    die "${FROM_DIR} 里没有 .tgz —— 分发包是不是没解开完整？"
  fi
  say "② 装 AI 管家：从 ${FROM_DIR}（$(ls "${FROM_DIR}"/*.tgz | wc -l | tr -d ' ') 个包，离线可装）"
  run env HOME="${HOME_DIR}" npm_config_cache="${BUTLER_DIR}/npm-cache" \
    "${NODE_BIN}" "${NPM_CLI}" install --prefix "${APP}" --no-audit --no-fund "${FROM_DIR}"/*.tgz
else
  TARGET="${SPECS:-${PKG_NPM}}"
  say "② 装 AI 管家：${TARGET}（从 npm 上取）"
  run env HOME="${HOME_DIR}" npm_config_cache="${BUTLER_DIR}/npm-cache" \
    "${NODE_BIN}" "${NPM_CLI}" install --prefix "${APP}" --no-audit --no-fund "${TARGET}"
fi

# 把命令摆到 ${PREFIX}/bin —— 用户只需要知道这一个路径
#
# ⚠️ **不能 symlink 到 node_modules/.bin/butler**：那个文件的 shebang 是
#   `#!/usr/bin/env node`，于是"到底跑哪个 node"由**用户的 PATH** 决定。
#   机器上根本没装 Node、或者装的是 Node 16（我们要求 >= 20）时，刚装好的
#   butler 一敲就崩 —— 而我们在 ① 里明明已经挑好、甚至下载并校验过一个
#   能用的 Node 了。干净环境验收里"没装 Node"是最常见的一种。
#   所以这里写一个**壳脚本**，把那个 Node 的绝对路径钉死在里面：
#   装完之后 butler 用哪个 Node，跟你 PATH 里有什么无关。
BUTLER_BIN="${PREFIX}/bin/butler"
CLI_JS="${APP}/node_modules/@butler/cli/lib/cli.js"
run mkdir -p "${PREFIX}/bin"
if [ "$DRY" = 1 ]; then
  say "  [dry-run] 写 ${BUTLER_BIN}（壳脚本：把 Node 钉成 ${NODE_BIN}，也把它自己的 PATH 指到 ${PREFIX}/bin）"
else
  [ -f "${CLI_JS}" ] || die "装完了却没找到 ${CLI_JS} —— 上面 npm 的输出里应该有原因"
  cat > "${BUTLER_BIN}" <<WRAP
#!/bin/sh
# AI 管家（butler）—— 这个文件由 install.sh 生成。
#
# ① 这里把 Node 的路径写死是有意的：它是安装时挑好（必要时下载并校验过）的
#    那一个，所以本机没装 Node、或者装了个太老的，都照样能跑。
# ② 把 ${PREFIX}/bin 放进**管家自己的** PATH —— 只改这一个进程的环境，
#    仍然不动用户的 dotfiles。因为管家干活是在**子 shell** 里：
#    "在微信里跟它说一句、让它自己设开机自启"走的就是那条路，那里得有 butler。
#    内核自检里有一项量的就是这个（"管家自己找得到 butler 吗"）。
#    ⚠️ 这个 heredoc **没有引号**（上面的变量要在这里展开），所以这一行里
#    每个 \$ 都要转义 —— 漏一个，\$0 在安装的时候就被求值成 install.sh 了。
BUTLER_BIN_DIR=\$(cd "\$(dirname "\$0")" && pwd)
PATH="\$BUTLER_BIN_DIR\${PATH:+:\$PATH}"
export PATH
exec "${NODE_BIN}" "${CLI_JS}" "\$@"
WRAP
  chmod +x "${BUTLER_BIN}"
fi
if [ "$DRY" = 0 ] && [ ! -x "${BUTLER_BIN}" ]; then
  die "装完了但 ${BUTLER_BIN} 不在 —— 上面 npm 的输出里应该有原因"
fi
run mkdir -p "${LOG_DIR}"

# ─────────────────────────── 3. PATH 提示 ───────────────────────────

case ":${PATH}:" in
  *":${PREFIX}/bin:"*) say "③ PATH：${PREFIX}/bin 已经在了，直接敲 butler 就行" ;;
  *)
    if [ "$ADD_PATH" = 1 ]; then
      case "${SHELL:-}" in
        *zsh) RC="${HOME_DIR}/.zshrc" ;;
        *bash) RC="${HOME_DIR}/.bashrc" ;;
        *) RC="${HOME_DIR}/.profile" ;;
      esac
      if [ -f "${RC}" ] && grep -q "AI 管家（butler）PATH" "${RC}" 2>/dev/null; then
        say "③ PATH：${RC} 里已经加过了，不重复加"
      else
        say "③ PATH：往 ${RC} 追加一行"
        if [ "$DRY" = 1 ]; then
          say "  [dry-run] export PATH=\"${PREFIX}/bin:\$PATH\""
        else
          printf '\n# AI 管家（butler）PATH\nexport PATH="%s/bin:$PATH"\n' "${PREFIX}" >> "${RC}"
          say "   加好了（新开一个终端，或 source ${RC} 生效）"
        fi
      fi
    else
      say "③ PATH：想让以后直接敲 butler，把这一行加到 ~/.zshrc（或 ~/.bashrc）："
      say "     export PATH=\"${PREFIX}/bin:\$PATH\""
      say "   或者重跑这个脚本加 --add-path，我替你加。不加也不影响：管家自己知道它在哪。"
    fi
    ;;
esac

# ─────────────────────────── 4. 启动 ───────────────────────────

say ""
say "装好了：${BUTLER_BIN}"
say "它的数据都在：${BUTLER_DIR}（配置、微信登录态、收件箱）"

if [ "$START" = 1 ]; then
  say ""
  say "▶ 现在启动管家。浏览器会自动弹出引导页 —— 扫码、贴模型 key，就完了。"
  say "  （这个窗口要留着：它就是管家本人。想让它开机自己起来：butler autostart on）"
  say ""
  if [ "$DRY" = 1 ]; then
    say "  [dry-run] HOME=${HOME_DIR} ${BUTLER_BIN} run"
  else
    HOME="${HOME_DIR}" "${BUTLER_BIN}" run
  fi
else
  say ""
  say "▶ 启动：${BUTLER_BIN} run"
  say "  想让它开机自己起来（关掉终端也不怕）：${BUTLER_BIN} autostart on"
fi
