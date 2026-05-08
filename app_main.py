"""macOS 打包版入口。

用于 PyInstaller 打包后的 Artiprepsd.app 启动，不包含开发期依赖安装逻辑。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import webview

from backend.api import Api
from backend.settings import webview_size_kwargs


def _resource_root() -> Path:
    """返回运行时资源根目录（源码运行 / PyInstaller 冻结运行都可用）。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).parent.resolve()


def main() -> None:
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

    root = _resource_root()
    index = root / "frontend" / "dist" / "index.html"
    if not index.exists():
        raise SystemExit(f"未找到前端构建产物：{index}")

    _ENABLE_TEXT_SELECT_JS = (
        "(function(){"
        "var s=document.createElement('style');"
        "s.textContent='html,body,*{-webkit-user-select:text!important;user-select:text!important}';"
        "document.head.appendChild(s);"
        "})()"
    )

    win = webview.create_window(
        "Artiprepsd",
        str(index),
        js_api=Api(),
        **webview_size_kwargs(),
    )
    win.events.loaded += lambda: win.evaluate_js(_ENABLE_TEXT_SELECT_JS)
    webview.start()


if __name__ == "__main__":
    main()

