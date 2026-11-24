#!/usr/bin/env bash
# 一键部署 D1 版两个 Worker（明文版 + 混淆版），部署后校验 /api/version。
#
# 用法：scripts/deploy-d1.sh
# 凭据：CLOUDFLARE_API_TOKEN 没设时，从 Cloudflare 连接器取 surrogate
# （只进环境变量，不打印、不落盘）；已设时直接用现成的。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  CLOUDFLARE_API_TOKEN="$(python3 -c '
import sys
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry
print(dynamic_credential_entry("custom.cloudflare")["surrogate"])
')"
  export CLOUDFLARE_API_TOKEN
fi

echo "部署明文版 cf-tg-checkin-d1 ..."
npx wrangler deploy --config wrangler.d1.jsonc

echo "部署混淆版 cf-tg-checkin-d1-obf ..."
node build.mjs --d1 && node scripts/obfuscate.mjs
npx wrangler deploy --config wrangler.d1-obf.jsonc

echo "校验 /api/version（期望 ${VERSION}）..."
for host in cf-tg-checkin-d1.yanneo2003.workers.dev cf-tg-checkin-d1-obf.yanneo2003.workers.dev; do
  got="$(curl -s "https://${host}/api/version")"
  echo "${host}: ${got}"
  case "${got}" in
    *"\"version\":\"${VERSION}\""*) ;;
    *) echo "版本校验失败：${host} 不是 ${VERSION}" >&2; exit 1 ;;
  esac
done
echo "两个 Worker 都是 ${VERSION}，部署完成。"
