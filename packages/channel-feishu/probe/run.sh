#!/usr/bin/env bash
# 飞书真机冒烟 —— 「扫码 → 长连接 → 收一条 → 回一条」通不通，跑这个。
#
#   bash packages/channel-feishu/probe/run.sh          # 没凭据就扫码注册
#   bash packages/channel-feishu/probe/run.sh --dry    # 只看要做什么，不联网
#
# 有凭据就放进环境变量跳过扫码：
#   LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx bash packages/channel-feishu/probe/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
exec node probe/smoke.mjs "$@"
