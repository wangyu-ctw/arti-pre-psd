"""本地用户配置：~/.arti-pre-psd/settings.json。

目前只存一项：用户选过的 Photoshop 应用路径（ps_app_path）。
设计原则：
- 文件不存在 / 损坏 → 返回空 dict，业务层各自给默认值，不抛异常
- 写入失败时打印日志但不抛（settings 不可写不该让主流程崩）
- 只有"持久化用户选择 / 偏好"才进这里；所有"代码默认"留在代码里
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CONFIG_DIR = Path.home() / ".arti-pre-psd"
CONFIG_PATH = CONFIG_DIR / "settings.json"

# 已知 key（避免分散字符串字面量）
KEY_PS_APP_PATH = "ps_app_path"


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
