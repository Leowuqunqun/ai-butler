#!/bin/sh
# ============================================================================
# 发一个**和当前代码一致**的发布版本。
#
#   sh scripts/release.sh v0.2.1 --dry-run    # 只说要干什么，一个字节都不发
#   sh scripts/release.sh v0.2.1              # 真发（要 gh 已登录）
#
# 可选：
#   --title "v0.2.1 —— 一句话"     发版标题（默认只有 tag）
#   --notes-file <文件>            发版说明（默认一段"里面有什么"的模板）
#
# 为什么要有这个脚本：发布包和源码**不一致过两次**，两次都不是报错，是**静默**：
#   · v0.1.0 的 tag 里没有飞书包 —— releases/latest/download/install.sh 取回来的还是旧的；
#   · v0.2.0 发出去了，但落后源码 14 个提交 —— 第 34 轮的 stateFile 修、第 37 轮的"家"规则
#     都不在里面。
# 而那条 install.sh 的网址印在 README、GETTING-STARTED 和手册**三处**：读到手册的人装到的
# 却是旧东西，手册里写的"已经修了"就全是空话。
#
# 手工那七步（两个 bundle、latest 别名、六个 sha256、七个资产、发完核对）漏掉任何一步，
# 症状都不是失败，而是**发了旧东西**。所以写成脚本：每一步自检，发完立刻核对远端那份的
# sha256 —— 最后这一步是唯一能挡住"我等的是新的、下载到的是旧的"的。
# ============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="${ROOT}/dist"
STAGE="${DIST}/stage"

TAG=""
TITLE=""
NOTES=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --title) TITLE="${2:?--title 后面要跟一句话}"; shift 2 ;;
    --notes-file) NOTES="${2:?--notes-file 后面要跟一个文件}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) echo "不认识的参数：$1（--dry-run / --title / --notes-file）" >&2; exit 2 ;;
    *) TAG="$1"; shift ;;
  esac
done

pass=0
step() { printf '\n=== %s ===\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  ✅ %s\n' "$*"; }
bad() { printf '  ❌ %s\n' "$*"; exit 1; }
sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; else sha256sum "$1"; fi; }

[ -n "${TAG}" ] || bad "用法：sh scripts/release.sh v<版本> [--dry-run]（不给 tag 不知道发什么）"
case "${TAG}" in
  v[0-9]*) ;;
  *) bad "tag 要长成 v<版本>（收到的是「${TAG}」）" ;;
esac
VERSION="${TAG#v}"

