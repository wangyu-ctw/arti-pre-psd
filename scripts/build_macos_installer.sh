#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="ArtiprePSD"
APP_PATH="$ROOT/dist/$APP_NAME.app"
DMG_ROOT="$ROOT/build/dmg-root"
DMG_PATH="$ROOT/dist/$APP_NAME-macOS.dmg"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[installer] 仅支持在 macOS 执行"
  exit 1
fi

if ! command -v hdiutil >/dev/null 2>&1; then
  echo "[installer] 缺少命令: hdiutil"
  exit 1
fi

echo "[installer] 1/3 构建 macOS App..."
bash "$ROOT/scripts/build_macos_app.sh" "$@"

if [[ ! -d "$APP_PATH" ]]; then
  echo "[installer] 未找到 App: $APP_PATH"
  exit 1
fi

echo "[installer] 2/3 准备 DMG 内容..."
rm -rf "$DMG_ROOT" "$DMG_PATH"
mkdir -p "$DMG_ROOT"
cp -R "$APP_PATH" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"

echo "[installer] 3/3 生成 DMG 安装器..."
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

echo "[installer] 完成"
echo "[installer] DMG 路径: $DMG_PATH"
echo "[installer] 安装方式: 打开 DMG 后将 $APP_NAME.app 拖到 Applications"
