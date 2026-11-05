#!/usr/bin/env bash
# gas/*.gs と shared/logic.js を 1 つの Code.gs にまとめる（Apps Script に 1 回で貼り付けるため）
set -e
cd "$(dirname "$0")/.."
mkdir -p gas/bundle
out=gas/bundle/Code.gs
{
  echo "/* ピッと栄養 GAS 一体版 — scripts/bundle-gas.sh が生成。編集は gas/*.gs と shared/logic.js に対して行うこと。 */"
  for f in shared/logic.js gas/Util.gs gas/Db.gs gas/Auth.gs gas/Products.gs gas/Foods.gs gas/External.gs gas/Logs.gs gas/Summary.gs gas/Profile.gs gas/Sync.gs gas/Ocr.gs gas/Code.gs; do
    echo ""
    echo "/* ===================== $(basename "$f") ===================== */"
    cat "$f"
  done
  echo ""
  echo "/* ===================== END OF BUNDLE ===================== */"
} > "$out"
cp gas/appsscript.json gas/bundle/appsscript.json
echo "wrote $out ($(wc -l < "$out") lines) and gas/bundle/appsscript.json"
