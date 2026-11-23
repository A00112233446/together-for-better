#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] 找不到 Node.js，請先到 https://nodejs.org 下載安裝 LTS 版本。"
  read -n 1 -s -r -p "按任意鍵關閉"; exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x ./cloudflared ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "第一次分享需要安裝 Cloudflare 官方的分享工具 cloudflared。按任意鍵開始安裝，或關閉視窗取消。"
    read -n 1 -s -r
    brew install cloudflared || { echo "[!] 安裝失敗"; read -n 1 -s -r -p "按任意鍵關閉"; exit 1; }
  else
    echo "[!] 找不到 cloudflared。請到 https://github.com/cloudflare/cloudflared/releases/latest 下載 Mac 版，"
    echo "    或先安裝 Homebrew 再執行 brew install cloudflared。"
    read -n 1 -s -r -p "按任意鍵關閉"; exit 1
  fi
fi
node server.js --share
