# arti-pre-psd

本地桌面工具：**React + TypeScript（前端 UI）+ Python（控制层）+ pywebview（系统 WebView 容器）+ Photoshop ExtendScript（实际清洗执行者）**。

无网络请求、无数据库，所有逻辑跑在本地。前端通过 `window.pywebview.api` 直接调用 Python 方法；Python 通过 AppleScript `do javascript file` 让 Photoshop 跑预置的 .jsx 脚本。

---

## 工作流概览

```
[用户操作 UI]
      │
      ▼ window.pywebview.api.* (无 HTTP)
[Python (backend/api.py)]
      │
      ▼ subprocess + osascript
[macOS 系统]
      │
      ▼ AppleScript "tell application ... do javascript file"
[Photoshop]
      │
      ▼ 顺序执行多个 ExtendScript（每步包 try/on error 失败可跳过）
backend/psExtendScript/
  1. Delete All Empty Layers.jsx     # 删空图层 + 删所有"有效不可见"图层（fork 增强）
  2. Flatten All Layer Effects.jsx   # 栅格化所有 ArtLayer 的图层样式（PS 自带）
  3. flattenGroupsWithEffects.jsx    # 自身带 effects 的 LayerSet → 合并成单层（拼合可见+遵循剪切）
  4. Flatten All Masks.jsx           # 烧入图层蒙版到 alpha（PS 自带）
  5. flattenClippingMasks.jsx        # 合并所有剪切蒙版组 + 栅格化 base 残留的 effects（修补步 2 漏）
  6. trimLayersToCanvas.jsx          # 栅格化智能对象 + Image>Crop 裁掉所有画布外像素
  7. Delete All Empty Layers.jsx     # 再来一次：合并 mask + 裁画布后产生的全透明残留层清掉
  8. saveAsClean.jsx                 # 另存为 [原名]_clean.psd
      │
      ▼ saveAsClean 末尾 IIFE return 路径
[osascript stdout]
      │
      ▼ Python 拿到 _clean.psd 路径 + step_errors 错误日志，回传前端
[前端显示成功 / 黄色警告（部分步骤被跳过）+ "打开所在文件夹"]
```

为什么走 ExtendScript：早期版本用 `psd-tools` 在 Python 里直接读写 PSD，
但智能对象 / LinkedLayer 等场景 PSD 二进制兼容性问题层出不穷，PS 打开时常报"程序错误"。
让 Photoshop 自己处理 + 自己保存，"PS 写出的文件 PS 一定能开"，绕开了所有二进制兼容性的坑。

历史的 Python 清洗代码（原 `backend/utils/`）已彻底移除；`psd-tools` pip 依赖
仍保留在 `requirements.txt`，方便后续如需再做 PSD 内容分析（例如读 layer 元数据
做诊断）时拿来即用，但生产路径完全不依赖它。

---

## 目录结构

```
arti-pre-psd/
├── backend/
│   ├── api.py                    # 暴露给前端的 Python API
│   ├── photoshop.py              # PS 检测 / 启动 / AppleScript 调脚本
│   ├── settings.py               # ~/.arti-pre-psd/settings.json 读写
│   ├── psExtendScript/           # 跑在 Photoshop 里的 .jsx 脚本
│   │   ├── README.md
│   │   ├── Delete All Empty Layers.jsx     # 已 fork 增强：兼删隐藏图层
│   │   ├── Flatten All Layer Effects.jsx   # 栅格化所有 ArtLayer 的图层样式
│   │   ├── flattenGroupsWithEffects.jsx    # 合并自身带 effects 的图层组
│   │   ├── Flatten All Masks.jsx           # 烧入图层蒙版到 alpha
│   │   ├── flattenClippingMasks.jsx        # 合并剪切蒙版组 + 栅格化 base 残留 effects
│   │   ├── trimLayersToCanvas.jsx          # 裁掉图层超出画布部分（Image > Crop）
│   │   └── saveAsClean.jsx                 # 另存为 [原名]_clean.psd
│   ├── requirements.txt          # 仅保留 pywebview / watchdog / psd-tools（备用）
│   └── __init__.py
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api.ts
│   │   ├── pywebview.d.ts
│   │   ├── components/
│   │   │   └── PsdUploader.tsx
│   │   └── ...
│   └── ...
├── run.py                        # 一键启动脚本
└── README.md
```

