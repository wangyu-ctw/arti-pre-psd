"""
PSD 内存会话管理器（步骤文件方案）。

核心思路：
  每次结构操作分三步：
    1. 把当前状态（树快照 + DFS sids + 当前步骤文件路径）压栈
    2. 修改 self._psd 的结构数据（C 扩展读 _record，composite/save 均可感知）
    3. 把修改后的 _psd 保存为新步骤文件（系统临时目录），更新 _current_psd_path

  Undo：从历史栈弹出上一个状态 → 删除当前步骤文件 → 重开上一步骤文件 → 重建 _layer_map
  Save_as：直接 self._psd.save(path)（_record 已含所有修改）
  Thumbnail：self._psd.composite()（C 扩展读 _record，修改后即刻反映）
  Cleanup：会话关闭时删除临时目录

  _record 修改失败时：log error + rollback 回到上一步骤文件，不向前端报告成功，无降级兜底。
  _sid 在整个会话内稳定，路径 id 在每次结构变更后由 _reindex_tree() 重建。
"""
from __future__ import annotations

import base64
import copy
import io
import itertools
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

from psd_tools import PSDImage
from psd_tools.api.layers import Group, PixelLayer
from psd_tools.constants import Compression

logger = logging.getLogger(__name__)

# ── 共享配置（从项目根 config.json 读取）──────────────────────────────────────

def _load_layer_type_index_map() -> dict[str, int]:
    try:
        cfg_path = Path(__file__).parent.parent / "frontend" / "src" / "config.json"
        with cfg_path.open(encoding="utf-8") as f:
            return json.load(f).get("layer_type_index_map", {})
    except Exception as exc:
        logger.warning("psd_session: 无法加载 config.json，layer_type_index 列将为空: %s", exc)
        return {}

_LAYER_TYPE_INDEX_MAP: dict[str, int] = _load_layer_type_index_map()

# ── 模块级单例 ─────────────────────────────────────────────────────────────

_active_session: Optional["PsdSession"] = None

MAX_HISTORY = 10


def get_session() -> Optional["PsdSession"]:
    return _active_session


def load(file_path: str) -> "PsdSession":
    global _active_session
    if _active_session is not None:
        _active_session.cleanup()
    psd = PSDImage.open(file_path)
    _active_session = PsdSession(file_path, psd)
    return _active_session


def close() -> None:
    global _active_session
    if _active_session is not None:
        _active_session.cleanup()
    _active_session = None


# ── 内部纯函数（字典树操作）───────────────────────────────────────────────


