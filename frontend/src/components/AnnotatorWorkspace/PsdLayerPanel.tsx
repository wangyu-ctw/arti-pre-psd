import {
  CaretDownOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  DownOutlined,
  EyeFilled,
  EyeInvisibleFilled,
  FolderOpenFilled,
  GroupOutlined,
  LeftOutlined,
  RightOutlined,
  XFilled,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { Button, Dropdown, Flex, Input, Select, Spin, Tooltip, message } from "antd";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CanvasSelectMode } from "../../store/annotatorStore";
import type { PsdLayerNode } from "../../pywebview";
import { getApi } from "../../api";
import { useAnnotatorStore } from "../../store/annotatorStore";
import { LAYER_TYPE_MAP, LAYER_TYPE_OPTIONS, layerTypeLabel } from "../../utils/config";
import { LayerSliceModal, type SliceItem } from "./LayerSliceModal";
import { AdjustLayerAreaModal } from "./AdjustLayerAreaModal";
import "./PsdLayerPanel.css";

const DEFAULT_STATE = { eyeOn: true, type: "", selected: false };

// ── Alt+Hover 图层预览 ────────────────────────────────────────────────────

/** 追踪当前正在请求预览的 psdSid，防止乱序响应覆盖最新结果。*/
let _previewingSid: number | null = null;
/** 当前鼠标悬浮节点的 psdSid（不受 eyeOn 限制，供 keydown Alt 使用）。*/
let _hoveredSid: number | null = null;

/**
 * 向 Python 请求指定图层的合成预览图，写入 annotatorStore.layerPreview。
 * 若在响应回来之前已换为其他节点，则丢弃过期响应。
 */
async function requestLayerPreview(sid: number) {
  _previewingSid = sid;
  try {
    const api = await getApi();
    const r = await api.psd_get_layer_preview(sid);
    if (_previewingSid !== sid) return; // 已切换到其他节点，丢弃
    if (!r.ok || !r.data) return;
    useAnnotatorStore.getState().setLayerPreview(r.data);
  } catch {
    // 静默忽略，不影响正常使用
  }
}

/** 将选中节点合并为单一叶节点（右键菜单 & Cmd+G 共用逻辑）。*/
async function execMergeToLayer() {
  const store = useAnnotatorStore.getState;
  const selectedIds = [...store().getSelectedIds()];
  if (selectedIds.length < 2) {
    message.info("请先选中 2 个以上节点再合并");
    return;
  }
  try {
    useAnnotatorStore.setState({ structuralLoading: true });
    const api = await getApi();
    const r = await api.psd_merge_to_layer(selectedIds);
    if (!r.ok || !r.data) {
      useAnnotatorStore.setState({ structuralLoading: false });
      message.error(r.error ?? "合并失败");
      return;
    }
    store().updateFromPsdOp(r.data);
  } catch (e) {
    useAnnotatorStore.setState({ structuralLoading: false });
    message.error(String(e));
  }
}

/**
 * 单个节点行。
 * - 直接订阅 `useAnnotatorStore(s => s.layerStates[node.id])`：只有自身状态变化才重渲染
 * - 直接调用 store action，无需从父组件传递回调
 */
