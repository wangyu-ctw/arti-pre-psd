"""本地用户配置：~/.arti-pre-psd/settings.json。

持久化项：
- `ps_app_path`：用户选过的 Photoshop 应用路径
- 可选 `window_width` / `window_height`（整数像素）：覆盖 pywebview 主窗口默认尺寸

代码内默认（含主窗口宽高）也集中在本模块，供 run.py / app_main.py 等引用。

设计原则：
- 文件不存在 / 损坏 → 返回空 dict，业务层各自给默认值，不抛异常
- 写入失败时打印日志但不抛（settings 不可写不该让主流程崩）
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CONFIG_DIR = Path.home() / ".arti-pre-psd"
CONFIG_PATH = CONFIG_DIR / "settings.json"

# 已知 key（避免分散字符串字面量）
KEY_PS_APP_PATH = "ps_app_path"
KEY_WINDOW_WIDTH = "window_width"
KEY_WINDOW_HEIGHT = "window_height"

# pywebview 主窗口默认像素（可被 settings.json 中 window_width / window_height 覆盖）
WEBVIEW_WIDTH_DEFAULT = 1200
WEBVIEW_HEIGHT_DEFAULT = 900
_WEBVIEW_WH_MIN = 400
_WEBVIEW_WH_MAX = 7680


def webview_size_kwargs() -> dict[str, int]:
    """传给 webview.create_window(..., **kwargs) 的 width / height。

    优先读 settings.json 中的 window_width、window_height；缺失或非法则用默认。
    """
    w = get(KEY_WINDOW_WIDTH, WEBVIEW_WIDTH_DEFAULT)
    h = get(KEY_WINDOW_HEIGHT, WEBVIEW_HEIGHT_DEFAULT)
    try:
        wi = int(w)
        hi = int(h)
    except (TypeError, ValueError):
        wi, hi = WEBVIEW_WIDTH_DEFAULT, WEBVIEW_HEIGHT_DEFAULT
    if not (_WEBVIEW_WH_MIN <= wi <= _WEBVIEW_WH_MAX and _WEBVIEW_WH_MIN <= hi <= _WEBVIEW_WH_MAX):
        wi, hi = WEBVIEW_WIDTH_DEFAULT, WEBVIEW_HEIGHT_DEFAULT
    return {"width": wi, "height": hi}


def load() -> dict[str, Any]:
    """读 settings；不存在 / 解析失败时返回空 dict。"""
    if not CONFIG_PATH.is_file():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_all(data: dict[str, Any]) -> None:
    """整体覆盖写。失败时打印警告不抛。"""
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception as e:
        print(f"[settings] save failed: {type(e).__name__}: {e}")


def get(key: str, default: Any = None) -> Any:
    return load().get(key, default)


def put(key: str, value: Any) -> None:
    """更新单个 key，merge 写入。"""
    data = load()
    data[key] = value
    save_all(data)
