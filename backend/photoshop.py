"""Photoshop 应用检测、启动、脚本调用。

目前实现 macOS 路径（osascript / open -a）；Windows 接口已占位但未实现。

调用约定：所有公开函数返回 {"ok": True/False, ...}，便于 api.py 直接转发给前端。
"""
from __future__ import annotations

import platform
import subprocess
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


def _build_process_applescript(input_file_name: str) -> str:
    """生成处理流程的 AppleScript（PSD 已经被 `open -a` 推给 PS 了，这里只做后续）：

       等 PS 把目标文件加载到 front document → 按顺序跑多个 .jsx → 关闭原文档
       （不保存）→ return _clean.psd 路径。

       saveAsClean.jsx 末尾 IIFE return outFile.fsName，所以最后一步
       `do javascript` 的返回值就是清洗后文件的绝对路径。

    为什么这里**不**让 AppleScript 自己 `open` 文件：
      - osascript 进程里 `POSIX file "..." as alias` 解析出的 alias 包含
        进程自身 context 的引用 token；通过 Apple Event 跨进程交给 PS 时，
        PS 用自己的 TCC / 权限上下文去重新解析这个 token，会失败报
        `-43 fnfErr`（即"找不到文件 某个对象"）。
      - 等价地用户在 Finder 双击 PSD 时是走 LaunchServices 的 odoc 事件，
        那条路径是 macOS 文件系统级标准入口，跨进程权限边界一律 work。
      - 所以让 Python subprocess 直接 `open -g -a PS_PATH FILE`，把活儿交给
        LaunchServices；AppleScript 这里只负责"等待已加载 + 跑脚本"。

    为什么 jsx 也**不**直接传 alias / file 给 `do javascript`：
      - 实测同样的跨进程问题：PS 拿到 alias 后会把它 coerce 成 text，结果是
        "alias Macintosh HD:..."字面量，被当成 javascript 源码 evaluate，
        立刻报 PS 错误码 8800（generalPhotoshopError）"<没有其它信息可用>"。
      - 改成在 osascript 进程内用 `read ... as «class utf8»` 把 .jsx 内容
        读成 UTF-8 字符串，再以"javascript text"形式传给 PS——纯字符串
        跨 Apple Event 100% 安全。

    每个清洗步骤都包 try / on error 让单步出错不中断整体流程；错误信息
    收集到 errorLog 一并回传。最后一步 saveAsClean 是关键路径——它必须
    成功，否则我们拿不到输出文件路径，整个流程算失败（不包 try）。

    返回值约定（osascript stdout）：
      - 全部成功：单行的输出文件绝对路径。
      - 有 step 出错：第 1 行 = 输出路径，之后 "===ERRORS===" 标记，
        后续行 = 每行一个失败步骤的 [step] errMsg。Python 端按这个结构
        拆分两段。
    """
    q = _quote_for_applescript
    # 每个步骤打包成 (label, jsxVarName)。AppleScript 里逐个 try/on error。
    steps = [
        ("0. Unlock All Locked Layers/Groups", "jsxUnlockAllText"),
        ("1. Ungroup Artboards", "jsxUngroupArtboardsText"),
        ("2. Delete All Empty Layers", "jsxDeleteText"),
        ("3. Flatten All Layer Effects", "jsxFxText"),
        ("4. Flatten Groups With Effects", "jsxFlattenGroupsText"),
        ("5. Flatten All Masks", "jsxMasksText"),
        ("6. Flatten Clipping Masks", "jsxClippingText"),
        ("6b. Delete Non-Normal / Adjustment Clip Layers", "jsxDelProblematicClipText"),
        ("6c. Flatten Clipping Masks (再跑)", "jsxClippingText"),
        ("7. Trim Layers To Canvas", "jsxTrimText"),
        ("2b. Delete All Empty Layers (再跑)", "jsxDeleteText"),
        ("8. Organize Layer Groups", "jsxOrganizeGroupsText"),
        ("9. Unique Layer Names", "jsxUniqueNamesText"),
    ]
    step_blocks = []
    for label, var in steps:
        step_blocks.append(
            '    try\n'
            f'        do javascript {var}\n'
            '    on error errMsg\n'
            f'        set errorLog to errorLog & "[{q(label)}] " & errMsg & linefeed\n'
            '    end try\n'
        )

    return (
        # 先在 osascript 进程内把各 jsx 读成 UTF-8 字符串（read 是 StandardAdditions）
        f'set jsxUnlockAllFile to POSIX file "{q(str(SCRIPT_UNLOCK_ALL_LAYERS))}" as alias\n'
        f'set jsxUngroupArtboardsFile to POSIX file "{q(str(SCRIPT_UNGROUP_ARTBOARDS))}" as alias\n'
        f'set jsxDeleteFile to POSIX file "{q(str(SCRIPT_DELETE_EMPTY))}" as alias\n'
        f'set jsxFxFile to POSIX file "{q(str(SCRIPT_FLATTEN_FX))}" as alias\n'
        f'set jsxFlattenGroupsFile to POSIX file "{q(str(SCRIPT_FLATTEN_GROUPS_WITH_FX))}" as alias\n'
        f'set jsxMasksFile to POSIX file "{q(str(SCRIPT_FLATTEN_MASKS))}" as alias\n'
        f'set jsxClippingFile to POSIX file "{q(str(SCRIPT_FLATTEN_CLIPPING_MASKS))}" as alias\n'
        f'set jsxDelProblematicClipFile to POSIX file "{q(str(SCRIPT_DELETE_PROBLEMATIC_CLIP))}" as alias\n'
        f'set jsxOrganizeGroupsFile to POSIX file "{q(str(SCRIPT_ORGANIZE_GROUPS))}" as alias\n'
        f'set jsxUniqueNamesFile to POSIX file "{q(str(SCRIPT_UNIQUE_LAYER_NAMES))}" as alias\n'
        f'set jsxTrimFile to POSIX file "{q(str(SCRIPT_TRIM_TO_CANVAS))}" as alias\n'
        f'set jsxSaveFile to POSIX file "{q(str(SCRIPT_SAVE_AS_CLEAN))}" as alias\n'
        'set jsxUnlockAllText to read jsxUnlockAllFile as «class utf8»\n'
        'set jsxUngroupArtboardsText to read jsxUngroupArtboardsFile as «class utf8»\n'
        'set jsxDeleteText to read jsxDeleteFile as «class utf8»\n'
        'set jsxFxText to read jsxFxFile as «class utf8»\n'
        'set jsxFlattenGroupsText to read jsxFlattenGroupsFile as «class utf8»\n'
        'set jsxMasksText to read jsxMasksFile as «class utf8»\n'
        'set jsxClippingText to read jsxClippingFile as «class utf8»\n'
        'set jsxDelProblematicClipText to read jsxDelProblematicClipFile as «class utf8»\n'
        'set jsxOrganizeGroupsText to read jsxOrganizeGroupsFile as «class utf8»\n'
        'set jsxUniqueNamesText to read jsxUniqueNamesFile as «class utf8»\n'
        'set jsxTrimText to read jsxTrimFile as «class utf8»\n'
        'set jsxSaveText to read jsxSaveFile as «class utf8»\n'
        f'set targetName to "{q(input_file_name)}"\n'
        'set errorLog to ""\n'
        f'tell application id "{PS_BUNDLE_ID}"\n'
        # 不 activate：避免批量处理时反复把 PS 拉到最前抢焦点；tell + do javascript 仍可对已响应的 PS 执行。
        # 文件由前一步 `open -a PS FILE` 打开（该步可能短暂切到 PS，属预期）。
        # 等 PS 把目标文件加载到 front document（PS 启动 + 大 PSD 加载耗时）
        # 60 次 × 0.5s = 30s 兜底；正常 1~10s 内会就绪
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
        # 把 PS 的 dialog mode 设为 NO：所有"命令当前不可用" / "另存为覆盖确认"
        # / "关闭未保存文档警告"等 modal 弹窗都会被抑制，转而抛 JS 异常或直接
        # 走 saneДefault 行为。否则 PS 弹窗时整个 osascript 会被卡住等点确定。
        # 必须**整段流程**（含 saveAsClean 和 close）都在 NO 模式下，否则 saveAs
        # / close 会触发新弹窗。流程末尾才恢复 ALL。
        '    try\n'
        '        do javascript "app.displayDialogs = DialogModes.NO;"\n'
        '    end try\n'
        + ''.join(step_blocks) +
        # saveAsClean 是关键路径：它必须成功，否则拿不到输出文件路径
        '    set savedPath to (do javascript jsxSaveText)\n'
        '    close current document saving no\n'
        # 流程末尾恢复 dialog mode 为 ALL（PS 默认值），避免污染用户后续手动操作
        '    try\n'
        '        do javascript "app.displayDialogs = DialogModes.ALL;"\n'
        '    end try\n'
        # 用 "===ERRORS===" 分隔输出路径和错误日志，便于 Python 拆分
        '    if errorLog is "" then\n'
        '        return savedPath\n'
        '    else\n'
        '        return savedPath & linefeed & "===ERRORS===" & linefeed & errorLog\n'
        '    end if\n'
        'end tell\n'
    )


