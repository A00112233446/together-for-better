#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "[!] 找不到 Node.js，請先到 https://nodejs.org 下載安裝 LTS 版本。"
  echo ""
  read -n 1 -s -r -p "按任意鍵關閉"
  exit 1
fi
node server.js
