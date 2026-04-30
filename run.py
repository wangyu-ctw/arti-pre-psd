"""一键启动脚本。

使用方式：
    python3 run.py              # 自动构建（如需要）并启动桌面窗口
    python3 run.py --dev        # 开发模式：连接 Vite dev server，前端热更新
    python3 run.py --watch      # 监听 backend/** 变更，自动重启窗口
    python3 run.py --dev --watch# 前端热更 + 后端自动重启（推荐开发组合）
    python3 run.py --rebuild    # 强制重新 build 前端再启动
    python3 run.py --skip-deps  # 跳过依赖检查（已确认环境齐全时加快启动）

首次启动时本脚本会：
  1. 创建 Python 虚拟环境 .venv，并安装 backend/requirements.txt
  2. 在 frontend/ 下执行 npm install
  3. 在 frontend/ 下执行 npm run build
  4. 启动 pywebview 窗口加载 frontend/dist/index.html
之后再次启动会跳过已完成步骤。
"""
from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

# ---- 强制 UTF-8 stdio ---------------------------------------------------
# 防止 Windows 默认 cp1252 / 某些 macOS C-locale 终端遇到中文图层名等非 ASCII
# 字符时抛 UnicodeEncodeError('charmap' codec ...)。
# 必须在任何 print/log 之前完成。
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

ROOT = Path(__file__).parent.resolve()
VENV_DIR = ROOT / ".venv"
BACKEND_DIR = ROOT / "backend"
FRONTEND_DIR = ROOT / "frontend"
FRONTEND_DIST = FRONTEND_DIR / "dist"
NODE_MODULES = FRONTEND_DIR / "node_modules"
REQUIREMENTS = BACKEND_DIR / "requirements.txt"

IS_WINDOWS = os.name == "nt"


def log(msg: str) -> None:
    print(f"[run.py] {msg}", flush=True)


def venv_python() -> Path:
    return VENV_DIR / ("Scripts" if IS_WINDOWS else "bin") / ("python.exe" if IS_WINDOWS else "python")


def ensure_venv() -> Path:
    py = venv_python()
    if py.exists():
        return py
    log(f"创建虚拟环境 {VENV_DIR} ...")
    subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)
    return py


def ensure_python_deps(py: Path) -> None:
    log("安装/校验 Python 依赖 ...")
    subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
        check=True,
    )
    subprocess.run(
        [str(py), "-m", "pip", "install", "--quiet", "-r", str(REQUIREMENTS)],
        check=True,
    )


def ensure_node_modules() -> None:
    if NODE_MODULES.exists():
        return
    if not shutil.which("npm"):
        sys.exit("[run.py] 找不到 npm，请先安装 Node.js (https://nodejs.org)")
    log("安装前端依赖（首次启动较慢）...")
    subprocess.run(["npm", "install"], cwd=FRONTEND_DIR, check=True)


def build_frontend(force: bool = False) -> None:
    if FRONTEND_DIST.exists() and not force:
        return
    log("构建前端 ...")
    subprocess.run(["npm", "run", "build"], cwd=FRONTEND_DIR, check=True)


def relaunch_in_venv(py: Path, argv: list[str]) -> "subprocess.NoReturn":  # type: ignore[name-defined]
    """脚本本身可能由系统 python 启动，这里在依赖装好后切到 venv 的 python 重新执行自己。"""
    log("切换到虚拟环境运行 ...")
    env = os.environ.copy()
    env["ARTI_RELAUNCHED"] = "1"
    env.setdefault("PYTHONIOENCODING", "utf-8")
    os.execve(str(py), [str(py), str(Path(__file__).resolve()), *argv], env)


def run_dev_mode() -> None:
    """开发模式：先起 Vite dev server，再让 pywebview 直接加载 http://localhost:5173"""
    import webview

    if not shutil.which("npm"):
        sys.exit("[run.py] 找不到 npm，请先安装 Node.js")

    log("启动 Vite dev server (http://localhost:5173) ...")
    vite = subprocess.Popen(["npm", "run", "dev"], cwd=FRONTEND_DIR)
    try:
        time.sleep(2)
        from backend.api import Api
        webview.create_window(
            "Arti Pre PSD (dev)",
            "http://localhost:5173",
            js_api=Api(),
            width=960,
            height=720,
        )
        webview.start(debug=True)
    finally:
        log("关闭 Vite dev server ...")
        vite.terminate()
        try:
            vite.wait(timeout=5)
        except subprocess.TimeoutExpired:
            vite.kill()


