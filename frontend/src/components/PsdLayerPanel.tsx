import {
  CaretDownOutlined,
  CaretRightOutlined,
  EyeFilled,
  EyeInvisibleFilled,
  FolderOpenFilled,
  XFilled,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { Dropdown, Flex, Input, Select, Spin, message } from "antd";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasSelectMode } from "../store/annotatorStore";
import type { PsdLayerNode } from "../pywebview";
import { getApi } from "../api";
import { useAnnotatorStore } from "../store/annotatorStore";
import { LAYER_TYPE_MAP, LAYER_TYPE_OPTIONS } from "../utils/config";
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
}: {
  node: PsdLayerNode;
  depth: number;
  nodeRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
  // 精确订阅：只有本节点的 state 改变才触发重渲染
  const state = useAnnotatorStore((s) => s.layerStates[node.id]) ?? DEFAULT_STATE;

  const [expanded, setExpanded] = useState(true);
  const disabled = !state.eyeOn;

  const className = [
    "layer-node",
    state.selected ? "layer-node--selected" : "",
    disabled ? "layer-node--disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // 右键菜单。只在 node.id / node.isGroup 变化时重算（实际上从不变化）
  const contextMenuItems = useMemo<MenuProps["items"]>(() => {
    const store = () => useAnnotatorStore.getState();
    if (node.isGroup) {
      return [
        {
          key: "merge-to-layer",
          label: "合并选中的节点为一个图层",
          onClick: () => void execMergeToLayer(),
        },
        { type: "divider" as const },
        {
          key: "mark-all",
          label: "将此图层组全部标记为",
          children: LAYER_TYPE_OPTIONS.map((o) => ({
            key: `mark-${o.value}`,
            label: (
              <span>
                <XFilled style={{ color: o.color, marginRight: 6 }} />
                {o.label}
              </span>
            ),
            onClick: () => store().setTypeForSubtree(node.id, o.value),
          })),
        },
        {
          key: "merge",
          label: "合并为一个图层",
          onClick: () => {
            void (async () => {
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
            })();
          },
        },
        {
          key: "ungroup",
          label: "解散并将子图层上移一级",
          onClick: () => {
            void (async () => {
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
            })();
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
        key: "merge-to-layer",
        label: "合并选中的节点为一个图层",
        onClick: () => void execMergeToLayer(),
      },
      { type: "divider" as const },
      {
        key: "delete",
        label: "删除此图层",
        danger: true,
        onClick: () => store().requestDelete(new Set([node.id])),
      },
    ];
  }, [node.id, node.isGroup]);

  return (
  <>
    <Dropdown menu={{ items: contextMenuItems }} trigger={["contextMenu"]}>
    <div
      ref={(el) => { nodeRefs.current[node.id] = el; }}
      onMouseEnter={(e) => {
        if (!disabled) useAnnotatorStore.getState().setHovered(node.id);
        _hoveredSid = node.psdSid ?? null;
        if (e.altKey && node.psdSid != null) {
          void requestLayerPreview(node.psdSid);
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
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
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
            <div onClick={(e) => e.stopPropagation()}>
              <Select
                size="small"
                className="layer-node__type-select"
                value={state.type || undefined}
                placeholder="类型"
                popupMatchSelectWidth={false}
                allowClear
                options={LAYER_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
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
                      <XFilled style={{ color: opt.color, marginRight: 4 }} />{opt.label}
                    </div>
                  );
                }}
                onChange={(val) => useAnnotatorStore.getState().setType(node.id, val ?? "")}
              />
            </div>
            {(["x", "y", "width", "height"] as const).map((field) => (
              <Input
                key={field}
                size="small"
                className="layer-node__coord-input"
                value={node[field]}
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
      <LayerTree nodes={node.children} depth={depth + 1} nodeRefs={nodeRefs} />
    )}
  </>
  );
});

/** 递归渲染图层树。props 稳定时完全跳过渲染。 */
const LayerTree = React.memo(function LayerTree({
  nodes,
  depth,
  nodeRefs,
}: {
  nodes: PsdLayerNode[];
  depth: number;
  nodeRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
}) {
  return (
    <>
      {nodes.map((node) => (
        <LayerNode key={node.id} node={node} depth={depth} nodeRefs={nodeRefs} />
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
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // scrollToId 用 store.subscribe 处理，完全绕开 React render 循环
  useEffect(() => {
    const unsub = useAnnotatorStore.subscribe((state, prev) => {
      if (state.scrollToId !== prev.scrollToId && state.scrollToId) {
        nodeRefs.current[state.scrollToId]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
    return unsub;
  }, []);

  // Alt 键全局监听：
  //   keydown Alt → 若当前有 hover 节点则触发预览（适应"先 hover 再按 Alt"场景）
  //   keyup   Alt → 清除预览
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Alt") return;
      e.preventDefault(); // 防止浏览器默认 alt 行为（如聚焦菜单）
      // _hoveredSid 不受 eyeOn 限制，eyeOn=false 的节点同样可预览
      if (_hoveredSid != null) void requestLayerPreview(_hoveredSid);
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
        <Flex align="center" gap={8} className="plp-header-select">
          <span className="plp-header-label">画布点选</span>
          <Select
            size="small"
            value={canvasSelectMode}
            options={CANVAS_SELECT_OPTIONS}
            onChange={(v) => useAnnotatorStore.getState().setCanvasSelectMode(v)}
            popupMatchSelectWidth={false}
          />
        </Flex>
      </div>
      <div className="plp-tree-scroll">
        <LayerTree nodes={psdData.layers} depth={0} nodeRefs={nodeRefs} />
        {structuralLoading && (
          <div className="plp-loading-overlay">
            <Spin tip="处理中…" size="large" />
          </div>
        )}
      </div>
    </Flex>
  );
}
