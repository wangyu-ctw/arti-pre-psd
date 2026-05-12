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

    def pick_psd_files(self) -> dict[str, Any]:
        """弹原生 dialog 让用户多选 .psd / .psb 文件，返回路径数组。"""
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            picked = win.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=True,
                file_types=("Photoshop files (*.psd;*.psb)",),
            )
            if not picked:
                return {"ok": False, "error": "用户取消选择"}

            items: list[dict[str, Any]] = []
            for path in picked:
                p = Path(path)
                if not p.is_file():
                    return {"ok": False, "error": f"文件不存在：{path}"}
                if p.suffix.lower() not in (".psd", ".psb"):
                    return {"ok": False, "error": f"非 PSD/PSB 文件：{p.suffix}"}
                items.append({
                    "path": str(p),
                    "name": p.name,
                    "size_bytes": p.stat().st_size,
                })
            return {"ok": True, "data": items}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def pick_and_read_csv(self) -> dict[str, Any]:
        """弹原生 dialog 让用户选 .csv 文件，读取内容后以字符串返回。"""
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            picked = win.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("CSV files (*.csv)",),
            )
            if not picked:
                return {"ok": False, "error": "用户取消选择"}
            p = Path(picked[0])
            if not p.is_file():
                return {"ok": False, "error": f"文件不存在：{picked[0]}"}
            # 优先 utf-8-sig（带 BOM），回退 gbk
            try:
                content = p.read_text(encoding="utf-8-sig")
            except UnicodeDecodeError:
                content = p.read_text(encoding="gbk", errors="replace")
            return {"ok": True, "data": {"content": content, "name": p.name}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def pick_folder(self) -> dict[str, Any]:
        """弹原生 dialog 让用户选文件夹，返回路径。"""
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}
            picked = win.create_file_dialog(webview.FOLDER_DIALOG)
            if not picked:
                return {"ok": False, "error": "用户取消选择"}
            p = Path(picked[0])
            return {"ok": True, "data": {"path": str(p)}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def read_images_from_folder(self, folder_path: str, filenames: list) -> dict[str, Any]:
        """从指定文件夹读取图片列表，返回 {filename: base64_string} 字典。"""
        import base64
        try:
            folder = Path(folder_path)
            result: dict[str, str] = {}
            for fname in filenames:
                if not fname:
                    continue
                p = folder / fname
                if p.is_file():
                    result[fname] = base64.b64encode(p.read_bytes()).decode("ascii")
            return {"ok": True, "data": result}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def save_asset_file(self, folder_path: str, filename: str, data_url: str) -> dict[str, Any]:
        """将 base64 data URL 直接覆盖写入指定文件夹的文件（无弹框，供裁切覆盖原图使用）。"""
        import base64
        try:
            if "," in data_url:
                data_url = data_url.split(",", 1)[1]
            p = Path(folder_path) / filename
            p.write_bytes(base64.b64decode(data_url))
            return {"ok": True, "data": {"path": str(p)}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def save_image_base64(self, data_url: str, suggested_name: str) -> dict[str, Any]:
        """将 canvas.toDataURL 返回的 base64 PNG 保存为文件（弹原生 Save 对话框）。"""
        import base64
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}
            saved = win.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("PNG files (*.png)",),
            )
            if not saved:
                return {"ok": False, "error": "用户取消"}
            save_path = saved if isinstance(saved, str) else saved[0]
            if "," in data_url:
                data_url = data_url.split(",", 1)[1]
            Path(save_path).write_bytes(base64.b64decode(data_url))
            return {"ok": True, "data": {"path": save_path}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def pick_psd_only_file(self) -> dict[str, Any]:
        """弹原生 dialog，仅可选 .psd（不含 .psb），返回真实路径。"""
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            picked = win.create_file_dialog(
                webview.OPEN_DIALOG,
                allow_multiple=False,
                file_types=("PSD (*.psd)",),
            )
            if not picked:
                return {"ok": False, "error": "用户取消选择"}
            path = picked[0]
            p = Path(path)
            if not p.is_file():
                return {"ok": False, "error": f"文件不存在：{path}"}
            if p.suffix.lower() != ".psd":
                return {"ok": False, "error": f"仅支持 .psd 文件：{p.suffix}"}
            return {"ok": True, "data": {
                "path": str(p),
                "name": p.name,
                "size_bytes": p.stat().st_size,
            }}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def focus_app(self) -> dict[str, Any]:
        """将本应用窗口置顶（不操作 PS）。用于 PSD 队列全部处理完后再抢焦点。"""
        try:
            photoshop.activate_app_window()
            return {"ok": True, "data": {}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def open_psd_queue(self, paths: list[Any]) -> dict[str, Any]:
        """队列处理前：在 Photoshop 中依次打开 paths 里的所有 PSD（不跑清洗脚本）。"""
        try:
            if not isinstance(paths, list) or not paths:
                return {"ok": False, "error": "paths 必须为非空数组"}
            norm = [str(p) for p in paths if isinstance(p, str) and p.strip()]
            if not norm:
                return {"ok": False, "error": "paths 中无有效路径字符串"}
            ps_path = photoshop.detect_ps_path()
            if not ps_path:
                return {"ok": False, "error": "尚未配置 PS，请先调 ps_pick_app"}
            return photoshop.open_psd_files_for_queue(norm, ps_path)
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def process_psd(self, file_path: str, skip_open: bool = False) -> dict[str, Any]:
        """主入口：用 PS 按顺序跑多个 ExtendScript 脚本，返回 _clean.psd 路径。

        本调用是同步阻塞的——大 PSD 可能要 1~2 分钟，前端要做 loading 反馈。
        失败时尽量返回可读的 error 字符串。

        skip_open=True：假定该文件已由 open_psd_queue 打开，本调用不再执行 open，
        仅在已打开文档中按绝对路径激活后跑脚本（供批量队列串行处理）。
        """
        try:
            if not isinstance(file_path, str) or not file_path:
                return {"ok": False, "error": "empty file_path"}
            ps_path = photoshop.detect_ps_path()
            if not ps_path:
                return {"ok": False, "error": "尚未配置 PS，请先调 ps_pick_app"}
            return photoshop.process_psd(file_path, ps_path, skip_open=bool(skip_open))
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

    def save_csv(self, content: str, suggested_name: str) -> dict[str, Any]:
        """弹原生 Save 对话框，将 CSV 内容写入用户选择的路径。
        使用 utf-8-sig 编码（自动加 BOM），Excel 打开中文不乱码。
        """
        try:
            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            saved = win.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("CSV files (*.csv)", "All files (*.*)"),
            )
            if not saved:
                return {"ok": False, "error": "用户取消"}

            save_path = saved if isinstance(saved, str) else saved[0]
            Path(save_path).write_text(content, encoding="utf-8-sig")
            return {"ok": True, "data": {"path": save_path}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def save_zip(self, layer_states_json: str, suggested_name: str) -> dict[str, Any]:
        """弹原生 Save 对话框，将 CSV（含 layer_asset 列）、PSD 和图层切片打包为 ZIP。
        layer_states_json: 前端 annotatorStore.layerStates 序列化的 JSON 字符串。
        ZIP 结构：{name}.csv / {name}.psd / assets/*.png
        """
        try:
            import io as _io
            import json as _json
            import zipfile

            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}

            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            saved = win.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name + ".zip",
                file_types=("ZIP files (*.zip)", "All files (*.*)"),
            )
            if not saved:
                return {"ok": False, "error": "用户取消"}

            save_path = saved if isinstance(saved, str) else saved[0]
            base_name = Path(save_path).stem

            layer_states: dict = _json.loads(layer_states_json) if layer_states_json else {}
            csv_content, slices = session.build_export_package(layer_states)
            psd_bytes = session.get_psd_bytes()

            zip_buf = _io.BytesIO()
            with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                zf.writestr(base_name + ".csv", csv_content.encode("utf-8-sig"))
                zf.writestr(base_name + ".psd", psd_bytes)
                for filename, png_bytes in slices:
                    zf.writestr(f"assets/{filename}", png_bytes)

            Path(save_path).write_bytes(zip_buf.getvalue())
            return {"ok": True, "data": {"path": save_path}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def close_psd_session(self) -> dict[str, Any]:
        """释放内存中的 PSD 会话，使 PSDImage 对象可被 GC 回收。
        在前端关闭/切换标注文件时调用。
        """
        try:
            from . import psd_session
            psd_session.close()
            return {"ok": True, "data": {}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def load_psd_session(self, file_path: str) -> dict[str, Any]:
        """加载 PSD 文件并初始化内存会话。

        除返回与 get_psd_info 相同的图层树和缩略图外，还将 PSD 保留在内存中，
        供后续结构性操作（删除/解散/合并）使用，并通过 psd_undo / psd_save_as
        管理版本回退和最终保存。
        返回值比 get_psd_info 多一个 undoCount 字段（初始为 0）。
        """
        try:
            from . import psd_session

            if not isinstance(file_path, str) or not file_path:
                return {"ok": False, "error": "empty file_path"}
            if not Path(file_path).is_file():
                return {"ok": False, "error": f"文件不存在：{file_path}"}

            session = psd_session.load(file_path)
            return {"ok": True, "data": session._result()}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_delete_nodes(self, ids: list[str]) -> dict[str, Any]:
        """从当前会话中删除指定图层节点（含后代），返回更新后的树和缩略图。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}
            return {"ok": True, "data": session.delete_nodes(ids)}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_ungroup(self, ids: list[str]) -> dict[str, Any]:
        """解散指定图层组，将其子节点上移一级，返回更新后的树和缩略图。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}
            return {"ok": True, "data": session.ungroup(ids)}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_merge_group(self, node_id: str) -> dict[str, Any]:
        """合并图层组（简化版：移除子节点，组变为叶节点），返回更新后的树和缩略图。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}
            return {"ok": True, "data": session.merge_group(node_id)}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_merge_to_layer(self, ids: list[str], layer_name: str = "合并图层") -> dict[str, Any]:
        """将选中的多个节点合并为单一叶节点，边界框为所有节点的并集。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}
            return {"ok": True, "data": session.merge_nodes_to_layer(ids, layer_name)}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_get_layer_preview(self, sid: int) -> dict[str, Any]:
        """合成单个图层/图层组的预览图，返回 base64 PNG 及其位置信息。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}
            result = session.get_layer_preview(sid)
            if "error" in result:
                return {"ok": False, "error": result["error"]}
            return {"ok": True, "data": result}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_undo(self) -> dict[str, Any]:
        """回退 PSD 上一步结构性操作（删除/解散/合并），返回回退后的树和缩略图。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话"}
            result = session.undo()
            if result is None:
                return {"ok": False, "error": "已无历史可回退"}
            return {"ok": True, "data": result}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_trim_history(self, keep_count: int) -> dict[str, Any]:
        """将后端 PSD 历史栈裁剪到 keep_count 条（释放多余的 BytesIO 快照内存）。
        前端 undo history 超出 MAX_HISTORY 而丢弃旧 PSD 步骤时应调用此接口。
        """
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": True}  # 无会话时静默成功
            session.trim_history(keep_count)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def psd_save_as(self, suggested_name: str) -> dict[str, Any]:
        """弹原生 Save 对话框，将当前 PSD 状态（含已删除图层的 visible 修改）写出为新文件。"""
        try:
            from . import psd_session

            session = psd_session.get_session()
            if session is None:
                return {"ok": False, "error": "无活动会话，请先调用 load_psd_session"}

            win = _get_window()
            if win is None:
                return {"ok": False, "error": "pywebview window 未就绪"}

            saved = win.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=suggested_name,
                file_types=("PSD files (*.psd)", "All files (*.*)"),
            )
            if not saved:
                return {"ok": False, "error": "用户取消"}

            save_path = saved if isinstance(saved, str) else saved[0]
            session.save_as(save_path)
            return {"ok": True, "data": {"path": save_path}}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def get_psd_info(self, file_path: str) -> dict[str, Any]:
        """解析 PSD 文件，返回原尺寸合成缩略图（base64 PNG）和完整图层树。

        图层树每个节点：id, name, x, y, width, height, visible, is_group, children。
        id 使用节点在树中的唯一路径字符串，保证前端可安全用作 key。
        """
        try:
            import base64
            import io

            from psd_tools import PSDImage
            from psd_tools.api.layers import Group

            if not isinstance(file_path, str) or not file_path:
                return {"ok": False, "error": "empty file_path"}
            if not Path(file_path).is_file():
                return {"ok": False, "error": f"文件不存在：{file_path}"}

            psd = PSDImage.open(file_path)

            # 合成缩略图（原尺寸，不缩放）
            composite = psd.composite()
            buf = io.BytesIO()
            composite.save(buf, format="PNG")
            thumbnail_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

            def _extract(layers: Any, prefix: str) -> list[dict[str, Any]]:
                result: list[dict[str, Any]] = []
                for idx, layer in enumerate(layers):
                    node_id = f"{prefix}/{idx}_{layer.name}"
                    is_group = isinstance(layer, Group)
                    left, top, right, bottom = int(layer.left), int(layer.top), int(layer.right), int(layer.bottom)
                    node: dict[str, Any] = {
                        "id": node_id,
                        "name": layer.name,
                        "x": left,
                        "y": top,
                        "width": right - left,
                        "height": bottom - top,
                        "visible": bool(layer.visible),
                        "isGroup": is_group,
                    }
                    if is_group:
                        node["children"] = _extract(layer, node_id)
                    result.append(node)
                return result

            layers = _extract(psd, "root")

            return {"ok": True, "data": {
                "thumbnailB64": thumbnail_b64,
                "psdWidth": psd.width,
                "psdHeight": psd.height,
                "layers": layers,
            }}
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---- 内部工具 -------------------------------------------------------

def _get_window() -> Optional[Any]:
    """拿到当前 pywebview window 句柄。Api 实例化时 webview.windows 还是空，
    所以不能在 __init__ 里缓存——这里每次取最新的列表第一项。"""
    if not webview.windows:
        return None
    return webview.windows[0]