const LayerNode = React.memo(function LayerNode({
  node,
  depth,
  nodeRefs,
  collapsedIds,
  setCollapsedIds,
  onSlice,
  onAdjust,
}: {
  node: PsdLayerNode;
  depth: number;
  nodeRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  collapsedIds: Set<string>;
  setCollapsedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSlice: (sid: number, nodeId: string) => void;
  onAdjust: (sid: number, nodeId: string) => void;
}) {
  // 精确订阅：只有本节点的 state 改变才触发重渲染
  const state = useAnnotatorStore((s) => s.layerStates[node.id]) ?? DEFAULT_STATE;

  const expanded = !collapsedIds.has(node.id);
  const disabled = !state.eyeOn;

  const className = [
    "layer-node",
    state.selected ? "layer-node--selected" : "",
    disabled ? "layer-node--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 通过 ref 引用回调，避免加入 useMemo 依赖导致不必要的重算
  const onSliceRef = useRef(onSlice);
  onSliceRef.current = onSlice;
  const onAdjustRef = useRef(onAdjust);
  onAdjustRef.current = onAdjust;

  // 右键菜单。只在 node.id / node.isGroup 变化时重算（实际上从不变化）
  const contextMenuItems = useMemo<MenuProps["items"]>(() => {
    const store = () => useAnnotatorStore.getState();
    if (node.isGroup) {
      return [
        {
          key: "mark-all",
          label: "将此图层组全部标记为",
          children: LAYER_TYPE_OPTIONS.map((o) => ({
            key: `mark-${o.value}`,
            label: (
              <span>
                <XFilled style={{ color: o.color, marginRight: 6 }} />
                {layerTypeLabel(o.value)}
              </span>
            ),
            onClick: () => store().setTypeForSubtree(node.id, o.value),
          })),
        },
        {
          key: "merge",
          label: "合并为一个图层",
          onClick: async () => {
            try {
              useAnnotatorStore.setState({ structuralLoading: true });
              const api = await getApi();
              const r = await api.psd_merge_group(node.id);
              if (!r.ok || !r.data) {
                useAnnotatorStore.setState({ structuralLoading: false });
                message.error(r.error ?? "合并失败");
                return;
              }
              store().updateFromPsdOp(r.data);
            } catch (e) {
              useAnnotatorStore.setState({ structuralLoading: false });
              message.error(String(e));
            }
          },
        },
        {
          key: "ungroup",
          label: "解散并将子图层上移一级",
          onClick: async () => {
            try {
              useAnnotatorStore.setState({ structuralLoading: true });
              const api = await getApi();
              const r = await api.psd_ungroup([node.id]);
              if (!r.ok || !r.data) {
                useAnnotatorStore.setState({ structuralLoading: false });
                message.error(r.error ?? "解散失败");
                return;
              }
              store().updateFromPsdOp(r.data);
            } catch (e) {
              useAnnotatorStore.setState({ structuralLoading: false });
              message.error(String(e));
            }
          },
        },
        { type: "divider" as const },
        {
          key: "delete",
          label: "删除此图层组",
          danger: true,
          onClick: () => store().requestDelete(new Set([node.id])),
        },
      ];
    }
    return [
      {
        key: "slice",
        label: "切分图层",
        disabled: node.psdSid == null,
        onClick: () => { if (node.psdSid != null) onSliceRef.current(node.psdSid, node.id); },
      },
      {
        key: "adjust",
        label: "修正边框",
        disabled: node.psdSid == null,
        onClick: () => { if (node.psdSid != null) onAdjustRef.current(node.psdSid, node.id); },
      },
      {
        key: "delete",
        label: "删除此图层",
        danger: true,
        onClick: () => store().requestDelete(new Set([node.id])),
      },
    ];
  }, [node.id, node.isGroup, node.psdSid]);

  return (
  <>
    <Dropdown menu={{ items: contextMenuItems }} trigger={["contextMenu"]}>
    <div
      ref={(el) => { nodeRefs.current[node.id] = el; }}
      onMouseEnter={(e) => {
        if (!disabled) useAnnotatorStore.getState().setHovered(node.id);
        _hoveredSid = node.psdSid ?? null;
        if (e.altKey && node.psdSid != null) {
          requestLayerPreview(node.psdSid);
        }
      }}
      onMouseLeave={() => {
        useAnnotatorStore.getState().setHovered(null);
        _hoveredSid = null;
        _previewingSid = null;
        useAnnotatorStore.getState().clearLayerPreview();
      }}
      onClick={(e) => {
        if (disabled) return;
        useAnnotatorStore.getState().selectNode(node.id, e.metaKey || e.ctrlKey, e.shiftKey);
      }}
      className={className}
    >
      <Flex align="flex-start" justify="space-between" gap={4}>
        <div className="layer-node__left" style={{ paddingLeft: depth * 16 }}>
          <Flex align="center" gap={4} className="layer-node__name-row">
            {node.isGroup && (
              <span
                className="layer-node__caret"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(node.id)) {
                      next.delete(node.id);
                    } else {
                      next.add(node.id);
                    }
                    return next;
                  });
                }}
              >
                {expanded ? <CaretDownOutlined /> : <CaretRightOutlined />}
              </span>
            )}
            {node.isGroup && (
              <FolderOpenFilled className="layer-node__folder-icon" />
            )}
            <span
              className={
                node.isGroup
                  ? "layer-node__name layer-node__name--group"
                  : "layer-node__name"
              }
              title={node.name}
            >
              {node.name}
            </span>
          </Flex>

          {/* 第二行：类型 + xywh。
              仅对 Select 单独阻止冒泡（防止点 Select 意外 toggle 选中状态）；
              只读 Input 不阻止，点坐标区也能选中节点。 */}
          <Flex align="center" gap={4} wrap="nowrap" justify="flex-end">
            {!node.isGroup && (
              <div onClick={(e) => e.stopPropagation()}>
                <Select
                  size="small"
                  className="layer-node__type-select"
                  value={state.type || undefined}
                  placeholder="类型"
                  popupMatchSelectWidth={false}
                  allowClear
                  options={LAYER_TYPE_OPTIONS.map((o) => ({ value: o.value, label: layerTypeLabel(o.value) }))}
                  labelRender={(label) => {
                    return (
                      <div>
                        <XFilled style={{ color: LAYER_TYPE_MAP[label.value].color, marginRight: 4 }} />{label.label}
                      </div>
                    );
                  }}
                  optionRender={(option) => {
                    const opt = LAYER_TYPE_MAP[option.value as string];
                    if (!opt) return option.label;
                    return (
                      <div>
                        <XFilled style={{ color: opt.color, marginRight: 4 }} />{layerTypeLabel(option.value as string)}
                      </div>
                    );
                  }}
                  onChange={(val) => useAnnotatorStore.getState().setType(node.id, val ?? "")}
                />
              </div>
            )}
            {(["x", "y", "width", "height"] as const).map((field) => (
              <Input
                key={field}
                size="small"
                className="layer-node__coord-input"
                value={node[`a${field}`]!== undefined ? node[`a${field}`] : node[field]}
                prefix={
                  <span className="layer-node__coord-prefix">
                    {field === "width" ? "w" : field === "height" ? "h" : field}
                  </span>
                }
                readOnly
              />
            ))}
          </Flex>
        </div>

        {/* 右侧：眼睛图标 */}
        <div
          className="layer-node__eye"
          onClick={(e) => {
            e.stopPropagation();
            useAnnotatorStore.getState().toggleEye(node.id);
          }}
        >
          {state.eyeOn ? (
            <EyeFilled className="layer-node__eye-on" />
          ) : (
            <EyeInvisibleFilled className="layer-node__eye-off" />
          )}
        </div>
      </Flex>
    </div>
    </Dropdown>
    {node.isGroup && node.children && node.children.length > 0 && expanded && (
      <LayerTree
        nodes={node.children}
        depth={depth + 1}
        nodeRefs={nodeRefs}
        collapsedIds={collapsedIds}
        setCollapsedIds={setCollapsedIds}
        onSlice={onSlice}
        onAdjust={onAdjust}
      />
    )}
  </>
  );
});

