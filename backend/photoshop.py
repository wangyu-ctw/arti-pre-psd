"""Photoshop 应用检测、启动、脚本调用。

目前实现 macOS 路径（osascript / open -a）；Windows 接口已占位但未实现。

调用约定：所有公开函数返回 {"ok": True/False, ...}，便于 api.py 直接转发给前端。
"""
from __future__ import annotations

import platform
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from . import settings

IS_MAC = platform.system() == "Darwin"
IS_WIN = platform.system() == "Windows"

# ExtendScript 脚本路径（按调用顺序）
_SCRIPTS_DIR = Path(__file__).parent / "psExtendScript"
SCRIPT_UNLOCK_ALL_LAYERS = _SCRIPTS_DIR / "unlockAllLayersAndGroups.jsx"
SCRIPT_UNGROUP_ARTBOARDS = _SCRIPTS_DIR / "ungroupArtboards.jsx"
SCRIPT_DELETE_EMPTY = _SCRIPTS_DIR / "Delete All Empty Layers.jsx"
SCRIPT_FLATTEN_FX = _SCRIPTS_DIR / "Flatten All Layer Effects.jsx"
SCRIPT_FLATTEN_GROUPS_WITH_FX = _SCRIPTS_DIR / "flattenGroupsWithEffects.jsx"
SCRIPT_FLATTEN_MASKS = _SCRIPTS_DIR / "Flatten All Masks.jsx"
SCRIPT_FLATTEN_CLIPPING_MASKS = _SCRIPTS_DIR / "flattenClippingMasks.jsx"
SCRIPT_DELETE_PROBLEMATIC_CLIP = _SCRIPTS_DIR / "deleteProblematicClipLayers.jsx"
SCRIPT_ORGANIZE_GROUPS = _SCRIPTS_DIR / "organizeLayerGroups.jsx"
SCRIPT_UNIQUE_LAYER_NAMES = _SCRIPTS_DIR / "uniqueLayerNames.jsx"
SCRIPT_TRIM_TO_CANVAS = _SCRIPTS_DIR / "trimLayersToCanvas.jsx"
SCRIPT_SAVE_AS_CLEAN = _SCRIPTS_DIR / "saveAsClean.jsx"

# Photoshop 在所有版本里共享同一个 CFBundleIdentifier；用它做 AppleScript
# `tell application id "..."` 比按应用名靠谱：
#   - 应用显示名 (CFBundleDisplayName) "Adobe Photoshop 2026" 跟 AppleScript
#     用的 CFBundleName "Photoshop 2026" 不一致（实测 v2026），按 .app 文件名
#     猜的应用名 "Adobe Photoshop 2026" 会被 LaunchServices 拒绝。
#   - 不同 PS 版本 / 不同系统语言下 CFBundleName 可能再变。
#   - 而 bundle id 自 Adobe 历史以来一直是 "com.adobe.Photoshop"。
PS_BUNDLE_ID = "com.adobe.Photoshop"

# PS 处理大文件偶尔很慢；超时给宽松一点（10min）
_PROCESS_TIMEOUT_SEC = 600

# 处理步骤列表：(显示名称, jsx脚本路径)
_PROCESS_STEPS: list[tuple[str, Path]] = [
    ("1. Ungroup Artboards",               SCRIPT_UNGROUP_ARTBOARDS),
    ("2. Delete All Empty Layers",         SCRIPT_DELETE_EMPTY),
    ("3. Unlock All Locked Layers/Groups", SCRIPT_UNLOCK_ALL_LAYERS),
    ("4. Flatten All Layer Effects",       SCRIPT_FLATTEN_FX),
    ("5. Flatten Groups With Effects",     SCRIPT_FLATTEN_GROUPS_WITH_FX),
    ("6. Flatten All Masks",               SCRIPT_FLATTEN_MASKS),
    ("7. Flatten Clipping Masks",          SCRIPT_FLATTEN_CLIPPING_MASKS),
    ("8. Trim Layers To Canvas",           SCRIPT_TRIM_TO_CANVAS),
    ("2b. Delete All Empty Layers (再跑)", SCRIPT_DELETE_EMPTY),
    ("9. Organize Layer Groups",           SCRIPT_ORGANIZE_GROUPS),
    ("10. Unique Layer Names",              SCRIPT_UNIQUE_LAYER_NAMES),
]


# ---- 检测 -----------------------------------------------------------

