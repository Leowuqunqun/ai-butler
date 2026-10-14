#!/usr/bin/env bash
# 把 docs/diagrams/*.mmd（含 en/ 下的英文版）渲染成 .svg 和 .png
#
# 为什么不用 mmdc 直接出 PNG：mmdc 的 PNG 会带上 Puppeteer 视口的空白边
# （旅程图那种宽扁图尤其明显）。所以 SVG 交给 mmdc，PNG 用 Chrome 按 SVG 的
# viewBox 精确截图，尺寸和内容严丝合缝。
#
# 依赖：mermaid-cli（mmdc）+ 本机 Chrome
#   npm i -g @mermaid-js/mermaid-cli
# 用法：bash scripts/render-diagrams.sh [只渲染某一张的文件名前缀]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/docs/diagrams"
FILTER="${1:-}"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PUPPETEER_CFG="$(mktemp -t mmd-puppeteer-XXXXXX.json)"
trap 'rm -f "$PUPPETEER_CFG"' EXIT

cat > "$PUPPETEER_CFG" <<JSON
{ "executablePath": "$CHROME",
  "args": ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
JSON

command -v mmdc >/dev/null || { echo "缺 mmdc：npm i -g @mermaid-js/mermaid-cli"; exit 1; }
[ -x "$CHROME" ] || { echo "找不到 Chrome，用 CHROME=/path/to/chrome 指定"; exit 1; }

ok=0; fail=0
# 中文版在 docs/diagrams/，英文版在 docs/diagrams/en/。两套源码分开放，是因为
# check:docs 会数 docs/diagrams 顶层有几张 .svg，并跟文档里写的「N 张图」对账。
for SRC in "$DIR" "$DIR/en"; do
  [ -d "$SRC" ] || continue
  for mmd in "$SRC"/*.mmd; do
    [ -e "$mmd" ] || continue
    base="$(basename "$mmd" .mmd)"
    label="$base"
    [ "$SRC" != "$DIR" ] && label="en/$base"
    [ -n "$FILTER" ] && case "$base" in *"$FILTER"*) ;; *) continue ;; esac

    # ① SVG：交给 mermaid 官方渲染器
    if ! mmdc -i "$mmd" -o "$SRC/$base.svg" -p "$PUPPETEER_CFG" -b white >/dev/null 2>&1; then
      echo "  ❌ ${label}（mmdc 渲染失败，多半是 .mmd 语法问题）"; fail=$((fail+1)); continue
    fi

    # ② PNG：从 SVG 的 viewBox 读真实尺寸，让 Chrome 精确截图
    dims="$(node -e '
      const s=require("fs").readFileSync(process.argv[1],"utf8");
      const m=s.match(/viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/);
      if(!m) process.exit(1);
      console.log(Math.ceil(+m[3])+" "+Math.ceil(+m[4]));
    ' "$SRC/$base.svg")"

    set -- $dims
    "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
      --default-background-color=FFFFFFFF --force-device-scale-factor=2 \
      --screenshot="$SRC/$base.png" --window-size="$1,$2" \
      "file://$SRC/$base.svg" >/dev/null 2>&1

    echo "  ✅ $label"; ok=$((ok+1))
  done
done

echo "----"
echo "成功 $ok 张，失败 $fail 张"