def process_psd(input_path: str, ps_path: str) -> dict[str, Any]:
    """主流程（仅 macOS）：

      1. 用 `open -g -a PS_PATH FILE` 后台把 PSD 交给 PS（尽量不抢当前前台焦点）
         （比 AppleScript 自己 open alias 稳得多——绕开跨进程 alias 失效的坑）
      2. 跑 osascript：等 PS 加载 → 按顺序跑多个 jsx → 关原文件 → return 输出路径
    """
    if not IS_MAC:
        return {"ok": False, "error": "目前仅 macOS 实现了 PSD 处理"}
    src = Path(input_path).expanduser()
    if not src.is_file():
        return {"ok": False, "error": f"文件不存在：{src}"}
    if src.suffix.lower() != ".psd":
        return {"ok": False, "error": f"非 .psd 文件：{src}"}
    if not Path(ps_path).exists():
        return {"ok": False, "error": f"Photoshop 应用不存在：{ps_path}"}

    # 检查所有脚本文件都存在
    for script in (SCRIPT_UNLOCK_ALL_LAYERS, SCRIPT_UNGROUP_ARTBOARDS, SCRIPT_DELETE_EMPTY, SCRIPT_FLATTEN_FX,
                   SCRIPT_FLATTEN_GROUPS_WITH_FX, SCRIPT_FLATTEN_MASKS,
                   SCRIPT_FLATTEN_CLIPPING_MASKS,
                   SCRIPT_DELETE_PROBLEMATIC_CLIP, SCRIPT_ORGANIZE_GROUPS,
                   SCRIPT_UNIQUE_LAYER_NAMES, SCRIPT_TRIM_TO_CANVAS,
                   SCRIPT_SAVE_AS_CLEAN):
        if not script.is_file():
            return {"ok": False, "error": f"脚本缺失：{script.name}"}

    # 1. LaunchServices 路径：让 PS 自己用 odoc 事件打开（用户在 Finder 双击的等价路径）
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

    # 2. AppleScript 等加载 + 跑多个 jsx + 关文档 + return 输出路径
    script_src = _build_process_applescript(src.name)
    try:
        r = subprocess.run(
            ["osascript", "-e", script_src],
            capture_output=True, text=True, timeout=_PROCESS_TIMEOUT_SEC,
        )
        if r.returncode != 0:
            err = (r.stderr or r.stdout).strip() or f"osascript exit={r.returncode}"
            return {"ok": False, "error": err}
        raw = r.stdout.strip()
        if not raw:
            return {"ok": False, "error": "saveAsClean 没有返回路径（可能 PS 内部出错）"}

        # AppleScript 约定：第 1 行 = path；如果有 step 出错，下方有 "===ERRORS===" 标记 + 错误日志
        out_path, sep, error_log = raw.partition("===ERRORS===")
        out_path = out_path.strip()
        error_log = error_log.strip() if sep else ""

        if not Path(out_path).exists():
            err_suffix = f"\n步骤错误日志：\n{error_log}" if error_log else ""
            return {"ok": False, "error": f"输出文件不存在：{out_path}{err_suffix}"}

        # 新文件作成后立刻把本 APP 置顶，让用户在我们的界面看到处理结果。
        # PS 关闭文件/处理完后仍可能保持 frontmost，需主动抢回焦点。
        _activate_self()

        return {"ok": True, "data": {
            "path": out_path,
            "directory": str(Path(out_path).parent),
            "size_bytes": Path(out_path).stat().st_size,
            # 部分步骤跳过的错误日志；为空字符串表示全部成功
            "step_errors": error_log,
        }}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"PS 处理超时（>{_PROCESS_TIMEOUT_SEC}s）"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


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
