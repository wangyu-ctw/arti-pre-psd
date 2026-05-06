#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="ArtiprePSD"
ICON_PNG="${1:-"$ROOT/assets/app-icon.png"}"
BUILD_DIR="$ROOT/build/macos"
ICON_ICNS="$BUILD_DIR/$APP_NAME.icns"
VENV_DIR="$ROOT/.venv-packager"
export PYINSTALLER_CONFIG_DIR="$ROOT/build/pyinstaller-config"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build] 仅支持在 macOS 执行"
  exit 1
fi

if [[ ! -f "$ICON_PNG" ]]; then
  echo "[build] 图标文件不存在: $ICON_PNG"
  echo "[build] 用法: bash scripts/build_macos_app.sh /path/to/icon.png"
  exit 1
fi

for cmd in python3 npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[build] 缺少命令: $cmd"
    exit 1
  fi
done

echo "[build] 1/5 构建前端 dist..."
cd "$ROOT/frontend"
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build

echo "[build] 2/5 准备 Python 打包环境..."
if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi
PY="$VENV_DIR/bin/python"
PIP="$VENV_DIR/bin/pip"
"$PIP" install --upgrade pip >/dev/null
"$PIP" install -r "$ROOT/backend/requirements.txt" pyinstaller >/dev/null

echo "[build] 3/5 生成 .icns 图标..."
rm -f "$ICON_ICNS"
"$PY" - <<PY
from pathlib import Path
from PIL import Image

icon_png = Path(r"$ICON_PNG")
icon_icns = Path(r"$ICON_ICNS")
icon_icns.parent.mkdir(parents=True, exist_ok=True)

img = Image.open(icon_png).convert("RGBA")
sizes = [(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]
img.save(icon_icns, format="ICNS", sizes=sizes)
print(icon_icns)
PY

echo "[build] 4/5 PyInstaller 打包 .app..."
cd "$ROOT"
rm -rf "$ROOT/build/pyinstaller" "$ROOT/build/pyinstaller-config" "$ROOT/dist/$APP_NAME.app"
"$VENV_DIR/bin/pyinstaller" \
  --noconfirm \
  --clean \
  --windowed \
  --name "$APP_NAME" \
  --icon "$ICON_ICNS" \
  --distpath "$ROOT/dist" \
  --workpath "$ROOT/build/pyinstaller" \
  --specpath "$ROOT/build/pyinstaller" \
  --hidden-import webview.platforms.cocoa \
  --add-data "$ROOT/frontend/dist:frontend/dist" \
  --add-data "$ROOT/backend/psExtendScript:backend/psExtendScript" \
  "$ROOT/app_main.py"

echo "[build] 5/5 完成"
echo "[build] App 路径: $ROOT/dist/$APP_NAME.app"
echo "[build] 运行: open \"$ROOT/dist/$APP_NAME.app\""