def _candidate_mac_apps() -> list[Path]:
    """扫 /Applications 下所有 'Adobe Photoshop *.app'，按文件名升序返回。

    例：[".../Adobe Photoshop 2024/Adobe Photoshop 2024.app",
         ".../Adobe Photoshop 2026/Adobe Photoshop 2026.app"]
    """
    apps_dir = Path("/Applications")
    if not apps_dir.is_dir():
        return []
    # Photoshop 安装目录形如 "Adobe Photoshop YYYY"，里面有 "Adobe Photoshop YYYY.app"
    return sorted(apps_dir.glob("Adobe Photoshop*/Adobe Photoshop*.app"))


def detect_ps_path() -> Optional[str]:
    """按优先级返回 PS 应用路径：
       1. settings 里用户上次选过的（且文件还存在）
       2. /Applications 自动扫描（取版本号最大的）
       3. None（让前端引导用户手选）
    """
    saved = settings.get(settings.KEY_PS_APP_PATH)
    if saved and Path(saved).exists():
        return str(saved)
    if IS_MAC:
        candidates = _candidate_mac_apps()
        if candidates:
            return str(candidates[-1])
    # TODO Windows: 扫 HKEY_LOCAL_MACHINE\SOFTWARE\Adobe\Photoshop\<ver>\ApplicationPath
    return None


def app_name_from_path(ps_path: str) -> str:
    """从 .app 路径推导出 AppleScript / pgrep 用的应用名（去掉 .app 后缀）。"""
    return Path(ps_path).stem  # ".../Adobe Photoshop 2026.app" → "Adobe Photoshop 2026"


def is_ps_running(ps_path: Optional[str] = None) -> bool:
    """PS 是否已在运行。"""
    if not IS_MAC:
        return False
    app_name = app_name_from_path(ps_path) if ps_path else "Adobe Photoshop"
    try:
        # pgrep -f 模糊匹配进程 cmdline；PS 的进程名一般包含 "Adobe Photoshop YYYY"
        r = subprocess.run(
            ["pgrep", "-f", app_name],
            capture_output=True, text=True, timeout=3,
        )
        return r.returncode == 0
    except Exception:
        return False


# ---- 启动 -----------------------------------------------------------