def run_prod_mode() -> None:
    import webview

    index = FRONTEND_DIST / "index.html"
    if not index.exists():
        sys.exit(f"[run.py] 未找到 {index}，请先构建前端。")

    from backend.api import Api
    webview.create_window(
        "Arti Pre PSD",
        str(index),
        js_api=Api(),
        width=960,
        height=720,
    )
    webview.start()


def _spawn_child(child_args: list[str]) -> subprocess.Popen:
    """以独立进程组启动子进程，便于一键干掉子进程及它派生的 Vite 等孙子进程。"""
    env = os.environ.copy()
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if IS_WINDOWS:
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
        return subprocess.Popen(child_args, creationflags=creationflags, env=env)
    return subprocess.Popen(child_args, preexec_fn=os.setsid, env=env)


def _terminate_child(child: subprocess.Popen, timeout: float = 5.0) -> None:
    """优雅终止子进程及其整个进程组；超时则强杀。"""
    if child.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            child.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
        else:
            os.killpg(os.getpgid(child.pid), signal.SIGTERM)
    except ProcessLookupError:
        return

    try:
        child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            if IS_WINDOWS:
                child.kill()
            else:
                os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


def run_watch_mode(args: argparse.Namespace) -> None:
    """监听 backend/** 的 .py 变更，自动重启子进程（含窗口）。"""
    try:
        from watchdog.events import FileSystemEventHandler
        from watchdog.observers import Observer
    except ImportError:
        sys.exit("[run.py] 缺少 watchdog 依赖，请删掉 .venv 后重跑 `python3 run.py --watch`")

    py = venv_python()
    child_args: list[str] = [str(py), str(Path(__file__).resolve()), "--skip-deps"]
    if args.dev:
        child_args.append("--dev")
    if args.rebuild:
        child_args.append("--rebuild")

    restart_event = threading.Event()
    stop_event = threading.Event()

    class Handler(FileSystemEventHandler):
        def on_any_event(self, event) -> None:
            if event.is_directory:
                return
            path = str(event.src_path).replace("\\", "/")
            if not path.endswith(".py"):
                return
            if "/__pycache__/" in path:
                return
            log(f"检测到变更: {os.path.relpath(event.src_path, ROOT)}")
            restart_event.set()

    observer = Observer()
    observer.schedule(Handler(), str(BACKEND_DIR), recursive=True)
    observer.start()
    log(f"监听目录: {BACKEND_DIR}（仅 .py 文件）")

    def handle_sigint(_signum, _frame) -> None:
        log("收到 Ctrl+C，准备退出 ...")
        stop_event.set()

    signal.signal(signal.SIGINT, handle_sigint)

    child: subprocess.Popen | None = None
    try:
        log("启动子进程: " + " ".join(child_args))
        child = _spawn_child(child_args)

        while not stop_event.is_set():
            if restart_event.wait(timeout=0.5):
                # 防抖：批量保存 / 多文件改动时只重启一次
                time.sleep(0.3)
                while restart_event.is_set():
                    restart_event.clear()
                    time.sleep(0.3)

                log("重启子进程 ...")
                if child is not None:
                    _terminate_child(child)
                child = _spawn_child(child_args)
                continue

            if child is not None and child.poll() is not None:
                log(f"子进程已退出（exit={child.returncode}），watcher 同步退出。")
                break
    finally:
        observer.stop()
        observer.join()
        if child is not None:
            _terminate_child(child)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev", action="store_true", help="使用 Vite dev server（前端热更新）")
    parser.add_argument("--watch", action="store_true", help="监听 backend/** 变更，自动重启窗口")
    parser.add_argument("--rebuild", action="store_true", help="强制重新构建前端")
    parser.add_argument("--skip-deps", action="store_true", help="跳过依赖检查")
    args = parser.parse_args()

    if not os.environ.get("ARTI_RELAUNCHED"):
        py = ensure_venv()
        if not args.skip_deps:
            ensure_python_deps(py)
            ensure_node_modules()
        if not args.dev:
            build_frontend(force=args.rebuild)
        relaunch_in_venv(py, sys.argv[1:])
        return

    if args.watch:
        run_watch_mode(args)
    elif args.dev:
        run_dev_mode()
    else:
        run_prod_mode()


if __name__ == "__main__":
    main()
