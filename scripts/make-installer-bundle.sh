#!/bin/sh
# ============================================================================
# 打一个**能直接发给小白**的包：dist/butler-installer-<版本>.tar.gz
#
# 里面是：
#   install.sh        引导器（查/下 Node → 装进私有前缀 → 起引导页）
#   install.command   macOS 上双击就能跑（⚠️ 第一次会被安全机制拦，右键→打开）
#   tarballs/*.tgz    11 个包，**离线可装**（`workspace:` 已被 pnpm pack 换成真版本号）
#   README.txt        给小白看的三句话
#
# 为什么要打 tarball 而不是"让他 npm i -g"：我们的包还没发布到 npm（那个名字被
# 别人占了，见 README 的"M3 安装器"一节）。tarball 这条路**不依赖任何账号**，
# 而且装出来的东西和发布后一模一样。
# ============================================================================
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${ROOT}/dist"
STAGE="${OUT}/stage"

VERSION=$(node -p "require('${ROOT}/packages/cli/package.json').version")
NAME="butler-installer-${VERSION}"

say() { printf '%s\n' "$*"; }

say "① 构建（保证 tarball 里是当前代码）"
(cd "${ROOT}" && pnpm -r build >/dev/null)

say "② 清理旧产物"
rm -rf "${STAGE}"
mkdir -p "${STAGE}/tarballs"
rm -f "${OUT}"/butler-installer-*.tar.gz

say "③ 打 $(ls "${ROOT}"/packages | wc -l | tr -d ' ') 个包"
for d in "${ROOT}"/packages/*/; do
  (cd "${d}" && pnpm pack --pack-destination "${STAGE}/tarballs" >/dev/null)
done
COUNT=$(ls "${STAGE}/tarballs"/*.tgz | wc -l | tr -d ' ')
say "   ${COUNT} 个 tarball"

say "④ 收进引导器和说明"
cp "${ROOT}/install.sh" "${STAGE}/install.sh"
chmod +x "${STAGE}/install.sh"
[ -f "${ROOT}/LICENSE" ] && cp "${ROOT}/LICENSE" "${STAGE}/LICENSE"
# 一页纸的上手清单（含验收清单 + "卡住了看这里"）—— 它跟着包一起走：
# 收到这个包的人多半不懂技术，README.txt 只有三句话，剩下的得有一份能照着做的。
cp "${ROOT}/docs/GETTING-STARTED.md" "${STAGE}/GETTING-STARTED.md"

cat > "${STAGE}/install.command" <<'EOF'
#!/bin/sh
# macOS：双击我就能装。
# 第一次会被系统拦一下（"无法验证开发者"）—— 右键 → 打开 → 再点"打开"。
# 我们没买 Apple 的签名证书（$99/年），所以只能用这个办法；
# 觉得别扭就用终端跑：sh install.sh
cd "$(dirname "$0")"
exec sh ./install.sh
EOF
chmod +x "${STAGE}/install.command"

cat > "${STAGE}/README.txt" <<EOF
AI 管家 —— 用微信遥控你的电脑
================================

怎么装（macOS / Linux）：

  1. 打开"终端"（macOS：聚焦搜索里敲"终端"）
  2. 把**你解压出来的这个文件夹**从访达里拖进终端窗口（路径会自动填好），然后回车
     —— 或者你自己 cd 到解压出来的那个文件夹
  3. 跑：sh install.sh

  或者直接双击 install.command（第一次会被系统拦，右键 → 打开）。

装的时候它会：
  · 看看你机器上有没有够新的 Node（没有就从官方下一个，并校验 SHA256）
  · 把 AI 管家装进 ~/.butler/prefix（**不要 root，不碰你的全局 npm**）
  · 启动它，浏览器会弹出引导页

接下来你只需要（页面上会一步步问你，都是复制粘贴）：

  · 用 Telegram 的话：先贴一次它给你的 bot token
  · 不管哪条路：贴一次模型 key
  · 用微信的话：最后拿手机扫一下二维码

详细步骤、以及"卡住了看这里"的对照表：见同目录的 GETTING-STARTED.md

想让它开机自己起来（关掉终端窗口也不怕）：

  最省事的办法：**在微信里直接跟它说"帮我设置成开机自动启动"** ——
  它会自己去做（要动你电脑的事，它会先问你一声）。
  管家自己知道 `butler` 在哪（装的时候只改它**自己**的 PATH，不动你的 dotfiles），
  所以这条路不用你再配什么；它在微信「自检」里也能看到这一条。

  ⚠️ 万一它回你"找不到 butler"（比如你把安装目录搬走了），那就退一步 ——
     在终端里自己跑一次下面这行：

     ~/.butler/prefix/bin/butler autostart on

出问题了（比如发了消息它不理你）：

  1. 先在微信里回一句「自检」—— 它会用人话告诉你哪儿不对
  2. 要是连它也不回（消息发出去一点动静都没有），**再双击一次 install.command**：
     它会重新把管家开起来，并再弹一次引导页

  想更细地排查，才需要在终端里跑：

     ~/.butler/prefix/bin/butler doctor

（这份包是 ${NAME}，版本 ${VERSION}，共 ${COUNT} 个包，离线可装。）
EOF

# ⚠️ 别把"打包时所在的那个目录"写进给小白看的说明里 —— 他拿到的是**解压出来的另一个地方**，
#    写死了只会让他照抄一条不存在的路径（这条就是真踩到的：README.txt 里印着打包机的绝对路径）。
#    守一道门：一旦混进打包机的路径，这个包就别发出去。
if grep -Fq "${ROOT}" "${STAGE}/README.txt"; then
  echo "✖ README.txt 里混进了打包机的路径（${ROOT}）—— 收件人那儿根本没有这个目录" >&2
  exit 1
fi

say "⑤ 打包"
tar -czf "${OUT}/${NAME}.tar.gz" -C "${STAGE}" .
say ""
say "✅ ${OUT}/${NAME}.tar.gz"
say "   里面：install.sh / install.command / README.txt / GETTING-STARTED.md / tarballs/（${COUNT} 个）"