/** 递归渲染图层树。props 稳定时完全跳过渲染。 */
const LayerTree = React.memo(function LayerTree({
  nodes,
  depth,
  nodeRefs,
  collapsedIds,
  setCollapsedIds,
  onSlice,
  onAdjust,
}: {
  nodes: PsdLayerNode[];
  depth: number;
  nodeRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  collapsedIds: Set<string>;
  setCollapsedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSlice: (sid: number, nodeId: string) => void;
  onAdjust: (sid: number, nodeId: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <LayerNode
          key={node.id}
          node={node}
          depth={depth}
          nodeRefs={nodeRefs}
          collapsedIds={collapsedIds}
          setCollapsedIds={setCollapsedIds}
          onSlice={onSlice}
          onAdjust={onAdjust}
        />
      ))}
    </>
  );
});

/**
 * 图层面板。从 annotatorStore 读取所有数据，不接受与图层状态相关的 props。
 */
const CANVAS_SELECT_OPTIONS: { value: CanvasSelectMode; label: string }[] = [
  { value: "top", label: "最顶部图层" },
  { value: "ancestors", label: "到父级图层组" },
  { value: "all", label: "所有" },
];

export function PsdLayerPanel() {
  const psdData = useAnnotatorStore((s) => s.psdData);
  const canvasSelectMode = useAnnotatorStore((s) => s.canvasSelectMode);
  const structuralLoading = useAnnotatorStore((s) => s.structuralLoading);
  const layerStates = useAnnotatorStore((s) => s.layerStates);
  const scrollToId = useAnnotatorStore((s) => s.scrollToId);
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingScrollId = useRef<string | null>(null);
  const [navIndex, setNavIndex] = useState(0);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const [sliceOpen, setSliceOpen] = useState(false);
  const [sliceImageB64, setSliceImageB64] = useState("");
  const [sliceNodeId, setSliceNodeId] = useState("");

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustImageB64, setAdjustImageB64] = useState("");
  const [adjustNode, setAdjustNode] = useState<PsdLayerNode | null>(null);

  const handleSlice = useCallback(async (sid: number, nodeId: string) => {
    try {
      const api = await getApi();
      const r = await api.psd_get_layer_preview(sid);
      if (!r.ok || !r.data) {
        message.error(r.error ?? "获取图层预览失败");
        return;
      }
      setSliceImageB64(r.data.previewB64);
      setSliceNodeId(nodeId);
      setSliceOpen(true);
    } catch (e) {
      message.error(String(e));
    }
  }, []);

  const handleAdjust = useCallback(async (sid: number, nodeId: string) => {
    try {
      // 从 store 实时读取最新 node，避免右键菜单闭包持有旧的 ax/ay 快照
      const layers = useAnnotatorStore.getState().psdData?.layers ?? [];
      const findNode = (nodes: PsdLayerNode[]): PsdLayerNode | null => {
        for (const n of nodes) {
          if (n.id === nodeId) return n;
          if (n.children) { const found = findNode(n.children); if (found) return found; }
        }
        return null;
      };
      const latestNode = findNode(layers);
      if (!latestNode) return;

      const api = await getApi();
      const r = await api.psd_get_layer_preview(sid);
      if (!r.ok || !r.data) {
        message.error(r.error ?? "获取图层预览失败");
        return;
      }
      setAdjustImageB64(r.data.previewB64);
      setAdjustNode(latestNode);
      setAdjustOpen(true);
    } catch (e) {
      message.error(String(e));
    }
  }, []);

  const handleAdjustLayerArea = useCallback((updatedNode: PsdLayerNode) => {
    useAnnotatorStore.getState().updateLayerArea(updatedNode);
  }, []);

  const ancestorIdsByNodeId = useMemo(() => {
    const result = new Map<string, string[]>();
    if (!psdData) return result;
    const walk = (nodes: PsdLayerNode[], ancestors: string[]) => {
      for (const n of nodes) {
        result.set(n.id, ancestors);
        if (n.children) walk(n.children, [...ancestors, n.id]);
      }
    };
    walk(psdData.layers, []);
    return result;
  }, [psdData]);

  // 按树遍历顺序收集已选节点 id
  const selectedOrderedIds = useMemo(() => {
    if (!psdData) return [];
    const result: string[] = [];
    const walk = (nodes: PsdLayerNode[]) => {
      for (const n of nodes) {
        if (layerStates[n.id]?.selected) result.push(n.id);
        if (n.children) walk(n.children);
      }
    };
    walk(psdData.layers);
    return result;
  }, [psdData, layerStates]);

  // 选中集合变化时重置导航指针
  const selectedKey = selectedOrderedIds.join(",");
  useEffect(() => {
    setNavIndex(0);
  }, [selectedKey]);

  // 外部选中隐藏节点时，先展开它的祖先组，再交给滚动逻辑定位到节点行。
  useLayoutEffect(() => {
    if (!scrollToId) return;
    pendingScrollId.current = scrollToId;
    const ancestorIds = ancestorIdsByNodeId.get(scrollToId);
    if (!ancestorIds || ancestorIds.length === 0) return;
    setCollapsedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestorIds) {
        if (next.delete(id)) changed = true;
      }
      return changed ? next : prev;
    });
  }, [ancestorIdsByNodeId, scrollToId]);

  function navTo(idx: number) {
    if (selectedOrderedIds.length === 0) return;
    const wrapped = ((idx % selectedOrderedIds.length) + selectedOrderedIds.length) % selectedOrderedIds.length;
    setNavIndex(wrapped);
    useAnnotatorStore.getState().setScrollToId(selectedOrderedIds[wrapped]);
  }

  const selTotal = selectedOrderedIds.length;

  const markAsItems = useMemo<MenuProps["items"]>(
    () =>
      LAYER_TYPE_OPTIONS.map((o) => ({
        key: `mark-${o.value}`,
        label: (
          <span>
            <XFilled style={{ color: o.color, marginRight: 6 }} />
            {layerTypeLabel(o.value)}
          </span>
        ),
        onClick: () => {
          const store = useAnnotatorStore.getState();
          const selectedIds = Object.entries(store.layerStates)
            .filter(([, s]) => s.selected)
            .map(([id]) => id);
          for (const id of selectedIds) store.setTypeForSubtree(id, o.value);
        },
      })),
    [],
  );

  const handleSliceConfirm = useCallback(async (slices: SliceItem[]) => {
    try {
      useAnnotatorStore.setState({ structuralLoading: true });
      const api = await getApi();
      const r = await api.psd_insert_slices(
        sliceNodeId,
        slices.map((s) => ({ id: s.id, base64: s.base64, x: s.x, y: s.y, w: s.w, h: s.h })),
      );
      if (!r.ok || !r.data) {
        useAnnotatorStore.setState({ structuralLoading: false });
        message.error(r.error ?? "切分图层失败");
        return;
      }
      useAnnotatorStore.getState().updateFromPsdOp(r.data);
    } catch (e) {
      useAnnotatorStore.setState({ structuralLoading: false });
      message.error(String(e));
    }
  }, [sliceNodeId]);

  useEffect(() => {
    const targetId = pendingScrollId.current;
    if (!targetId) return;
    requestAnimationFrame(() => {
      nodeRefs.current[targetId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (pendingScrollId.current === targetId) pendingScrollId.current = null;
    });
  }, [collapsedIds, scrollToId]);

  // Alt 键全局监听：
  //   keydown Alt → 若当前有 hover 节点则触发预览（适应"先 hover 再按 Alt"场景）
  //   keyup   Alt → 清除预览
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      e.preventDefault(); // 防止浏览器默认 alt 行为（如聚焦菜单）
      // _hoveredSid 不受 eyeOn 限制，eyeOn=false 的节点同样可预览
      if (_hoveredSid != null) requestLayerPreview(_hoveredSid);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      _previewingSid = null;
      useAnnotatorStore.getState().clearLayerPreview();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  if (!psdData) return null;

  return (
    <Flex vertical className="plp-root">
      <div className="plp-header">
        <Flex align="center" gap={16}>
          <h3>文件信息</h3>
          <Input
            size="small"
            className="plp-header-input"
            value={psdData.psdWidth}
            prefix={
              <span className="layer-node__coord-prefix">
                width
              </span>
            }
            readOnly
          />
          <Input
            size="small"
            className="plp-header-input"
            value={psdData.psdHeight}
            prefix={
              <span className="layer-node__coord-prefix">
                height
              </span>
            }
            readOnly
          />      
        </Flex>
        <Flex align="center" justify="space-between" className="plp-header-select">
          <div>
            <span className="plp-header-label">画布点选</span>
            <Select
              size="small"
              value={canvasSelectMode}
              options={CANVAS_SELECT_OPTIONS}
              onChange={(v) => useAnnotatorStore.getState().setCanvasSelectMode(v)}
              popupMatchSelectWidth={false}
            />
          </div>
          {selTotal > 1 && (
            <Flex align="center" gap={8} className="plp-nav">
              <Button
                icon={<LeftOutlined />}
                variant="text"
                size="small"
                onClick={() => navTo(navIndex - 1)}
              />
              <span className="plp-nav__counter">第 {navIndex + 1} / {selTotal} 已选择</span>
              <Button
                icon={<RightOutlined />}
                variant="text"
                size="small"
                onClick={() => navTo(navIndex + 1)}
              />
              <label className="plp-nav__label">批量操作:</label>
              <Tooltip title={<>删除（<kbd>Del</kbd>）</>}>
                <Button
                  icon={<DeleteOutlined />}
                  variant="text"
                  color="danger"
                  size="small"
                  onClick={() => {
                    const { layerStates } = useAnnotatorStore.getState();
                    const selectedIds = new Set(
                      Object.entries(layerStates).filter(([, s]) => s.selected).map(([id]) => id),
                    );
                    if (selectedIds.size > 0) useAnnotatorStore.getState().requestDelete(selectedIds);
                  }}
                />
              </Tooltip>
              <Tooltip title={<>合并（<kbd>Cmd</kbd>+<kbd>G</kbd>）</>}>
                <Button
                  icon={<GroupOutlined />}
                  variant="text"
                  color="primary"
                  size="small"
                  onClick={() => execMergeToLayer()}
                />
              </Tooltip>
              <Dropdown menu={{ items: markAsItems }} trigger={["hover"]}>
                <Button size="small">
                  标记为
                  <DownOutlined />
                </Button>
              </Dropdown>
            </Flex>
          )}
        </Flex>
      </div>
      <div className="plp-tree-scroll">
        <LayerTree
          nodes={psdData.layers}
          depth={0}
          nodeRefs={nodeRefs}
          collapsedIds={collapsedIds}
          setCollapsedIds={setCollapsedIds}
          onSlice={handleSlice}
          onAdjust={handleAdjust}
        />
        {structuralLoading && (
          <div className="plp-loading-overlay">
            <Spin tip="处理中…" size="large" />
          </div>
        )}
      </div>

      <LayerSliceModal
        open={sliceOpen}
        imageB64={sliceImageB64}
        onClose={() => setSliceOpen(false)}
        onCropConfirm={handleSliceConfirm}
      />

      <AdjustLayerAreaModal
        open={adjustOpen}
        node={adjustNode}
        imageB64={adjustImageB64}
        onClose={() => setAdjustOpen(false)}
        onAdjustLayerArea={handleAdjustLayerArea}
      />
    </Flex>
  );
}