---

## 环境要求

- **macOS**（当前仅 macOS 实现 PS 调脚本；Windows 后端代码已留占位但未实现）
- **Photoshop**（任意版本；启动时自动扫描 `/Applications/Adobe Photoshop *`）
- **Python ≥ 3.9**
- **Node.js ≥ 18**（建议 20+）

---

## 一键启动

```bash
python3 run.py
```

首次启动会：

1. 创建 `.venv/`，安装 `backend/requirements.txt`
2. `npm install` + `npm run build`
3. 启动 pywebview 窗口
4. **自动尝试启动 Photoshop**（如已检测到安装路径）

如果探测不到 PS，前端会弹"未检测到 Photoshop"卡片，引导用户从原生文件对话框选择 `.app`，选择后会写入 `~/.arti-pre-psd/settings.json`，下次启动直接用。

### 开发模式

```bash
python3 run.py --dev          # 前端 Vite HMR
python3 run.py --watch        # 后端 .py 改动自动重启窗口
python3 run.py --dev --watch  # 推荐组合
```

---

## 前端用户操作流

1. 打开应用 → 自动检测 PS。
2. 没检测到 → 点"选择 Photoshop 应用" → 系统对话框选 `.app` → 自动启动 PS。
3. PS 就绪后 → 主区显示"点击选择 PSD 文件"。
4. 选 PSD → 后端调 4 个脚本（**不接受任何参数**，规则是固定的）→ PS 处理（1~2 分钟）→ 完成提示。
5. 输出文件位于原 PSD 同目录，命名 `<原名>_clean.psd`，重名自动 `_1` / `_2`。

---

## 后端 API（前端可调用）

| 方法                 | 用途                                                                |
| -------------------- | ------------------------------------------------------------------- |
| `ps_get_status()`    | 探测 PS 安装路径 / 是否在跑 / 是否可用，无副作用                    |
| `ps_pick_app()`      | 弹原生 dialog 选 `.app`，写入 settings 并自动 launch                |
| `ps_launch()`        | 启动 / 激活 PS（idempotent）                                        |
| `pick_psd_file()`    | 弹原生 dialog 选 `.psd`，返回真实磁盘路径（不读字节，对大文件友好） |
| `process_psd(path)`  | 同步阻塞：让 PS 跑 4 个 jsx，返回 `_clean.psd` 路径                 |
| `open_external(url)` | `file://` / `mailto:` / `http(s)://` 交给系统默认程序               |

---

## 修改 / 添加 ExtendScript

ExtendScript 详细说明见 `backend/psExtendScript/README.md`。

如果要修改清洗顺序或换脚本，编辑 `backend/photoshop.py` 顶部的 `SCRIPT_*` 常量与 `_build_process_applescript()` 里的调用顺序即可。

---

## 打包 macOS App（Artiprepsd）

已提供一键脚本：`scripts/build_macos_app.sh`。

1. 准备一个 PNG 图标（建议 1024x1024）并固定放到 `assets/app-icon.png`
2. 执行：

```bash
bash scripts/build_macos_app.sh
```

脚本会自动完成：
- 构建前端 `frontend/dist`
- 安装 PyInstaller 打包依赖
- 把 PNG 转成 `.icns`
- 生成 `dist/Artiprepsd.app`

运行方式：

```bash
open "dist/Artiprepsd.app"
```

---

## 配置文件

`~/.arti-pre-psd/settings.json`：

```json
{
  "ps_app_path": "/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app"
}
```

只存"用户手动选过的 PS 路径"。删掉它会让下次启动重新自动扫描。
