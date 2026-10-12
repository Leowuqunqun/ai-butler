#!/usr/bin/env bash
#
# 打一个 DSH 插件包（bundle）—— 装的人不需要仓库、不需要 npm 发布。
#
#   bash scripts/make-dsh-plugin-bundle.sh
#   → dist/butler-dsh-plugin-0.1.0/         （可以直接用的目录）
#   → dist/butler-dsh-plugin-0.1.0.tar.gz   （发给别人的那个）
#
# 包里三个包是怎么排的：
#
#   plugin/        @butler/dsh-plugin     ← 装的就是它（dsh.bundle 指到 cordis.patch.yml）
#   channel/       wechat-agent-bridge    ← 微信协议（plugin 依赖它）
#   seam-channel/  @butler/seam-channel   ← 通道基类（channel 依赖它，已编译的 lib/）
#
# ── 为什么要改写 package.json ─────────────────────────────────────
#
#   1. `workspace:*` → `file:../xxx`：profile 那边没有 pnpm workspace，
#      只能按相对目录找。
#   2. `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` 从 dependencies
#      挪到 peerDependencies：**这是关键**。
#      DSH 启动时会接上自己的模块解析（`@deepseek-ai/dsh-app-boot` 替换了
#      Node 的那些解析内部），所以 profile 插件里的 `@deepseek-ai/*`
#      一律解析到"DSH 自己那份"。要是我们让 pnpm 把它当普通依赖装一份，
#      它会落在 `<profile>/node_modules/@deepseek-ai/` —— 比 DSH 那份**更近**，
#      于是 `Service` 基类来自另一份副本，服务注册就可能认不出来
#      （"装上了却起不来"）。profile 的 pnpm 配了 `autoInstallPeers: false`，
#      peer 不会被装 ✓。
#   3. 去掉 devDependencies 与 scripts：测试和构建是仓库里的事，
#      装的人不该跑它们。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT}/packages/dsh-plugin/package.json').version")"
NAME="butler-dsh-plugin-${VERSION}"
OUT="${ROOT}/dist/${NAME}"

echo "打包 ${NAME}"
rm -rf "${OUT}"
mkdir -p "${OUT}/plugin" "${OUT}/channel" "${OUT}/seam-channel" "${OUT}/probe"

# ── plugin/ ──
cp -R "${ROOT}/packages/dsh-plugin/src" "${OUT}/plugin/src"
cp "${ROOT}/packages/dsh-plugin/cordis.patch.yml" "${OUT}/plugin/cordis.patch.yml"
cp "${ROOT}/packages/dsh-plugin/README.md" "${OUT}/plugin/README.md"
cp "${ROOT}/packages/dsh-plugin/package.json" "${OUT}/plugin/package.json"

# ── channel/（微信协议，只带运行时要的） ──
cp -R "${ROOT}/packages/channel-wechat/src" "${OUT}/channel/src"
cp "${ROOT}/packages/channel-wechat/README.md" "${OUT}/channel/README.md"
cp "${ROOT}/packages/channel-wechat/LICENSE" "${OUT}/channel/LICENSE"
cp "${ROOT}/packages/channel-wechat/package.json" "${OUT}/channel/package.json"

# ── seam-channel/（通道基类，用已编译的 lib/） ──
if [ ! -f "${ROOT}/packages/seam-channel/lib/index.js" ]; then
  echo "✗ packages/seam-channel/lib 不存在（先跑 pnpm -r build）" >&2
  exit 1
fi
cp -R "${ROOT}/packages/seam-channel/lib" "${OUT}/seam-channel/lib"
cp "${ROOT}/packages/seam-channel/README.md" "${OUT}/seam-channel/README.md"
cp "${ROOT}/packages/seam-channel/package.json" "${OUT}/seam-channel/package.json"

# ── probe/（验收探针；想自己验一遍的人用它，不装它不影响插件） ──
cp -R "${ROOT}/packages/dsh-plugin/scripts/dsh-probe/." "${OUT}/probe/"
chmod +x "${OUT}/probe/run.sh"

# ── 依赖改写 ──
node - "${OUT}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** 去掉仓库专用的字段，并把包名依赖换成相对目录 */
function common(manifest, deps = {}) {
  delete manifest.devDependencies;
  delete manifest.scripts;
  for (const [name, spec] of Object.entries(deps)) {
    if (manifest.dependencies?.[name] !== undefined) manifest.dependencies[name] = spec;
    else if (manifest.peerDependencies?.[name] !== undefined) manifest.peerDependencies[name] = spec;
  }
}

// plugin：wechat-agent-bridge → file:../channel
const pluginFile = path.join(out, 'plugin/package.json');
const plugin = read(pluginFile);
common(plugin, { 'wechat-agent-bridge': 'file:../channel' });
write(pluginFile, plugin);

