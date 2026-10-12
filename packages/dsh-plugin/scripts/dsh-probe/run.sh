#!/usr/bin/env bash
#
# 真机验收：在一个**临时 DSH home** 里把插件装起来跑一遍。
#
# 它验的是那些"离线测试永远验不到"的东西：
#   - 打出来的 DSH 插件包，在真 DSH 里装得上、挂得上（行名解析、peer、patch 顺序）；
#   - 我们调 DSH 的那几行 API（agents.create/resume/get、followup、whenIdle、
#     session/event、installModelSelection）真的按我们以为的语义工作；
#   - 一个联系人 = 一份会话，而且**跨重启还在**（第二次跑会接上第一次的会话）。
#
# 它**不碰微信、不出网、不花钱**：通道是探针里的记账假对象，
# 模型是本机假端点（fake-model.mjs）。真微信登录（要人扫码）不在这里验。
#
#   bash packages/dsh-plugin/scripts/dsh-probe/run.sh
#
# 环境变量：
#   PROBE_DSH_HOME   用指定的 home（默认 mktemp 一个，跑完删）
#   PROBE_KEEP=1     跑完保留临时 home 和日志，方便自己翻
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 两种布局都能跑：
#   仓库里   packages/dsh-plugin/scripts/dsh-probe/   → 包要现打，测试也在
#   发行包里 <解开的包>/probe/                        → 包就是上级目录，没有仓库测试
if [ -f "$HERE/../../package.json" ]; then
  PKG="$(cd "$HERE/../.." && pwd)"
  REPO="$(cd "$PKG/../.." && pwd)"
  BUNDLE="$REPO/dist/butler-dsh-plugin-$(node -p "require('$PKG/package.json').version")"
  TESTS="$PKG/test"
  SAY_LAYOUT="仓库布局"
else
  BUNDLE="$(cd "$HERE/.." && pwd)"
  REPO="$BUNDLE"
  PKG="$BUNDLE/plugin"
  TESTS=""
  SAY_LAYOUT="发行包布局"
fi
PORT=8123

PROFILE="butler-probe"
DSH_HOME_DIR="${PROBE_DSH_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-butler-probe.XXXXXX")}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/butler-probe-work.XXXXXX")"
MODEL_LOG="$DSH_HOME_DIR/fake-model.log"
MODEL_PID=""
FAILED=0

say() { printf '%s\n' "$*"; }
ok() { say "  ✓ $*"; }
bad() {
  say "  ✗ $*"
  FAILED=1
}

cleanup() {
  if [ -n "$MODEL_PID" ]; then kill "$MODEL_PID" 2>/dev/null || true; fi
  if [ "${PROBE_KEEP:-0}" = "1" ]; then
    say ""
    say "（PROBE_KEEP=1，留着这些方便你翻：${DSH_HOME_DIR} 、${WORK}）"
  else
    rm -rf "$DSH_HOME_DIR" "$WORK"
  fi
}
trap cleanup EXIT

command -v dsh >/dev/null 2>&1 || {
  say "✗ 找不到 dsh —— 这个验收要真 DSH 在 PATH 里"
  exit 1
}