def launch_ps(ps_path: str) -> dict[str, Any]:
    """异步打开 PS（不阻塞）。已在运行时再 open 一次也只是激活窗口。"""
    if not IS_MAC:
        return {"ok": False, "error": "目前仅 macOS 实现了 PS 启动"}
    if not Path(ps_path).exists():
        return {"ok": False, "error": f"应用不存在：{ps_path}"}
    try:
        # -a 按应用名 / 路径打开；不加 -W 不阻塞等待退出
        r = subprocess.run(
            ["open", "-a", ps_path],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip() or f"open exit={r.returncode}"
            return {"ok": False, "error": err}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def remember_ps_path(ps_path: str) -> None:
    """把用户选择的 PS 路径写入 settings，下次启动直接用。"""
    settings.put(settings.KEY_PS_APP_PATH, str(ps_path))


# ---- 脚本调用 -------------------------------------------------------

def _quote_for_applescript(s: str) -> str:
    """转义 AppleScript 字符串里的反斜杠和双引号。"""
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _js_activate_document_by_posix_path(posix_path: str) -> str:
    """ExtendScript 源码：在已打开的文档里按磁盘绝对路径激活目标文档（单行）。"""
    p = posix_path.replace("\\", "\\\\").replace('"', '\\"')
    return (
        "(function(){"
        'var p="' + p + '";'
        "var f=new File(p);"
        "for(var i=0;i<app.documents.length;i++){"
        "var d=app.documents[i];"
        "try{"
        "if(d.fullName&&d.fullName.fsName===f.fsName){"
        "app.activeDocument=d;return\"ok\";"
        "}"
        "}catch(e0){}"
        "}"
        'throw new Error("no matching open document: "+p);'
        "})();"
    )


def _as_wait_for_doc(input_file_name: str, *, posix_path: Optional[str] = None) -> str:
    """AppleScript：等待 PS 加载目标文档，并把 dialog mode 设为 NO。"""
    q = _quote_for_applescript
    if posix_path:
        jsx_activate = q(_js_activate_document_by_posix_path(posix_path))
        return (
            f'set jsxActivate to "{jsx_activate}"\n'
            f'tell application id "{PS_BUNDLE_ID}"\n'
            '    set ready to false\n'
            '    repeat 120 times\n'
            '        try\n'
            '            if (count of documents) > 0 then\n'
            '                do javascript jsxActivate\n'
            '                set ready to true\n'
            '                exit repeat\n'
            '            end if\n'
            '        end try\n'
            '        delay 0.5\n'
            '    end repeat\n'
            '    if ready is false then error "等待 Photoshop 中匹配路径的文档就绪超时（60s）"\n'
            '    do javascript "app.displayDialogs = DialogModes.NO;"\n'
            'end tell\n'
        )
    else:
        return (
            f'set targetName to "{q(input_file_name)}"\n'
            f'tell application id "{PS_BUNDLE_ID}"\n'
            '    set ready to false\n'
            '    repeat 60 times\n'
            '        try\n'
            '            if (count of documents) > 0 then\n'
            '                if name of front document is targetName then\n'
            '                    set ready to true\n'
            '                    exit repeat\n'
            '                end if\n'
            '            end if\n'
            '        end try\n'
            '        delay 0.5\n'
            '    end repeat\n'
            '    if ready is false then error "等待 Photoshop 加载文件超时（30s）"\n'
            '    do javascript "app.displayDialogs = DialogModes.NO;"\n'
            'end tell\n'
        )


def _as_run_jsx(jsx_path: Path) -> str:
    """AppleScript：在 PS 当前 active document 上执行单个 JSX 文件。"""
    q = _quote_for_applescript
    return (
        f'set jsxFile to POSIX file "{q(str(jsx_path))}" as alias\n'
        'set jsxText to read jsxFile as «class utf8»\n'
        f'tell application id "{PS_BUNDLE_ID}"\n'
        '    do javascript jsxText\n'
        'end tell\n'
    )


def _as_save_and_close() -> str:
    """AppleScript：运行 saveAsClean.jsx，关闭文档，恢复 dialog mode，返回输出路径。"""
    q = _quote_for_applescript
    return (
        f'set jsxSaveFile to POSIX file "{q(str(SCRIPT_SAVE_AS_CLEAN))}" as alias\n'
        'set jsxSaveText to read jsxSaveFile as «class utf8»\n'
        f'tell application id "{PS_BUNDLE_ID}"\n'
        '    set savedPath to (do javascript jsxSaveText)\n'
        '    close current document saving no\n'
        '    try\n'
        '        do javascript "app.displayDialogs = DialogModes.ALL;"\n'
        '    end try\n'
        '    return savedPath\n'
        'end tell\n'
    )


def _run_osascript(script: str, timeout: int = 120) -> tuple[bool, str]:
    """执行一段 AppleScript，返回 (ok, output_or_error)。"""
    try:
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=timeout,
        )
        if r.returncode != 0:
            return False, (r.stderr or r.stdout).strip() or f"osascript exit={r.returncode}"
        return True, r.stdout.strip()
    except subprocess.TimeoutExpired:
        return False, f"osascript 超时（>{timeout}s）"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def open_psd_files_for_queue(paths: list[str], ps_path: str) -> dict[str, Any]:
    """队列开始前：用 LaunchServices 依次在 Photoshop 中打开多个 PSD（不阻塞 PS 加载）。

    与 `process_psd(..., skip_open=True)` 配合：处理某一文件时再用 ExtendScript
    按绝对路径激活对应文档，避免多文档时 front document 不是目标文件。
    """
    if not IS_MAC:
        return {"ok": False, "error": "目前仅 macOS 实现了 PSD 处理"}
    if not paths:
        return {"ok": False, "error": "empty paths"}
    if not Path(ps_path).exists():
        return {"ok": False, "error": f"Photoshop 应用不存在：{ps_path}"}

    for raw in paths:
        src = Path(str(raw)).expanduser().resolve()
        if not src.is_file():
            return {"ok": False, "error": f"文件不存在：{src}"}
        if src.suffix.lower() != ".psd":
            return {"ok": False, "error": f"非 .psd 文件：{src}"}
        try:
            open_res = subprocess.run(
                ["open", "-g", "-a", ps_path, str(src)],
                capture_output=True, text=True, timeout=15,
            )
            if open_res.returncode != 0:
                err = (open_res.stderr or open_res.stdout).strip() or "open 命令非零退出"
                return {"ok": False, "error": f"无法在 Photoshop 中打开：{src.name}（{err}）"}
        except Exception as e:
            return {"ok": False, "error": f"打开 {src.name} 失败：{type(e).__name__}: {e}"}
        time.sleep(0.12)

    return {"ok": True, "data": {"count": len(paths)}}