# ── ① 版本自检 ──────────────────────────────────────────────────────────────
step "① 版本自检：所有包一个版本，而且和 tag 对得上"
PKG_COUNT=$(ls -d "${ROOT}"/packages/*/ | wc -l | tr -d ' ')
VERSIONS=""
for p in "${ROOT}"/packages/*/package.json; do
  VERSIONS="${VERSIONS}$(node -p "require('${p}').version")
"
done
UNIQ=$(printf '%s' "${VERSIONS}" | sort -u | tr -d '\n ')
[ "$(printf '%s' "${VERSIONS}" | sort -u | grep -c .)" = "1" ] \
  || bad "包版本不一致（$(printf '%s' "${VERSIONS}" | sort -u | tr '\n' ' ')）—— 先统一再发"
[ "${UNIQ}" = "${VERSION}" ] \
  || bad "包版本是 ${UNIQ}，tag 说的却是 ${VERSION} —— 先改 packages/*/package.json 再发"
ok "${PKG_COUNT} 个包都是 ${VERSION}"

# ── ② 工作区与提交自检 ──────────────────────────────────────────────────────
step "② 工作区干净，而且这个提交已经在远端"
[ -z "$(cd "${ROOT}" && git status --porcelain)" ] \
  || bad "工作区有没提交的改动 —— 发布包是从磁盘打的，别把在途的东西发出去"
SHA=$(cd "${ROOT}" && git rev-parse HEAD)
SHORT=$(printf '%s' "${SHA}" | cut -c1-7)
REMOTE_URL=$(cd "${ROOT}" && git remote get-url origin)
SLUG=$(printf '%s' "${REMOTE_URL}" | sed -e 's#^git@[^:]*:##' -e 's#^https\?://[^/]*/##' -e 's#\.git$##')
cd "${ROOT}" && git fetch --quiet origin || bad "取不到远端（网络？）"
git rev-parse --verify --quiet "origin/main" >/dev/null || bad "远端没有 main"
[ "$(git rev-parse origin/main)" = "${SHA}" ] \
  || bad "本地的 ${SHORT} 还没推到远端 main —— 先 push（tag 会指到这个提交）"
ok "提交 ${SHORT} 已在 ${SLUG} 的 main 上"
ok "工作区干净"

# ── ③ 打两个 bundle ─────────────────────────────────────────────────────────
step "③ 打两个 bundle（installer + dsh-plugin）"
if [ "${DRY}" = "1" ]; then
  ok "[dry-run] 会跑 scripts/make-installer-bundle.sh 和 make-dsh-plugin-bundle.sh"
else
  sh "${ROOT}/scripts/make-installer-bundle.sh" >/dev/null || bad "installer bundle 打失败"
  sh "${ROOT}/scripts/make-dsh-plugin-bundle.sh" >/dev/null || bad "dsh-plugin bundle 打失败"
  ok "打好了：$(ls "${DIST}"/butler-*-"${VERSION}".tar.gz | wc -l | tr -d ' ') 个压缩包"
fi

# ── ④ 包里的东西对不对（这一步专门盯 v0.1.0 那种"少发了一个包"）───────────────
step "④ 包内自检：抽到的 tarball 数量与源码包数一致，install.sh 没被动过"
if [ "${DRY}" = "1" ]; then
  ok "[dry-run] 会数 dist/stage/tarballs 并和 packages/ 比"
else
  PACKED=$(ls "${STAGE}"/tarballs/*.tgz 2>/dev/null | wc -l | tr -d ' ')
  [ "${PACKED}" = "${PKG_COUNT}" ] \
    || bad "源码 ${PKG_COUNT} 个包，tarballs 里只有 ${PACKED} 个 —— 少发了（v0.1.0 就是这么漏掉飞书的）"
  cmp -s "${ROOT}/install.sh" "${STAGE}/install.sh" \
    || bad "stage 里的 install.sh 和仓库里的不是同一份 —— 收件人会拿到别的引导器"
  ok "${PACKED} 个 tarball（和 packages/ 一样多），install.sh 一致"
fi

# ── ⑤ latest 别名 + 六个 sha256 ─────────────────────────────────────────────
step "⑤ 造 latest 别名，并给每个资产写 sha256"
INSTALLER="${DIST}/butler-installer-${VERSION}.tar.gz"
LATEST="${DIST}/butler-installer-latest.tar.gz"
PLUGIN="${DIST}/butler-dsh-plugin-${VERSION}.tar.gz"
if [ "${DRY}" = "1" ]; then
  ok "[dry-run] 会 cp installer → butler-installer-latest.tar.gz"
  ok "[dry-run] 会给 4 个压缩包 + install.sh 旁边的清单写 .sha256"
else
  cp "${INSTALLER}" "${LATEST}"
  # ⚠️ 清单里记**文件名**不是路径：已有的发布资产就是这么写的（96 字节那一份），
  # 而 install.sh 只取第一栏（哈希）—— 但别人可能拿它 shasum -c，名字得对得上。
  for f in "${INSTALLER}" "${LATEST}" "${PLUGIN}"; do
    (cd "$(dirname "${f}")" && sha_of "$(basename "${f}")" > "$(basename "${f}").sha256")
  done
  ok "latest 别名 + $(ls "${DIST}"/*.sha256 | wc -l | tr -d ' ') 个 sha256"
fi

# ── ⑥ 发版 ──────────────────────────────────────────────────────────────────
step "⑥ 发版：${TAG}（指向 ${SHORT}）"
[ -n "${TITLE}" ] || TITLE="${TAG}"
if [ -z "${NOTES}" ]; then
  NOTES="${DIST}/release-notes-${VERSION}.md"
  {
    printf '指向 %s 的发布包（`butler-installer-latest.tar.gz`）。\n\n' "${SHORT}"
    printf '里面是 %s 个包的离线 tarball，`install.sh` 会自己校验 sha256。\n\n' "${PKG_COUNT}"
    printf '⚠️ 真机验收（真飞书企业里扫码、长连接、回一条消息）**仍未做** —— 见 docs/CHANNEL-FEISHU.md 第十二节。\n'
  } > "${NOTES}"
fi
ASSETS="${INSTALLER} ${LATEST} ${PLUGIN} ${ROOT}/install.sh"
for f in ${ASSETS}; do
  [ -f "${f}.sha256" ] && ASSETS="${ASSETS} ${f}.sha256"
done
if [ "${DRY}" = "1" ]; then
  ok "[dry-run] gh release create ${TAG} --target ${SHA} --title 「${TITLE}」"
  for f in ${ASSETS}; do printf '      %s\n' "$(basename "${f}")"; done
else
  # shellcheck disable=SC2086
  gh release create "${TAG}" --target "${SHA}" --title "${TITLE}" --notes-file "${NOTES}" ${ASSETS} \
    >/dev/null || bad "gh release create 失败（登录/网络/同名 tag？）"
  ok "发出去了：${TAG}"
fi

# ── ⑦ 发完立刻核对远端（这一步是唯一挡得住"以为是新的"的）────────────────────
step "⑦ 核对：releases/latest/download 那份的 sha256 和本地一致"
if [ "${DRY}" = "1" ]; then
  ok "[dry-run] 会把 latest 别名下载回来比 sha256"
else
  DL=$(mktemp -d)
  URL="https://github.com/${SLUG}/releases/latest/download/butler-installer-latest.tar.gz"
  OK=0
  for _ in 1 2 3; do
    if curl -fsSL --max-time 180 -o "${DL}/butler-installer-latest.tar.gz" "${URL}"; then OK=1; break; fi
    sleep 5
  done
  [ "${OK}" = "1" ] || bad "取不回 ${URL} —— 发布已经创建，但这一条没验成，请手工再核一次"
  A=$(sha_of "${DL}/butler-installer-latest.tar.gz" | cut -d' ' -f1)
  B=$(sha_of "${LATEST}" | cut -d' ' -f1)
  [ "${A}" = "${B}" ] || bad "远端那份和你刚打的不一样（远端 ${A}，本地 ${B}）—— 别急着让人装"
  rm -rf "${DL}"
  ok "远端就是这一份（sha256 ${A}）"
fi

printf '\n✅ %s 就绪（%s 项自检通过）\n' "${TAG}" "${pass}"
if [ "${DRY}" = "1" ]; then printf '   这只是演练：去掉 --dry-run 才会真发。\n'; fi