say "════ 0. 先跑离线测试（逻辑层），再上真机（接线层）　当前是${SAY_LAYOUT}"
if [ -n "$TESTS" ]; then
  node --test "$TESTS"/*.mjs > "$WORK/unit.log" 2>&1 || true
  if grep -q "ℹ fail 0" "$WORK/unit.log"; then
    ok "离线测试：$(grep -E '^ℹ (tests|pass)' "$WORK/unit.log" | tr '\n' ' ')"
  else
    bad "离线测试没过，先看 ${WORK}/unit.log"
    grep -E "^ℹ (tests|pass|fail)|not ok" "$WORK/unit.log" | head -20 || true
  fi
else
  say "  · 发行包里不带仓库测试，跳过（想跑那条：仓库里 node --test packages/dsh-plugin/test/*.mjs）"
fi

say ""
say "════ 1. 插件包"
if [ -d "$BUNDLE/plugin" ]; then
  ok "就用这个包：$BUNDLE"
elif [ -f "$REPO/scripts/make-dsh-plugin-bundle.sh" ]; then
  if bash "$REPO/scripts/make-dsh-plugin-bundle.sh" >/dev/null; then
    ok "现打了一个：$BUNDLE"
  else
    bad "包没打出来"
  fi
else
  bad "找不到包目录：$BUNDLE"
fi

say ""
say "════ 2. 端口 $PORT 得空着（假模型要用）"
if node -e "const s=require('net').createConnection({port:$PORT,host:'127.0.0.1'});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1))" 2>/dev/null; then
  bad "$PORT 被占了，先腾出来（或改 fake-model.mjs 与探针 patch 里的端口）"
  exit 1
fi
ok "$PORT 空着"

say ""
say "════ 3. 起一个临时 DSH home + profile（不碰你正在用的 ~/.dsh）"
DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --from-default-profile headless --dump-config > "$WORK/default-config.yml" 2>&1 \
  && ok "profile 建好了：$DSH_HOME_DIR/profiles/$PROFILE" \
  || bad "profile 没建起来（看 ${WORK}/default-config.yml）"

say ""
say "════ 4. 装插件 + 探针"
DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile "$PROFILE" add \
  "file:$BUNDLE/plugin" "file:$HERE" > "$WORK/install.log" 2>&1 \
  && ok "装上了（pnpm 说 missing peer 是正常的：DSH 自己的包由 DSH 提供）" \
  || bad "装失败（看 ${WORK}/install.log）"

# 探针要求"插件跟它在同一个 profile"里 —— 上一步已经保证了，
# 顺手确认一下 profile 里真能拿到桥接层（少了这一步，探针会在启动时炸）。
if [ -f "$DSH_HOME_DIR/profiles/$PROFILE/node_modules/@butler/dsh-plugin/src/bridge.mjs" ]; then
  ok "桥接层在 profile 里（探针 import 得到）"
else
  bad "profile 里没有 @butler/dsh-plugin/src/bridge.mjs"
fi

say ""
say "════ 5. 插件挂上但别登录微信（登录要人扫码）"
cat > "$DSH_HOME_DIR/profiles/$PROFILE/cordis.patch.yml" <<'YML'
- id: butler-wechat
  name: '@butler/dsh-plugin'
  config:
    autostart: false
YML
ok "patch 写好（autostart: false）"

say ""
say "════ 6. 起本地假模型"
node "$HERE/fake-model.mjs" "$PORT" > "$MODEL_LOG" 2>&1 &
MODEL_PID=$!
READY=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if node -e "fetch('http://127.0.0.1:$PORT/v1/models').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 0.2
done
[ "$READY" = "1" ] && ok "假模型在 http://127.0.0.1:$PORT/v1" || bad "假模型没起来（看 ${MODEL_LOG}）"

run_probe() { # $1=日志文件
  DSH_HOME="$DSH_HOME_DIR" BUTLER_PROBE_KEY=dummy PROBE_CWD="$WORK" \
    dsh --profile "$PROFILE" "说一句 ok" > "$1" 2>&1 || true
  grep -h "\[probe\]" "$1" | sed 's/^/    /'
}

say ""
say "════ 7. 第一遍：会话存储是空的 → 应该走 create，并且两轮都真跑完"
run_probe "$WORK/run1.log"
grep -q "\[probe\] 判定: PASS" "$WORK/run1.log" && ok "判定 PASS" || bad "判定不是 PASS"
grep -q "（create）开始跑一轮" "$WORK/run1.log" && ok "第一轮走的是 create" || bad "第一轮没走 create"
grep -q "（live）开始跑一轮" "$WORK/run1.log" && ok "第二轮复用了 live 会话（没重新建）" || bad "第二轮没走 live"
grep -q "agents.create 调用次数：1" "$WORK/run1.log" && ok "两轮只建了一个会话" || bad "会话数不对"

say ""
say "════ 8. 第二遍：会话存储留着 → 应该接回上一次那份（跨重启的连续性）"
run_probe "$WORK/run2.log"
grep -q "\[probe\] 判定: PASS" "$WORK/run2.log" && ok "判定 PASS" || bad "判定不是 PASS"
grep -q "（resume）开始跑一轮" "$WORK/run2.log" && ok "接回了上次的会话（resume）" || bad "没走 resume"
grep -q "agents.create 调用次数：0" "$WORK/run2.log" && ok "一个新会话都没建" || bad "重建了会话"

say ""
say "════ 9. 我们发出去的那句话，真的到了模型那头吗"
grep -q "探针第一句" "$MODEL_LOG" && ok "假模型的请求日志里有「探针第一句」" || bad "模型没收到第一句"
grep -q "探针第二句" "$MODEL_LOG" && ok "假模型的请求日志里有「探针第二句」" || bad "模型没收到第二句"

say ""
if [ "$FAILED" = "0" ]; then
  say "✅ 真机验收通过：装得上、挂得住、两轮真跑完、同一份会话跨重启还在。"
  say "   （仍未验的：真微信登录要人扫码；真云端模型要 key。这两件只能在你自己机器上验。）"
else
  say "❌ 有项没过 —— 上面带 ✗ 的就是。日志：${WORK}"
  exit 1
fi