def process_psd(input_path: str, ps_path: str, *, skip_open: bool = False) -> dict[str, Any]:
    """主流程（仅 macOS）：

      1. 默认：用 `open -g -a PS_PATH FILE` 把 PSD 交给 PS。
         skip_open=True：假定文件已由 `open_psd_files_for_queue` 打开，本步不再 open。
      2. 等待 PS 加载目标文档（独立 osascript 调用）。
      3. 逐步执行各 jsx 脚本，每步前后打印日志（独立 osascript 调用，实时日志）。
      4. 运行 saveAsClean + 关闭文档，返回输出路径。
    """
    if not IS_MAC:
        return {"ok": False, "error": "目前仅 macOS 实现了 PSD 处理"}
    src = Path(input_path).expanduser().resolve()
    if not src.is_file():
        return {"ok": False, "error": f"文件不存在：{src}"}
    if src.suffix.lower() != ".psd":
        return {"ok": False, "error": f"非 .psd 文件：{src}"}
    if not Path(ps_path).exists():
        return {"ok": False, "error": f"Photoshop 应用不存在：{ps_path}"}

    # 检查所有脚本文件都存在
    all_scripts = [p for _, p in _PROCESS_STEPS] + [SCRIPT_SAVE_AS_CLEAN]
    for script in dict.fromkeys(all_scripts):  # 去重保序
        if not script.is_file():
            return {"ok": False, "error": f"脚本缺失：{script.name}"}

    # 1. LaunchServices 打开（队列模式由 open_psd_files_for_queue 预先批量打开）
    if not skip_open:
        try:
            open_res = subprocess.run(
                ["open", "-g", "-a", ps_path, str(src)],
                capture_output=True, text=True, timeout=15,
            )
            if open_res.returncode != 0:
                err = (open_res.stderr or open_res.stdout).strip() or "open 命令非零退出"
                return {"ok": False, "error": f"无法把 PSD 交给 Photoshop：{err}"}
        except Exception as e:
            return {"ok": False, "error": f"启动 open 命令失败：{type(e).__name__}: {e}"}

    # 2. 等待 PS 加载目标文档 + 设 dialog mode NO
    print(f"[PS] 等待文档就绪: {src.name}", flush=True)
    ok, err = _run_osascript(
        _as_wait_for_doc(src.name, posix_path=str(src) if skip_open else None),
        timeout=90,
    )
    if not ok:
        return {"ok": False, "error": f"等待文档失败：{err}"}

    # 3. 逐步执行各 jsx（每步独立 osascript 调用，实时打印日志）
    step_errors: list[str] = []
    for label, jsx_path in _PROCESS_STEPS:
        print(f"[PS step] {label}", flush=True)
        ok, result = _run_osascript(_as_run_jsx(jsx_path), timeout=300)
        if not ok:
            msg = f"[{label}] {result}"
            print(f"[PS step ERROR] {msg}", flush=True)
            step_errors.append(msg)

    # 4. 保存 + 关闭文档
    print("[PS] 保存输出文件...", flush=True)
    ok, out_path = _run_osascript(_as_save_and_close(), timeout=120)
    if not ok:
        error_log = "\n".join(step_errors)
        suffix = f"\n步骤错误日志：\n{error_log}" if error_log else ""
        return {"ok": False, "error": f"saveAsClean 失败：{out_path}{suffix}"}

    if not out_path or not Path(out_path).exists():
        error_log = "\n".join(step_errors)
        suffix = f"\n步骤错误日志：\n{error_log}" if error_log else ""
        return {"ok": False, "error": f"输出文件不存在：{out_path}{suffix}"}

    print(f"[PS] 完成: {out_path}", flush=True)

    # 单次 open+处理：结束时把本 APP 置顶。队列模式（skip_open=True）不在此抢焦点，
    # 由前端在整批 process_psd 全部结束后再调 activate_app_window / focus_app。
    if not skip_open:
        _activate_self()

    return {"ok": True, "data": {
        "path": out_path,
        "directory": str(Path(out_path).parent),
        "size_bytes": Path(out_path).stat().st_size,
        "step_errors": "\n".join(step_errors),
    }}


def activate_app_window() -> None:
    """把本应用窗口置顶（供队列整批完成后由 API 显式调用，或与单次 process_psd 内逻辑一致）。"""
    _activate_self()


def _activate_self() -> None:
    """把本 APP 窗口置顶（在后台线程中延迟执行，避免被 PS 的异步激活覆盖）。"""
    import os
    import threading
    import time

    pid = os.getpid()

    def _do():
        time.sleep(1)
        if IS_MAC:
            try:
                subprocess.run(
                    [
                        "osascript", "-e",
                        f'tell application "System Events" to set frontmost of'
                        f' (first process whose unix id is {pid}) to true',
                    ],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass
        try:
            import webview
            if webview.windows:
                win = webview.windows[0]
                if hasattr(win, "bring_to_front"):
                    win.bring_to_front()
        except Exception:
            pass

    threading.Thread(target=_do, daemon=True).start()


def open_psd_in_ps(file_path: str, ps_path: str) -> dict[str, Any]:
    """用 Photoshop 打开指定 PSD 文件（供人工检查用）。"""
    try:
        r = subprocess.run(
            ["open", "-g", "-a", ps_path, file_path],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip() or "open 命令非零退出"
            return {"ok": False, "error": err}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return {"ok": True, "data": {}}
