"""暴露给前端 (window.pywebview.api) 的方法集合。

约定：
- 所有公开方法接收 / 返回 JSON 可序列化对象。
- 失败时返回 {"ok": False, "error": "..."}，成功时 {"ok": True, "data": ...}。

当前职责：
1. 探测 / 启动 / 选择 系统里的 Photoshop 应用（macOS 优先）。
2. 让用户用原生 dialog 选 PSD 文件（绕过浏览器 base64，对大文件友好）。
3. 调用 backend.photoshop.process_psd 串联预置 ExtendScript 脚本，最终返回
   _clean.psd 的路径。脚本顺序与具体清洗策略详见 backend/photoshop.py 与
   backend/psExtendScript/README.md。

历史说明：早期版本用 psd-tools 在 Python 进程内做清洗，因 PSD 二进制兼容性
问题（智能对象 / LinkedLayer 残留等）持续打补丁开销过大，已彻底改走
ExtendScript（"PS 自己写出的 PSD，PS 自己一定能打开"）。原 backend/utils/
下的 Python 清洗模块整组已移除。
"""
from __future__ import annotations

import os
import platform
import subprocess
from pathlib import Path
from typing import Any, Optional

import webview

from . import photoshop, settings


class Api:
    def __init__(self) -> None:
        # 不在构造时立刻碰 PS（避免 import 时抖动）；前端调 ps_get_status
        # 时才做按需检测 / 启动。
        pass

    # ---- 通用：打开外部 URL ------------------------------------

    def open_external(self, url: str) -> dict[str, Any]:
        """交给系统默认程序打开 URL（http(s)://、mailto:、file:// 等）。"""
        try:
            if not isinstance(url, str) or not url:
                return {"ok": False, "error": "empty url"}
            allowed = ("http://", "https://", "mailto:", "file://")
            if not url.startswith(allowed):
                return {"ok": False, "error": f"scheme not allowed: {url[:16]}..."}

            system = platform.system()
            if system == "Darwin":
                r = subprocess.run(
                    ["open", url], capture_output=True, text=True, timeout=8
                )
                if r.returncode == 0:
                    return {"ok": True, "data": {"url": url}}

                if url.startswith("mailto:"):
                    r2 = subprocess.run(
                        ["open", "-b", "com.apple.mail", url],
                        capture_output=True, text=True, timeout=8,
                    )
                    if r2.returncode == 0:
                        return {"ok": True, "data": {"url": url, "via": "Mail.app"}}

                msg = (r.stderr or r.stdout).strip() or "open exited non-zero"
                return {"ok": False, "error": f"open exit={r.returncode}: {msg}"}

            if system == "Windows":
                getattr(os, "startfile")(url)
                return {"ok": True, "data": {"url": url}}

            subprocess.Popen(["xdg-open", url])
            return {"ok": True, "data": {"url": url}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    # ---- Photoshop 状态 / 启动 ---------------------------------

    def ps_get_status(self) -> dict[str, Any]:
        """返回 Photoshop 探测/运行状态。前端首屏会先调这个决定后续 UI：
            ready=True  → 直接进入"选 PSD 处理"主流程
            ready=False → 弹对话框引导用户调 ps_pick_app() 手选 .app
        """
        try:
            ps_path = photoshop.detect_ps_path()
            running = photoshop.is_ps_running(ps_path) if ps_path else False
            return {"ok": True, "data": {
                "ps_path": ps_path or "",
                "ps_app_name": photoshop.app_name_from_path(ps_path) if ps_path else "",
                "ps_running": running,
                # ready 的语义：知道 PS 在哪 → 后续可以 launch/process
                "ready": bool(ps_path),
            }}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def ps_pick_app(self) -> dict[str, Any]:
        """弹原生 dialog 让用户手选 Photoshop 应用，选完后写入 settings。
        随后自动尝试启动 PS（异步），返回新的 status。
        """
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            # macOS：选 .app 包；其它平台：选可执行文件
            if platform.system() == "Darwin":
                file_types = ("Application (*.app)",)
                directory = "/Applications"
            else:
                file_types = ("Photoshop (*.exe)", "All files (*.*)")
                directory = ""

            picked = win.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=file_types,
                directory=directory,
            )
            if not picked:
                return {"ok": False, "error": "用户取消选择"}
            ps_path = picked[0]
            if not Path(ps_path).exists():
                return {"ok": False, "error": f"路径不存在：{ps_path}"}

            photoshop.remember_ps_path(ps_path)

            # 选完即顺手启动一下，避免用户还要再点一次"启动"
            launch_res = photoshop.launch_ps(ps_path)
            data = self.ps_get_status()["data"]
            data["just_launched"] = launch_res.get("ok", False)
            data["launch_error"] = launch_res.get("error", "")
            return {"ok": True, "data": data}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def ps_launch(self) -> dict[str, Any]:
        """启动 / 激活 PS（idempotent，重复调用没副作用）。"""
        try:
            ps_path = photoshop.detect_ps_path()
            if not ps_path:
                return {"ok": False, "error": "尚未配置 PS 路径，请先调 ps_pick_app"}
            res = photoshop.launch_ps(ps_path)
            if not res.get("ok"):
                return res
            return self.ps_get_status()
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    # ---- 文件选择 / PSD 处理 -----------------------------------

    def pick_psd_file(self) -> dict[str, Any]:
        """弹原生 dialog 让用户选 .psd / .psb 文件，返回真实路径（不读字节）。"""
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            picked = win.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("Photoshop files (*.psd;*.psb)",),
            )
            if not picked:
                return {"ok": False, "error": "用户取消选择"}
            path = picked[0]
            p = Path(path)
            if not p.is_file():
                return {"ok": False, "error": f"文件不存在：{path}"}
            if p.suffix.lower() not in (".psd", ".psb"):
                return {"ok": False, "error": f"非 PSD/PSB 文件：{p.suffix}"}
            return {"ok": True, "data": {
                "path": str(p),
                "name": p.name,
                "size_bytes": p.stat().st_size,
            }}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def process_psd(self, file_path: str) -> dict[str, Any]:
        """主入口：用 PS 跑 4 个 ExtendScript 脚本，返回 _clean.psd 路径。

        本调用是同步阻塞的——大 PSD 可能要 1~2 分钟，前端要做 loading 反馈。
        失败时尽量返回可读的 error 字符串。
        """
        try:
            if not isinstance(file_path, str) or not file_path:
                return {"ok": False, "error": "empty file_path"}
            ps_path = photoshop.detect_ps_path()
            if not ps_path:
                return {"ok": False, "error": "尚未配置 PS，请先调 ps_pick_app"}
            return photoshop.process_psd(file_path, ps_path)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def open_psd_in_ps(self, file_path: str) -> dict[str, Any]:
        """用 Photoshop 打开指定 PSD 文件（供人工检查用）。
        打开后 2 秒会把本 APP 窗口重新置顶。
        """
        try:
            if not isinstance(file_path, str) or not file_path:
                return {"ok": False, "error": "empty file_path"}
            ps_path = photoshop.detect_ps_path()
            if not ps_path:
                return {"ok": False, "error": "尚未配置 PS，请先调 ps_pick_app"}
            return photoshop.open_psd_in_ps(file_path, ps_path)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---- 内部工具 -------------------------------------------------------

def _get_window() -> Optional[Any]:
    """拿到当前 pywebview window 句柄。Api 实例化时 webview.windows 还是空，
    所以不能在 __init__ 里缓存——这里每次取最新的列表第一项。"""
    if not webview.windows:
        return None
    return webview.windows[0]
