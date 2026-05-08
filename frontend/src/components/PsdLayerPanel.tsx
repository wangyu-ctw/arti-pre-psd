import {
  CaretDownOutlined,
  CaretRightOutlined,
  EyeFilled,
  EyeInvisibleFilled,
  FolderOpenFilled,
  XFilled,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { Dropdown, Flex, Input, Select, Tooltip } from "antd";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasSelectMode } from "../store/annotatorStore";
import type { PsdLayerNode } from "../pywebview";
import { useAnnotatorStore } from "../store/annotatorStore";
import { LAYER_TYPE_MAP, LAYER_TYPE_OPTIONS } from "../utils/config";
import "./PsdLayerPanel.css";

const DEFAULT_STATE = { eyeOn: true, type: "", selected: false };

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
          onClick: () => store().mergeGroup(node.id),
        },
        {
          key: "ungroup",
          label: "解散并将子图层上移一级",
          onClick: () => store().deleteNodesUngroup(new Set([node.id])),
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
      onMouseEnter={() => {
        if (!disabled) useAnnotatorStore.getState().setHovered(node.id);
      }}
      onMouseLeave={() => useAnnotatorStore.getState().setHovered(null)}
      onClick={(e) => {
        if (disabled) return;
        useAnnotatorStore.getState().selectNode(node.id, e.metaKey || e.ctrlKey, e.shiftKey);
      }}
      className={className}
    >
      <Flex align="flex-start" justify="space-between" gap={4}>
        {/* 左侧：两行 */}
        <div className="layer-node__left" style={{ paddingLeft: depth * 16 }}>
          {/* 第一行：名称 */}
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
              <Tooltip key={field} title={field}>
                <Input
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
              </Tooltip>
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

  if (!psdData) return null;

  return (
    <Flex vertical className="plp-root">
      <div className="plp-header">
        <Flex align="center" gap={8}>
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
      </div>
    </Flex>
  );
}