// channel：@butler/seam-channel → file:../seam-channel；DSH 的包挪成 peer
const channelFile = path.join(out, 'channel/package.json');
const channel = read(channelFile);
common(channel, { '@butler/seam-channel': 'file:../seam-channel' });
channel.peerDependencies = channel.peerDependencies ?? {};
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  const spec = channel.dependencies[name];
  if (spec === undefined) continue;
  delete channel.dependencies[name];
  channel.peerDependencies[name] = spec;
}
write(channelFile, channel);

// seam-channel：它本来就是把 cordis 当 peer 的，只要去掉仓库专用字段
const seamFile = path.join(out, 'seam-channel/package.json');
const seam = read(seamFile);
common(seam);
write(seamFile, seam);

for (const [file, manifest] of [['plugin', plugin], ['channel', channel], ['seam-channel', seam]]) {
  const deps = Object.entries(manifest.dependencies ?? {}).map(([k, v]) => `${k}@${v}`);
  const peers = Object.entries(manifest.peerDependencies ?? {}).map(([k, v]) => `${k}@${v}`);
  console.log(`  ${file}: deps=[${deps.join(', ')}] peers=[${peers.join(', ')}]`);
}
NODE

# ── 装的时候用的那条命令 ──
cat > "${OUT}/install.sh" <<'SH'
#!/usr/bin/env bash
#
# 把微信插件装进一个 DSH profile。
#
#   bash install.sh            # 装进 web（浏览器里用的那个）
#   bash install.sh headless   # 装进 headless
#
set -euo pipefail

PROFILE="${1:-web}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "✗ 找不到 dsh 命令。先按 DSH 自己的文档把它装上，再回来跑这条。" >&2
  exit 1
fi

echo "把微信插件装进 profile「${PROFILE}」…"
dsh plugin --profile "${PROFILE}" add "file:${HERE}/plugin"
echo
echo "装好了。重启 profile 生效："
echo "    dsh ${PROFILE}"
echo
echo "第一次启动会起一个扫码页（只监听 127.0.0.1），用微信扫一下就登上了。"
echo "登录态存在 ~/.dsh/butler-wechat/，下次不用再扫。"
SH
chmod +x "${OUT}/install.sh"

cat > "${OUT}/README.txt" <<'TXT'
微信 × DSH —— 把微信接进 DSH 的插件
====================================

装上之后：微信里说的话进 DSH 的会话（在你指定的目录里干活），DSH 的回复回到微信。

一、装
------
    bash install.sh              # 装进 web profile（浏览器里用的那个）
    bash install.sh headless     # 或者 headless

    等价于手工一条命令：
    dsh plugin --profile web add file:<这个目录的绝对路径>/plugin

二、登录
--------
重启 profile，第一次会自己起一个扫码页（只监听 127.0.0.1），用微信扫码。
登录态落在 ~/.dsh/butler-wechat/，之后不用再扫。

三、认主
--------
默认"第一个跟这个微信号说话的人成为主人"，之后别人发来的消息一个字都不回、
也不会去跑 agent。想先定死主人，在 profile 的 cordis.patch.yml 里写：

    - id: butler-wechat
      name: '@butler/dsh-plugin'
      config:
        owner: ['<你的 userId>']
        cwd: /你想让它干活的目录

其余可配的：home / typing / quoteReply / qrPage / qrPort / autostart / claim。
详见 plugin/README.md。

四、这个包里有四个东西
----------------------
    plugin/        @butler/dsh-plugin      装的是它
    channel/       wechat-agent-bridge     微信协议（扫码、收信、附件）
    seam-channel/  @butler/seam-channel    通道基类
    probe/         验收探针                想先自己验一遍的话用它

后两个是 plugin 的依赖，pnpm 会自动按相对路径装好，不用管。

五、想先验一遍再装（可选，但推荐）
----------------------------------
    bash probe/run.sh

它在一个**临时目录**里建一个 DSH profile（不碰你正在用的 ~/.dsh），把插件和探针
装进去，模型指到一个本机假端点（不出网、不花钱），然后真跑两轮，逐项断言：
装得上、挂得住、两轮真跑完、同一个人的会话跨重启还在。
要留现场加 PROBE_KEEP=1。

六、没验过的（说清楚）
----------------------
真实微信登录要你自己扫码 —— 发包的人没法替你扫。
真实云端模型要你自己的 API key，也没法替你调。
除此之外的都验过了：离线 37 个测试（认主 / 排队 / 回复 / 会话复用 / 附件路径），
加上上面那条真机验收。
TXT

# ── 打包 ──
( cd "${ROOT}/dist" && tar czf "${NAME}.tar.gz" "${NAME}" )

echo
echo "✓ ${OUT}"
echo "✓ ${ROOT}/dist/${NAME}.tar.gz  ($(du -h "${ROOT}/dist/${NAME}.tar.gz" | cut -f1))"