def _reindex_tree(nodes: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for idx, node in enumerate(nodes):
        new_id = f"{prefix}/{idx}_{node['name']}"
        new_node = {**node, "id": new_id}
        if "children" in new_node:
            new_node["children"] = _reindex_tree(new_node["children"], new_id)
        result.append(new_node)
    return result


def _to_public(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将 _sid 重命名为 psdSid 暴露给前端；过滤所有其他下划线内部字段。"""
    result: list[dict[str, Any]] = []
    for node in nodes:
        n = {
            ("psdSid" if k == "_sid" else k): v
            for k, v in node.items()
            if k == "_sid" or not k.startswith("_")
        }
        if "children" in n:
            n["children"] = _to_public(n["children"])
        result.append(n)
    return result


def _remove_from_tree(
    nodes: list[dict[str, Any]], ids_set: set[str]
) -> list[dict[str, Any]]:
    new_tree: list[dict[str, Any]] = []
    for node in nodes:
        if node["id"] not in ids_set:
            new_node = dict(node)
            if "children" in new_node:
                new_node = {
                    **new_node,
                    "children": _remove_from_tree(new_node["children"], ids_set),
                }
            new_tree.append(new_node)
    return new_tree


def _ungroup_in_tree(
    nodes: list[dict[str, Any]], ids_set: set[str]
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for node in nodes:
        if node["id"] in ids_set and node.get("isGroup"):
            result.extend(node.get("children", []))
        else:
            new_node = dict(node)
            if "children" in new_node:
                new_node = {
                    **new_node,
                    "children": _ungroup_in_tree(new_node["children"], ids_set),
                }
            result.append(new_node)
    return result


def _insert_group_remove_ids(
    nodes: list[dict[str, Any]],
    ids_set: set[str],
    new_node: dict[str, Any],
    inserted_flag: list[bool],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for node in nodes:
        if node["id"] in ids_set:
            if not inserted_flag[0]:
                result.append(new_node)
                inserted_flag[0] = True
        else:
            child = dict(node)
            if "children" in child:
                child = {
                    **child,
                    "children": _insert_group_remove_ids(
                        child["children"], ids_set, new_node, inserted_flag
                    ),
                }
            result.append(child)
    return result


def _merge_group_in_tree(
    nodes: list[dict[str, Any]], target_id: str
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for node in nodes:
        if node["id"] == target_id and node.get("isGroup"):
            new_node = {k: v for k, v in node.items() if k != "children"}
            new_node["isGroup"] = False
            result.append(new_node)
        else:
            new_node = dict(node)
            if "children" in new_node:
                new_node = {
                    **new_node,
                    "children": _merge_group_in_tree(new_node["children"], target_id),
                }
            result.append(new_node)
    return result


# ── PsdSession ────────────────────────────────────────────────────────────


class PsdSession:
    """单个 PSD 文件的内存编辑会话（步骤文件方案）。"""

    def __init__(self, path: str, psd: PSDImage) -> None:
        self._path = path          # 原始文件（只读，不会被修改）
        self._psd = psd            # 当前内存中的 PSD（操作时直接修改 _record）
        self._sid_iter = itertools.count()
        self._layer_map: dict[int, Any] = {}
        self._current_tree: list[dict[str, Any]] = self._build_tree(psd, "root")

        # 临时目录：存放步骤文件
        self._temp_dir: str = tempfile.mkdtemp(prefix="psd_sess_")
        self._step_counter: int = 0

        # 当前步骤文件路径（初始指向原始文件，操作后更新）
        self._current_psd_path: str = path

        # 历史栈：[(tree_snapshot, step_file_path, dfs_sids), ...]
        # 每条代表"操作前"的状态，用于 undo 恢复
        self._history: list[tuple[list[dict[str, Any]], str, list[int | None]]] = []

    # ── 初始化 ─────────────────────────────────────────────────────────────

    def _build_tree(self, container: Any, prefix: str) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for idx, layer in enumerate(container):
            sid = next(self._sid_iter)
            self._layer_map[sid] = layer
            node_id = f"{prefix}/{idx}_{layer.name}"
            is_group = isinstance(layer, Group)
            left = int(layer.left)
            top = int(layer.top)
            right = int(layer.right)
            bottom = int(layer.bottom)
            node: dict[str, Any] = {
                "_sid": sid,
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
                node["children"] = self._build_tree(layer, node_id)
            result.append(node)
        return result

    # ── 工具方法 ───────────────────────────────────────────────────────────

    def _rev_map(self) -> dict[int, int]:
        """id(layer_obj) → sid 反向映射。"""
        return {id(lyr): s for s, lyr in self._layer_map.items() if lyr is not None}

    @staticmethod
    def _dfs_flat(container: Any) -> list[Any]:
        """DFS 遍历 PSDImage/Group，返回所有图层对象的扁平列表（前序）。"""
        out: list[Any] = []

        def collect(c: Any) -> None:
            for lyr in c:
                out.append(lyr)
                if isinstance(lyr, Group):
                    collect(lyr)

        collect(container)
        return out

    def _dfs_sids(self) -> list[int | None]:
        """对当前 _psd 做 DFS，返回各图层对应的 sid（None 表示无法识别）。"""
        rev = self._rev_map()
        return [rev.get(id(lyr)) for lyr in self._dfs_flat(self._psd)]

    def _rebind_layers_from_tree(self) -> None:
        """重新打开 step 文件后，用当前逻辑树里的 _sid 绑定新的真实 layer 对象。

        结构操作会先更新 _current_tree，再保存 step 并重新打开 PSD。重新打开后，
        旧 layer 对象全部失效；这里以 _current_tree 为模板，校验新 PSD 的树形结构，
        并把每个稳定 _sid 绑定到新 PSD 中对应的 layer 对象。
        """
        new_map: dict[int, Any] = {}

        def bind(container: Any, template_nodes: list[dict[str, Any]], path: str) -> None:
            layers = list(container)
            if len(layers) != len(template_nodes):
                raise RuntimeError(
                    f"重新加载 PSD 后结构不一致：{path} 期望 {len(template_nodes)} 个节点，实际 {len(layers)} 个"
                )

            for idx, (layer, template) in enumerate(zip(layers, template_nodes)):
                node_path = f"{path}/{idx}_{template.get('name', '')}"
                layer_is_group = isinstance(layer, Group)
                expected_is_group = bool(template.get("isGroup"))
                if layer_is_group != expected_is_group:
                    raise RuntimeError(
                        f"重新加载 PSD 后节点类型不一致：{node_path} "
                        f"期望 isGroup={expected_is_group}，实际 isGroup={layer_is_group}"
                    )

                sid = template.get("_sid")
                if sid is None:
                    raise RuntimeError(f"重新加载 PSD 后缺少稳定 sid：{node_path}")
                new_map[int(sid)] = layer

                if expected_is_group:
                    bind(layer, template.get("children", []), node_path)

        bind(self._psd, self._current_tree, "root")

        # 保留已失效 sid 的 None 标记，前端 undo/迁移时能明确知道它不存在了。
        for sid in self._layer_map:
            if sid not in new_map:
                new_map[sid] = None
        self._layer_map = new_map

    # ── _record 直接操作（C 扩展 composite / save 均依赖此数据）─────────────

    def _get_layer_info(self) -> Any | None:
        """获取底层 LayerInfo，兼容 psd-tools 不同版本字段名。"""
        try:
            record = self._psd._record
            # psd-tools 1.11.0 使用 layer_and_mask_information；旧代码曾使用
            # layer_and_mask_info。优先调用底层 PSD 自带方法，因为它还会处理
            # LAYER_16/LAYER_32 tagged block 中的 layer info。
            get_layer_info = getattr(record, "_get_layer_info", None)
            if callable(get_layer_info):
                return get_layer_info()

            lai = getattr(record, "layer_and_mask_information", None)
            if lai is None:
                lai = getattr(record, "layer_and_mask_info", None)
            return getattr(lai, "layer_info", None) if lai is not None else None
        except Exception as exc:
            logger.error("_get_layer_info: 获取底层 LayerInfo 失败: %s", exc)
            return None

    @staticmethod
    def _get_channel_data(li: Any) -> Any | None:
        """获取与 layer_records 平行的通道数据列表。"""
        return getattr(li, "channel_image_data", None) or getattr(li, "channel_data_list", None)

    @staticmethod
    def _lsct_type(record: Any) -> int | None:
        """返回 LayerRecord 的 section divider 类型：1/2=组标头, 3=bounding, None=普通层。"""
        try:
            from psd_tools.constants import Tag

            tagged = record.tagged_blocks
            if tagged is None:
                return None

            # TaggedBlocks 是 dict-like 容器，迭代它拿到的是 key，不是 block 对象。
            # psd-tools 自己也是通过 get_data 读取 section divider。
            divider = tagged.get_data(Tag.SECTION_DIVIDER_SETTING, None)
            divider = tagged.get_data(Tag.NESTED_SECTION_DIVIDER_SETTING, divider)
            if divider is None:
                return None
            return int(divider.kind)
        except Exception as exc:
            logger.error("_lsct_type: 读取 section divider 失败: %s", exc)
            return None

    def _find_group_span(self, group_layer: Any) -> tuple[int, int] | None:
        """在 layer_records 平铺列表里找到组的区间 (bounding_idx, header_idx)。

        PSD 文件存储顺序（自底向上，低索引=PS面板底部）：
          [...] [bounding_divider(type=3)] [children...] [group_header(type=1/2)] [...]
        """
        li = self._get_layer_info()
        if li is None:
            return None
        records = li.layer_records
        layer_rec = getattr(group_layer, "_record", None)
        if layer_rec is None:
            logger.error("_find_group_span: 组 %r 没有 _record", getattr(group_layer, "name", "?"))
            return None

        header_idx: int | None = None
        for i, rec in enumerate(records):
            if rec is layer_rec:
                header_idx = i
                break
        if header_idx is None:
            logger.error("_find_group_span: 找不到组 %r 的 header record", getattr(group_layer, "name", "?"))
            return None

        bounding_rec = getattr(group_layer, "_bounding_record", None)
        if bounding_rec is not None:
            for i, rec in enumerate(records):
                if rec is bounding_rec:
                    if i < header_idx:
                        return (i, header_idx)
                    logger.error(
                        "_find_group_span: 组 %r 的 bounding_idx=%s 不在 header_idx=%s 之前",
                        getattr(group_layer, "name", "?"),
                        i,
                        header_idx,
                    )
                    return None

        # 从 header 往前找配对的 bounding divider（跳过嵌套组的 bounding）
        nesting = 0
        for i in range(header_idx - 1, -1, -1):
            t = self._lsct_type(records[i])
            if t in (1, 2):
                nesting += 1
            elif t == 3:
                if nesting == 0:
                    return (i, header_idx)
                nesting -= 1
        logger.error("_find_group_span: 找不到组 %r 的 bounding divider", getattr(group_layer, "name", "?"))
        return None

    def _update_layer_count(self, li: Any) -> None:
        """更新 layer_info.layer_count，保留正负号含义（负号表示有合并图像数据）。"""
        try:
            sign = -1 if li.layer_count < 0 else 1
            li.layer_count = sign * len(li.layer_records)
        except Exception:
            pass

    def _rollback(self) -> None:
        """操作失败时：从 _history 中弹出刚入栈的快照，并从上一步骤文件重新加载 _psd，
        还原 _current_tree，确保内存状态与磁盘一致。"""
        if not self._history:
            return
        tree_snap, prev_path, dfs_sids = self._history.pop()
        try:
            self._psd = PSDImage.open(prev_path)
        except Exception as exc:
            logger.error("_rollback: 无法重新加载步骤文件 %s: %s", prev_path, exc)
        self._current_psd_path = prev_path
        self._current_tree = tree_snap

        # 优先按恢复后的树结构重绑真实 layer 对象；旧 dfs_sids 仅作为兼容兜底。
        try:
            self._rebind_layers_from_tree()
        except Exception as exc:
            logger.error("_rollback: 按树结构重建 _layer_map 失败，尝试 DFS 兜底: %s", exc)
            try:
                flat = self._dfs_flat(self._psd)
                for sid, lyr in zip(dfs_sids, flat):
                    if sid is not None:
                        self._layer_map[sid] = lyr
                active = {s for s in dfs_sids if s is not None}
                for sid in list(self._layer_map):
                    if sid not in active:
                        self._layer_map[sid] = None
            except Exception as fallback_exc:
                logger.error("_rollback: DFS 兜底重建 _layer_map 失败: %s", fallback_exc)

    def _delete_layer_from_record(self, layer: Any) -> bool:
        """从 _record.layer_records 中彻底删除图层（含组的完整区间）。
        失败只返回 False + 记录日志，不做任何降级兜底。"""
        li = self._get_layer_info()
        if li is None:
            logger.error("_delete_layer_from_record: 无法获取 layer_info")
            return False
        records = li.layer_records
        channels = self._get_channel_data(li)
        if channels is None:
            logger.error("_delete_layer_from_record: 无法获取 channel data")
            return False

        if isinstance(layer, Group):
            span = self._find_group_span(layer)
            if span is None:
                logger.error("_delete_layer_from_record: 找不到组 %r 的区间", getattr(layer, "name", "?"))
                return False
            bounding_idx, header_idx = span
            try:
                for i in range(header_idx, bounding_idx - 1, -1):
                    records.pop(i)
                    if i < len(channels):
                        channels.pop(i)
                self._update_layer_count(li)
                return True
            except Exception as exc:
                logger.error("_delete_layer_from_record: 删除组 %r 的 record 失败: %s", getattr(layer, "name", "?"), exc)
                return False
        else:
            layer_rec = getattr(layer, "_record", None)
            if layer_rec is None:
                logger.error("_delete_layer_from_record: 图层 %r 没有 _record", getattr(layer, "name", "?"))
                return False
            for i in range(len(records) - 1, -1, -1):
                if records[i] is layer_rec:
                    try:
                        records.pop(i)
                        if i < len(channels):
                            channels.pop(i)
                        self._update_layer_count(li)
                        return True
                    except Exception as exc:
                        logger.error("_delete_layer_from_record: pop 图层 %r 失败: %s", getattr(layer, "name", "?"), exc)
                        return False
            logger.error("_delete_layer_from_record: 在 layer_records 中找不到图层 %r 的记录", getattr(layer, "name", "?"))
            return False

    def _ungroup_in_record(self, group_layer: Any) -> bool:
        """在 _record 中解散组：只删 bounding divider 和 group header，保留子图层记录。"""
        span = self._find_group_span(group_layer)
        if span is None:
            return False
        bounding_idx, header_idx = span
        li = self._get_layer_info()
        if li is None:
            return False
        records = li.layer_records
        channels = self._get_channel_data(li)
        if channels is None:
            logger.error("_ungroup_in_record: 无法获取 channel data")
            return False
        try:
            # 先删大索引（header），再删小索引（bounding），避免索引偏移
            records.pop(header_idx)
            if header_idx < len(channels):
                channels.pop(header_idx)
            records.pop(bounding_idx)
            if bounding_idx < len(channels):
                channels.pop(bounding_idx)
            self._update_layer_count(li)
            return True
        except Exception:
            return False

    def _merge_group_in_record(self, group_layer: Any, pil_img: Any) -> bool:
        """在 _record 中将组替换为单一像素层（删除整个组区间，插入新记录）。"""
        span = self._find_group_span(group_layer)
        if span is None:
            return False
        bounding_idx, header_idx = span
        li = self._get_layer_info()
        if li is None:
            return False
        records = li.layer_records
        channels = self._get_channel_data(li)
        if channels is None:
            logger.error("_merge_group_in_record: 无法获取 channel data")
            return False
        try:
            if pil_img.mode != "RGBA":
                pil_img = pil_img.convert("RGBA")
            w, h = pil_img.size
            left = int(group_layer.left)
            top = int(group_layer.top)
            mini_rec, mini_chan = self._make_pixel_record_and_channels(
                pil_img,
                getattr(group_layer, "name", "") or "Merged Group",
                left,
                top,
            )
            mini_rec.bottom = top + h
            mini_rec.right = left + w
            # 从大到小删除组区间
            for i in range(header_idx, bounding_idx - 1, -1):
                records.pop(i)
                if i < len(channels):
                    channels.pop(i)
            # 在原 bounding 位置插入新像素层
            records.insert(bounding_idx, mini_rec)
            channels.insert(bounding_idx, mini_chan)
            self._update_layer_count(li)
            return True
        except Exception as exc:
            logger.error("_merge_group_in_record: 替换组 %r 为像素层失败: %s", getattr(group_layer, "name", "?"), exc)
            return False

    def _make_pixel_record_and_channels(
        self,
        pil_img: Any,
        name: str,
        left: int,
        top: int,
    ) -> tuple[Any, Any]:
        """创建可安全保存的像素层 record/channels。

        直接把中文写进 LayerRecord.name 可能在保存 Pascal string 时触发
        macroman/charmap 编码错误。这里先用 ASCII 临时名创建 record，再通过
        PixelLayer.name setter 写入真实名称；setter 会处理 Unicode layer name。
        """
        record, channels = PixelLayer._build_layer_record_and_channels(
            pil_img,
            "Merged Layer",
            left,
            top,
            Compression.RLE,
        )
        temp_layer = PixelLayer(self._psd, record, channels)
        if name:
            temp_layer.name = name
        return record, channels

    def _merge_nodes_in_layer_tree(
        self,
        source_layers: list[Any],
        pil_img: Any,
        name: str,
        x1: int,
        y1: int,
    ) -> Any:
        """用 psd-tools 高层 layer tree 合并多个节点，再由 _update_record 编译回 record。

        低层 record 直接删除/插入在跨组、嵌套组场景里很容易和 psd-tools 重新
        打开的树结构不一致；合并选中节点改走高层树，保证保存后 reload 的结构
        与 _current_tree 对齐。
        """
        if not source_layers:
            raise RuntimeError("没有可合并的源图层")

        first_layer = source_layers[0]
        insert_parent = getattr(first_layer, "parent", None)
        if insert_parent is None or not hasattr(insert_parent, "insert"):
            raise RuntimeError("找不到合并图层的插入父级")
        insert_index = insert_parent.index(first_layer)

        if pil_img.mode != "RGBA":
            pil_img = pil_img.convert("RGBA")

        record, channels = self._make_pixel_record_and_channels(pil_img, name, x1, y1)
        pixel_layer = PixelLayer(insert_parent, record, channels)

        for layer in source_layers:
            parent = getattr(layer, "parent", None)
            if parent is None or not hasattr(parent, "remove"):
                raise RuntimeError(f"图层 {getattr(layer, 'name', '?')} 没有可删除的父级")
            if layer not in parent:
                raise RuntimeError(f"图层 {getattr(layer, 'name', '?')} 不在其父级中")
            parent.remove(layer)

        insert_index = min(insert_index, len(insert_parent))
        insert_parent.insert(insert_index, pixel_layer)
        return pixel_layer

    def _make_pixel_layer(self, pil_img: Any, left: int, top: int, name: str = "") -> Any:
        """用 PIL 图像在指定位置创建像素图层对象（仅供预览用，不写入 _psd）。"""
        if pil_img.mode != "RGBA":
            pil_img = pil_img.convert("RGBA")
        record, channels = self._make_pixel_record_and_channels(
            pil_img, name or "Merged Layer", left, top
        )
        return PixelLayer(self._psd, record, channels)

    # ── 步骤文件管理 ────────────────────────────────────────────────────────

    def _new_step_path(self) -> str:
        self._step_counter += 1
        base = os.path.splitext(os.path.basename(self._path))[0]
        return os.path.join(self._temp_dir, f"{base}_s{self._step_counter}.psd")

    def _push_snapshot(self) -> None:
        """操作前调用：将当前状态（树 + 步骤文件路径 + DFS sids）压入历史栈。"""
        dfs_sids = self._dfs_sids()
        snap = (
            copy.deepcopy(self._current_tree),
            self._current_psd_path,
            dfs_sids,
        )
        self._history.append(snap)

        # 超出上限时，删除最旧步骤文件（原始文件不删）
        if len(self._history) > MAX_HISTORY:
            _, oldest_path, _ = self._history.pop(0)
            self._delete_step_file(oldest_path)

    def _save_step(self) -> None:
        """操作后调用：保存新步骤文件，并立刻重新打开作为当前真实状态。"""
        step_path = self._new_step_path()
        try:
            self._psd.save(step_path)
            self._psd = PSDImage.open(step_path)
            self._current_psd_path = step_path
            self._rebind_layers_from_tree()
        except Exception as exc:
            logger.error("_save_step: 保存或重新加载步骤文件失败，回滚操作: %s", exc)
            self._delete_step_file(step_path)
            self._rollback()
            raise

    def _delete_step_file(self, path: str) -> None:
        """安全删除步骤文件（原始文件不删）。"""
        if path != self._path:
            try:
                if os.path.exists(path):
                    os.unlink(path)
            except Exception:
                pass

    def cleanup(self) -> None:
        """清理所有临时步骤文件（会话关闭时调用）。"""
        try:
            shutil.rmtree(self._temp_dir, ignore_errors=True)
        except Exception:
            pass

    # ── 渲染 ───────────────────────────────────────────────────────────────

    def _render_thumbnail(self) -> str:
        """合成当前状态缩略图（base64 PNG）。"""
        # psd-tools 默认会优先返回 PSD 文件里内置的预合成 preview。
        # 结构操作后我们会重新打开 step 文件，此时 is_updated=False；如果不显式
        # ignore_preview，就会拿到旧 preview，前端看起来像"没有生成新预览图"。
        composite = self._psd.composite(ignore_preview=True, force=True)
        buf = io.BytesIO()
        composite.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")

    def _find_node_by_sid(self, sid: int) -> dict[str, Any] | None:
        def search(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
            for n in nodes:
                if n["_sid"] == sid:
                    return n
                if "children" in n:
                    found = search(n["children"])
                    if found is not None:
                        return found
            return None

        return search(self._current_tree)

    def get_layer_preview(self, sid: int) -> dict[str, Any]:
        """合成单个图层/图层组的预览图（base64 PNG）。"""
        layer = self._layer_map.get(sid)
        if layer is None:
            return {"error": "找不到该图层（已删除或为占位节点）"}

        try:
            img = layer.composite()
        except Exception as exc:
            return {"error": f"渲染失败: {exc}"}

        if img is None:
            return {"error": "图层内容为空"}

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return {
            "previewB64": base64.b64encode(buf.getvalue()).decode("utf-8"),
            "x": int(layer.left),
            "y": int(layer.top),
            "width": int(layer.width),
            "height": int(layer.height),
        }

    def _result(self) -> dict[str, Any]:
        return {
            "thumbnailB64": self._render_thumbnail(),
            "psdWidth": self._psd.width,
            "psdHeight": self._psd.height,
            "layers": _to_public(self._current_tree),
            "undoCount": len(self._history),
        }

    # ── 结构操作 ───────────────────────────────────────────────────────────

    def delete_nodes(self, ids: list[str]) -> dict[str, Any]:
        """删除指定节点（含后代）：修改 _record + 树 + 保存步骤文件。"""
        self._push_snapshot()
        ids_set = set(ids)

        # 只处理顶层被删节点（组的子节点随组一起删）
        toplevel_sids: list[int] = []

        def collect_toplevel(nodes: list[dict[str, Any]]) -> None:
            for n in nodes:
                if n["id"] in ids_set:
                    toplevel_sids.append(n["_sid"])
                elif n.get("children"):
                    collect_toplevel(n["children"])

        collect_toplevel(self._current_tree)

        new_tree = _remove_from_tree(self._current_tree, ids_set)
        self._current_tree = _reindex_tree(new_tree, "root")

        failed_sid: int | None = None
        for sid in toplevel_sids:
            layer = self._layer_map.get(sid)
            if layer is None:
                failed_sid = sid
                break
            if not self._delete_layer_from_record(layer):
                failed_sid = sid
                break

        if failed_sid is not None:
            logger.error("delete_nodes: 删除 sid=%s 失败，回滚操作", failed_sid)
            self._rollback()
            raise RuntimeError(f"删除图层失败：无法在 _record 中删除图层（sid={failed_sid}）")

        self._save_step()
        return self._result()

    def ungroup(self, ids: list[str]) -> dict[str, Any]:
        """解散图层组：删 _record 中的组边界记录，保留子图层 + 更新树 + 保存步骤文件。"""
        ids_set = set(ids)

        ungrouped_sids: list[int] = []

        def collect_groups(nodes: list[dict[str, Any]]) -> None:
            for n in nodes:
                if n["id"] in ids_set and n.get("isGroup"):
                    ungrouped_sids.append(n["_sid"])
                if n.get("children"):
                    collect_groups(n["children"])

        collect_groups(self._current_tree)

        self._push_snapshot()
        new_tree = _ungroup_in_tree(self._current_tree, ids_set)
        self._current_tree = _reindex_tree(new_tree, "root")

        failed_sid: int | None = None
        for sid in ungrouped_sids:
            layer = self._layer_map.get(sid)
            if layer is None or not isinstance(layer, Group):
                failed_sid = sid
                break
            if not self._ungroup_in_record(layer):
                failed_sid = sid
                break

        if failed_sid is not None:
            logger.error("ungroup: 解散 sid=%s 失败，回滚操作", failed_sid)
            self._rollback()
            raise RuntimeError(f"解散图层组失败：无法在 _record 中解散组（sid={failed_sid}）")

        self._save_step()
        return self._result()

    def merge_group(self, node_id: str) -> dict[str, Any]:
        """将图层组合并为单一像素层：替换 _record 中的组区间 + 更新树 + 保存步骤文件。"""
        def find_by_id(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
            for n in nodes:
                if n["id"] == node_id:
                    return n
                if n.get("children"):
                    r = find_by_id(n["children"])
                    if r:
                        return r
            return None

        node = find_by_id(self._current_tree)
        if node is None:
            return self._result()

        group_sid = node["_sid"]
        group_layer = self._layer_map.get(group_sid)

        self._push_snapshot()
        self._current_tree = _merge_group_in_tree(self._current_tree, node_id)

        if group_layer is not None and isinstance(group_layer, Group):
            try:
                pil_img = group_layer.composite()
                if pil_img is not None:
                    ok = self._merge_group_in_record(group_layer, pil_img)
                    if not ok:
                        logger.error("merge_group: _merge_group_in_record 返回 False，回滚操作（node_id=%s）", node_id)
                        self._rollback()
                        raise RuntimeError(f"合并图层组失败：无法在 _record 中修改图层组（node_id={node_id}）")
                    # 更新 _layer_map：指向新的像素层对象（供预览用）
                    pixel_lyr = self._make_pixel_layer(
                        pil_img,
                        int(group_layer.left),
                        int(group_layer.top),
                        getattr(group_layer, "name", ""),
                    )
                    self._layer_map[group_sid] = pixel_lyr
                else:
                    logger.error("merge_group: group_layer.composite() 返回 None，回滚操作（node_id=%s）", node_id)
                    self._rollback()
                    raise RuntimeError(f"合并图层组失败：无法合成图层组图像（node_id={node_id}）")
            except RuntimeError:
                raise
            except Exception as exc:
                logger.error("merge_group: composite 或 record 操作异常，回滚: %s", exc)
                self._rollback()
                raise RuntimeError(f"合并图层组失败：{exc}") from exc
        else:
            logger.error("merge_group: 找不到有效的 Group 图层（node_id=%s，group_sid=%s）", node_id, group_sid)
            self._rollback()
            raise RuntimeError(f"合并图层组失败：找不到对应的 Group 图层（node_id={node_id}）")

        self._save_step()
        return self._result()

    def merge_nodes_to_layer(
        self, ids: list[str], layer_name: str = "合并图层"
    ) -> dict[str, Any]:
        """将选中的多个节点合并为单一像素层：替换 _record + 更新树 + 保存步骤文件。"""
        from PIL import Image

        ids_set = set(ids)
        collected: list[dict[str, Any]] = []

        def _collect(nodes: list[dict[str, Any]]) -> None:
            for node in nodes:
                if node["id"] in ids_set:
                    collected.append(node)
                elif node.get("children"):
                    _collect(node["children"])

        _collect(self._current_tree)

        if len(collected) < 2:
            return self._result()

        self._push_snapshot()

        resolved_name = layer_name if layer_name != "合并图层" else collected[0]["name"]

        x1 = min(n["x"] for n in collected)
        y1 = min(n["y"] for n in collected)
        x2 = max(n["x"] + n.get("width", 0) for n in collected)
        y2 = max(n["y"] + n.get("height", 0) for n in collected)
        w, h = x2 - x1, y2 - y1

        new_sid = next(self._sid_iter)
        pixel_lyr = None

        if w > 0 and h > 0:
            canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            source_layers: list[Any] = []
            failed_reason: str | None = None
            for n in collected:
                src_lyr = self._layer_map.get(n["_sid"])
                if src_lyr is None:
                    failed_reason = f"找不到节点 {n.get('name', '?')} 对应的真实图层"
                    break
                source_layers.append(src_lyr)
                try:
                    lyr_img = src_lyr.composite()
                except Exception as exc:
                    failed_reason = f"图层 {n.get('name', '?')} 合成失败：{exc}"
                    break
                if lyr_img is None:
                    failed_reason = f"图层 {n.get('name', '?')} 内容为空，无法合并"
                    break
                if lyr_img.mode != "RGBA":
                    lyr_img = lyr_img.convert("RGBA")
                canvas.paste(
                    lyr_img,
                    (int(src_lyr.left) - x1, int(src_lyr.top) - y1),
                    lyr_img,
                )

            if failed_reason is not None:
                logger.error("merge_nodes_to_layer: %s，回滚操作（ids=%s）", failed_reason, ids)
                self._rollback()
                raise RuntimeError(f"合并节点为图层失败：{failed_reason}")

            if len(source_layers) != len(collected):
                logger.error("merge_nodes_to_layer: 源图层数量不一致，回滚操作（ids=%s）", ids)
                self._rollback()
                raise RuntimeError("合并节点为图层失败：源图层数量不一致")

            try:
                pixel_lyr = self._merge_nodes_in_layer_tree(
                    source_layers, canvas, resolved_name, x1, y1
                )
            except Exception as exc:
                logger.error("merge_nodes_to_layer: 修改 layer tree 失败，回滚操作（ids=%s）: %s", ids, exc)
                self._rollback()
                raise RuntimeError(f"合并节点为图层失败：{exc}") from exc
        else:
            logger.error("merge_nodes_to_layer: 合并区域为空（w=%d, h=%d），回滚操作", w, h)
            self._rollback()
            raise RuntimeError(f"合并节点为图层失败：合并区域为空（w={w}, h={h}）")

        self._layer_map[new_sid] = pixel_lyr

        new_leaf: dict[str, Any] = {
            "_sid": new_sid,
            "id": "placeholder",
            "name": resolved_name,
            "x": x1,
            "y": y1,
            "width": w,
            "height": h,
            "visible": True,
            "isGroup": False,
        }

        inserted_flag: list[bool] = [False]
        new_tree = _insert_group_remove_ids(
            self._current_tree, ids_set, new_leaf, inserted_flag
        )
        self._current_tree = _reindex_tree(new_tree, "root")

        self._save_step()
        return self._result()

    def insert_slices(self, node_id: str, slices: list[dict[str, Any]]) -> dict[str, Any]:
        """在指定图层上方（同父组内）按顺序插入切片像素层，算作 1 步 undo。

        slices 中每条格式：
          {base64: str, x: int, y: int, w: int, h: int}
          - base64: PNG 纯 base64（不含 data:image/... 前缀）
          - x, y  : 相对于原图层左上角的偏移（像素）
          - w, h  : 切片尺寸

        插入后面板顺序（从上到下）：
          slice[0] … slice[n-1] → 原图层（保留不变）
        """
        import base64 as _b64
        import io as _io
        from PIL import Image

        # ── 1. 找目标节点 ─────────────────────────────────────────────────
        def _find_by_id(nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
            for n in nodes:
                if n["id"] == node_id:
                    return n
                if n.get("children"):
                    found = _find_by_id(n["children"])
                    if found is not None:
                        return found
            return None

        target_node = _find_by_id(self._current_tree)
        if target_node is None:
            raise RuntimeError(f"找不到目标图层：{node_id}")

        if not slices:
            return self._result()

        target_layer = self._layer_map.get(target_node["_sid"])
        if target_layer is None:
            raise RuntimeError(f"图层对象无效（已删除？）：{node_id}")

        # ── 2. 确定插入父级与位置 ─────────────────────────────────────────
        parent = getattr(target_layer, "parent", None)
        if parent is None:
            raise RuntimeError(f"图层没有父级：{node_id}")

        insert_index = parent.index(target_layer)
        layer_left = int(target_layer.left)
        layer_top = int(target_layer.top)

        self._push_snapshot()

        new_leaf_nodes: list[dict[str, Any]] = []

        try:
            for i, s in enumerate(slices):
                png_bytes = _b64.b64decode(s["base64"])
                pil_img = Image.open(_io.BytesIO(png_bytes)).convert("RGBA")

                slice_x = int(s["x"])
                slice_y = int(s["y"])
                slice_w = int(s["w"])
                slice_h = int(s["h"])

                # PSD 画布坐标 = 原图层左上角 + 切片内部偏移
                psd_left = layer_left + slice_x
                psd_top = layer_top + slice_y

                slice_name = f"{target_node['name']}_{s.get('id', str(i))}"
                record, channels = self._make_pixel_record_and_channels(
                    pil_img, slice_name, psd_left, psd_top
                )
                # 确保边界正确（_build_layer_record_and_channels 有时依赖图像尺寸，
                # 此处显式修正以防万一）
                record.bottom = psd_top + slice_h
                record.right = psd_left + slice_w

                pixel_lyr = PixelLayer(parent, record, channels)
                # psd-tools 迭代顺序为 底→顶（index 0 = 面板最底层）。
                # 要让切片出现在原图层"上方"（面板更靠顶），必须插到 insert_index+1。
                # 始终插在 insert_index+1：每次都把上一张切片再往上推一位，
                # 最终 slice[0] 在最顶、slice[n-1] 紧贴原图层之上。
                parent.insert(insert_index + 1, pixel_lyr)

                new_sid = next(self._sid_iter)
                self._layer_map[new_sid] = pixel_lyr

                new_leaf_nodes.append({
                    "_sid": new_sid,
                    "id": "placeholder",
                    "name": slice_name,
                    "x": psd_left,
                    "y": psd_top,
                    "width": slice_w,
                    "height": slice_h,
                    "visible": True,
                    "isGroup": False,
                })

        except Exception as exc:
            logger.error(
                "insert_slices: 插入切片失败，回滚操作（node_id=%s）: %s", node_id, exc
            )
            self._rollback()
            raise RuntimeError(f"切分图层失败：{exc}") from exc

        # ── 3. 更新逻辑树：在 target 后插入新叶节点 ──────────────────────
        # 后端树顺序为 底→顶（与 psd-tools 层序相同）。
        # 实际插入后的层序（底→顶）：original, slice[n-1], …, slice[1], slice[0]。
        # 因此树中 target 之后需紧跟 reversed(new_leaf_nodes)，方可与 _rebind 对齐。
        def _insert_after(
            nodes: list[dict[str, Any]],
            tid: str,
            new_nodes: list[dict[str, Any]],
        ) -> list[dict[str, Any]]:
            result: list[dict[str, Any]] = []
            for node in nodes:
                result.append(node)
                if node["id"] == tid:
                    result.extend(new_nodes)
                else:
                    if "children" in node:
                        result[-1] = {
                            **node,
                            "children": _insert_after(node["children"], tid, new_nodes),
                        }
            return result

        # reversed：使树顺序与实际 parent 层序（底→顶）保持一致
        new_tree = _insert_after(self._current_tree, node_id, list(reversed(new_leaf_nodes)))
        self._current_tree = _reindex_tree(new_tree, "root")

        self._save_step()
        return self._result()

    # ── Undo ───────────────────────────────────────────────────────────────

    def undo(self) -> dict[str, Any] | None:
        """回退到上一步：删除当前步骤文件，从历史栈恢复上一状态。"""
        if not self._history:
            return None

        tree_snap, prev_path, dfs_sids = self._history.pop()

        # 删除当前步骤文件（不再需要）
        self._delete_step_file(self._current_psd_path)

        # 从上一步骤文件恢复 PSD
        self._psd = PSDImage.open(prev_path)
        self._current_psd_path = prev_path
        self._current_tree = tree_snap

        try:
            self._rebind_layers_from_tree()
        except Exception as exc:
            logger.error("undo: 按树结构重建 _layer_map 失败，尝试 DFS 兜底: %s", exc)
            restored_flat = self._dfs_flat(self._psd)
            for sid, lyr in zip(dfs_sids, restored_flat):
                if sid is not None:
                    self._layer_map[sid] = lyr

            # 将不再出现的 sid 标为 None
            active = {s for s in dfs_sids if s is not None}
            for sid in list(self._layer_map):
                if sid not in active and self._layer_map[sid] is not None:
                    self._layer_map[sid] = None

        return self._result()

    # ── 其他 API ───────────────────────────────────────────────────────────

    def trim_history(self, keep_count: int) -> None:
        """裁剪历史栈到最多 keep_count 条，删除多余的旧步骤文件。"""
        keep_count = max(0, keep_count)
        while len(self._history) > keep_count:
            _, old_path, _ = self._history.pop(0)
            self._delete_step_file(old_path)

    def save_as(self, path: str) -> None:
        """将当前状态保存到用户指定路径（直接保存 _psd，_record 已含所有修改）。"""
        self._psd.save(path)

    def build_export_package(
        self, layer_states: dict[str, dict[str, str]]
    ) -> tuple[str, list[tuple[str, bytes]]]:
        """同时生成 CSV 内容（含 layer_asset 列）和所有叶子节点 PNG 切片。

        layer_states: {node_id: {"type": "xxx", ...}} 来自前端 annotatorStore。
        返回 (csv_content, [(filename, png_bytes), ...])。
        """
        import re

        slices: list[tuple[str, bytes]] = []
        csv_rows: list[str] = []
        counter: dict[str, int] = {}

        def _safe_filename(raw: str) -> str:
            safe = re.sub(r'[\\/*?:"<>|\x00-\x1f]', "_", raw).strip() or "layer"
            n = counter.get(safe, 0)
            counter[safe] = n + 1
            return f"{safe}.png" if n == 0 else f"{safe}_{n}.png"

        def _csv_field(val: str) -> str:
            return '"' + val.replace('"', '""') + '"' if ("," in val or '"' in val) else val

        def _walk(nodes: list[dict[str, Any]]) -> None:
            for node in nodes:
                if node.get("isGroup"):
                    _walk(node.get("children") or [])
                    continue

                node_id = node["id"]
                state = layer_states.get(node_id, {})
                layer_type = state.get("type", "") if isinstance(state, dict) else ""

                layer = self._layer_map.get(node["_sid"])
                filename = _safe_filename(node.get("name", "layer"))

                if layer is not None:
                    try:
                        img = layer.composite()
                        if img is not None:
                            buf = io.BytesIO()
                            img.save(buf, format="PNG")
                            slices.append((filename, buf.getvalue()))
                    except Exception as exc:
                        logger.warning("build_export_package: 图层 %r 合成失败: %s", node.get("name"), exc)
                        filename = ""  # 合成失败时 layer_asset 留空

                name = node.get("name", "")
                layer_type_index = str(_LAYER_TYPE_INDEX_MAP.get(layer_type, ""))
                layer_info = json.dumps({"layer_name": name}, ensure_ascii=False)
                escaped_info = '"' + layer_info.replace('"', '""') + '"'

                def _area(s: dict, key: str) -> str:
                    v = s.get(key)
                    return "" if v is None else str(int(v))

                st = state if isinstance(state, dict) else {}
                csv_rows.append(
                    f"{_csv_field(name)},{node['x']},{node['y']},{node['width']},{node['height']},"
                    f"{_area(st, 'ax')},{_area(st, 'ay')},{_area(st, 'awidth')},{_area(st, 'aheight')},"
                    f"{layer_type},{layer_type_index},{escaped_info},{_csv_field(filename)}"
                )

        _walk(self._current_tree)

        header = f"{self._psd.width},{self._psd.height}"
        col_names = "layer_name,x,y,w,h,ax,ay,awidth,aheight,layer_type,layer_type_index,psd_layer_info,layer_asset"
        csv_content = "\n".join([header, col_names] + csv_rows)
        return csv_content, slices

    def get_psd_bytes(self) -> bytes:
        """将当前 PSD 状态序列化为字节流并返回（用于打包 ZIP 等内存操作）。"""
        buf = io.BytesIO()
        self._psd.save(buf)
        return buf.getvalue()

    @property
    def path(self) -> str:
        return self._path
