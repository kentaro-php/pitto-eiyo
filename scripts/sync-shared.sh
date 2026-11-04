#!/usr/bin/env bash
# shared/logic.js を web/ と gas/ にコピーする（共通ロジックを変更したら実行）
set -e
cd "$(dirname "$0")/.."
cp shared/logic.js web/logic.js
cp shared/logic.js gas/logic.js
echo "synced shared/logic.js -> web/logic.js, gas/logic.js"
