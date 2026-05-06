# psExtendScript

绕过 `psd-tools`，直接在 Photoshop 里跑 ExtendScript 脚本完成清洗。
理由：psd-tools 写出的 PSD 在含智能对象 / 复杂样式时容易让 PS 报"程序错误"，
且要花大量精力打补丁；ExtendScript 直接调用 PS 自己的 DOM/ActionManager，
"PS 自己生成的文件 PS 自己一定能开"，避免了二进制兼容性这个无底洞。

## 脚本清单

| 脚本                            | 功能                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ungroupArtboards.jsx`          | 取消文档内全部画板编组（深度优先 + `ungroupLayersEvent`）。跑在删空层之前。                                                                                                                                           |
| `flattenGroupsWithEffects.jsx`  | 自身带启用 layer effects 的图层组（LayerSet）合并成单层。语义沿用 PS 内置 `LayerSet.merge()`：拼合可见、遵循剪切蒙版；嵌套时反向遍历"先深后浅"。                                                                        |
| `flattenClippingMasks.jsx`      | 把所有剪切蒙版组（base + 上方 clipped layers）合并成一个 ArtLayer，并把合并后图层残留的 effects 也栅格化。专门修补"Flatten All Layer Effects 不处理 base"这种漏。LayerSet 作 base 时先 merge 成单层再合并整组。         |
| `trimLayersToCanvas.jsx`        | 裁掉每个 ArtLayer 超出画布的部分（mask + apply 模式）；完全在画布外的图层直接 remove。非普通像素层先栅格化再裁。                                                                                                        |
| `saveAsClean.jsx`               | 另存为 `[原文件名]_clean.psd`（同目录，自动避免重名）                                                                                                                                                                   |
| `uniqueLayerNames.jsx`          | 全文档 ArtLayer / LayerSet 名字全局去重，冲突后缀 `_2`、`_3`…；跑在 organize 之后。                                                                                                                                   |
| `organizeLayerGroups.jsx`       | 解散「只含一个子层」的图层组，单子组压平。                                                                                                                                                                             |
| `Delete All Empty Layers.jsx`   | 删除所有空图层（无像素 / 空文字层等）+ **fork 增强：删除所有"有效不可见"的图层**——只要图层自己或任一祖先组 visible=false，就强制删；**locked 也会先自动解锁再删**。空图层判定仍受 locked 保护。详见文件顶部 FORK 注释。 |
| `Flatten All Layer Effects.jsx` | 栅格化所有图层的图层样式（Adobe 官方实现）                                                                                                                                                                              |
| `Flatten All Masks.jsx`         | 把图层蒙版烧入像素的 alpha                                                                                                                                                                                              |

## 运行方式

任选其一：

1. **手动**：在 Photoshop 里 `File → Scripts → Browse...`，选中 `.jsx`。
2. **双击**（macOS）：把 `.jsx` 文件关联到 Photoshop 后双击运行。
3. **菜单常驻**：把 `.jsx` 拷到 PS 安装目录的
   `Presets/Scripts/` 下，重启 PS 后会出现在 `File → Scripts` 菜单里。

> 所有脚本都在文件顶部用 `#target photoshop`，无论从哪种入口启动都会把
> 调用扔进 PS 进程执行。

## 约定

- 单文件、自包含、可独立运行（不互相 `#include`）。
- 所有 ActionManager 一律 `DialogModes.NO`，避免被弹窗挂住。
- 对话框反馈只用 `alert()`，便于人工核对结果（无需控制台）。
- 变量 / 函数 / 注释统一中文 + 英文标识符。
