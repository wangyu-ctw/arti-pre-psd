import { useCallback, useEffect, useRef, useState } from "react";
import type { PsdLayerNode } from "../pywebview";
import { useAnnotatorStore } from "../store/annotatorStore";
import { DEFAULT_BOX_COLOR, LAYER_TYPE_MAP } from "../utils/config";
import "./PsdPreviewCanvas.css";

/** canvas 重绘节流（ms） */
const REDRAW_THROTTLE_MS = 50;
/** hover 节流（ms），仅用于 canvas mousemove */
const HOVER_THROTTLE_MS = 50;

interface ImgRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function flattenNodes(nodes: PsdLayerNode[]): PsdLayerNode[] {
  const result: PsdLayerNode[] = [];
  const walk = (list: PsdLayerNode[]) => {
    for (const n of list) {
      result.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return result;
}

/** 在图层树中向上收集 nodeId 的所有祖先节点 id */
function getAncestorIds(nodeId: string, layers: PsdLayerNode[]): string[] {
  const result: string[] = [];
  const walk = (nodes: PsdLayerNode[], path: string[]): boolean => {
    for (const n of nodes) {
      if (n.id === nodeId) { result.push(...path); return true; }
      if (n.children && walk(n.children, [...path, n.id])) return true;
    }
    return false;
  };
  walk(layers, []);
  return result;
}

export function PsdPreviewCanvas() {
  const psdData = useAnnotatorStore((s) => s.psdData);
  const layerStates = useAnnotatorStore((s) => s.layerStates);
  const hoveredLayerId = useAnnotatorStore((s) => s.hoveredLayerId);
  const canvasSelectMode = useAnnotatorStore((s) => s.canvasSelectMode);
  const layerPreview = useAnnotatorStore((s) => s.layerPreview);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgRect, setImgRect] = useState<ImgRect>({ left: 0, top: 0, width: 0, height: 0 });

  // 最新 props 快照，供节流回调读取
  const snapRef = useRef({ psdData, layerStates, hoveredLayerId, imgRect });
  snapRef.current = { psdData, layerStates, hoveredLayerId, imgRect };

  // ── 重绘节流 ─────────────────────────────────────────────────────────────

  const redrawLastRef = useRef(0);
  const redrawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paintCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const { psdData: pd, layerStates: ls, hoveredLayerId: hid, imgRect: rect } = snapRef.current;
    if (!canvas || !pd || rect.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = rect.width / pd.psdWidth;
    const scaleY = rect.height / pd.psdHeight;
    const allNodes = flattenNodes(pd.layers);
    const visible = allNodes.filter((n) => ls[n.id]?.eyeOn !== false);

    // hover 优先：有 hover 时只画 hover 节点；无 hover 时画选中节点（或全部）
    const nodesToDraw = hid !== null
      ? visible.filter((n) => n.id === hid)
      : visible.some((n) => ls[n.id]?.selected)
        ? visible.filter((n) => ls[n.id]?.selected)
        : visible;

    const LW = 1.5;
    ctx.lineWidth = LW;
    const MARGIN = LW / 2; // 描边宽度的一半，保证描边完全在 canvas 内

    for (const node of nodesToDraw) {
      const state = ls[node.id];
      const color = state?.type
        ? (LAYER_TYPE_MAP[state.type]?.color ?? DEFAULT_BOX_COLOR)
        : DEFAULT_BOX_COLOR;
      ctx.strokeStyle = color;

      // 原始坐标（canvas 像素空间）
      const rawL = node.x * scaleX;
      const rawT = node.y * scaleY;
      const rawR = (node.x + node.width) * scaleX;
      const rawB = (node.y + node.height) * scaleY;

      // 贴边时往内缩（保证描边不被画布裁掉）
      const l = rawL < MARGIN ? MARGIN : rawL;
      const t = rawT < MARGIN ? MARGIN : rawT;
      const r = rawR > canvas.width - MARGIN ? canvas.width - MARGIN : rawR;
      const b = rawB > canvas.height - MARGIN ? canvas.height - MARGIN : rawB;

      if (r > l && b > t) {
        ctx.strokeRect(l, t, r - l, b - t);
      }
    }
  }, []);

  const scheduleRedraw = useCallback(() => {
    const now = performance.now();
    const rem = REDRAW_THROTTLE_MS - (now - redrawLastRef.current);
    const flush = () => {
      redrawLastRef.current = performance.now();
      redrawTimerRef.current = null;
      paintCanvas();
    };
    if (rem <= 0) {
      if (redrawTimerRef.current) { clearTimeout(redrawTimerRef.current); redrawTimerRef.current = null; }
      flush();
    } else if (!redrawTimerRef.current) {
      redrawTimerRef.current = setTimeout(flush, rem);
    }
  }, [paintCanvas]);

  useEffect(() => {
    scheduleRedraw();
    return () => {
      if (redrawTimerRef.current) { clearTimeout(redrawTimerRef.current); redrawTimerRef.current = null; }
    };
  }, [psdData, layerStates, hoveredLayerId, imgRect, scheduleRedraw]);

  // ── 布局 ─────────────────────────────────────────────────────────────────

  const computeLayout = useCallback(() => {
    const container = containerRef.current;
    if (!container || !psdData || psdData.psdHeight === 0 || psdData.psdWidth === 0) return;
    const containerH = container.clientHeight;
    const containerW = container.clientWidth;
    const imgH = containerH * 0.95;
    const imgW = (imgH / psdData.psdHeight) * psdData.psdWidth;
    setImgRect({ left: (containerW - imgW) / 2, top: (containerH - imgH) / 2, width: imgW, height: imgH });
  }, [psdData?.psdWidth, psdData?.psdHeight]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    computeLayout();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(computeLayout);
    ro.observe(container);
    return () => ro.disconnect();
  }, [computeLayout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || imgRect.width === 0) return;
    canvas.width = Math.round(imgRect.width);
    canvas.height = Math.round(imgRect.height);
  }, [imgRect]);

  // ── hover 节流（canvas mousemove 高频）────────────────────────────────────

  const hoverLatestRef = useRef<string | null>(null);
  const hoverLastRef = useRef(0);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); },
    [],
  );

  function throttledSetHovered(id: string | null) {
    hoverLatestRef.current = id;
    const now = Date.now();
    const rem = HOVER_THROTTLE_MS - (now - hoverLastRef.current);
    const flush = () => {
      hoverLastRef.current = Date.now();
      hoverTimerRef.current = null;
      useAnnotatorStore.getState().setHovered(hoverLatestRef.current);
    };
    if (rem <= 0) {
      if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
      flush();
    } else if (!hoverTimerRef.current) {
      hoverTimerRef.current = setTimeout(flush, rem);
    }
  }

  // ── 坐标工具 ──────────────────────────────────────────────────────────────

  function toPsdCoords(cx: number, cy: number) {
    if (imgRect.width === 0 || imgRect.height === 0 || !psdData) return null;
    return { x: (cx / imgRect.width) * psdData.psdWidth, y: (cy / imgRect.height) * psdData.psdHeight };
  }

  // ── 事件处理 ─────────────────────────────────────────────────────────────

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    e.stopPropagation(); // 阻止冒泡到容器，避免触发容器的 clearSelection
    const canvas = canvasRef.current;
    if (!canvas || !psdData) return;
    const rect = canvas.getBoundingClientRect();
    const coord = toPsdCoords(e.clientX - rect.left, e.clientY - rect.top);
    if (!coord) return;

    const allNodes = flattenNodes(psdData.layers);
    const hitNodes = allNodes.filter((n) => {
      if (layerStates[n.id]?.eyeOn === false) return false;
      return coord.x >= n.x && coord.x <= n.x + n.width && coord.y >= n.y && coord.y <= n.y + n.height;
    });

    if (hitNodes.length === 0) { useAnnotatorStore.getState().clearSelection(); return; }

    let hitIds: string[];
    if (canvasSelectMode === "top") {
      // 视觉最顶层的单个节点（与 hover 逻辑一致，取反序第一个）
      const top = [...hitNodes].reverse()[0];
      hitIds = [top.id];
    } else if (canvasSelectMode === "ancestors") {
      // 视觉最顶层节点 + 它在树中的所有祖先组
      const top = [...hitNodes].reverse()[0];
      hitIds = [top.id, ...getAncestorIds(top.id, psdData.layers)];
    } else {
      // "all"：命中的全部节点（原有行为）
      hitIds = hitNodes.map((n) => n.id);
    }

    useAnnotatorStore.getState().selectByIds(hitIds);
  }

  function handleCanvasMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || !psdData) return;
    const rect = canvas.getBoundingClientRect();
    const coord = toPsdCoords(e.clientX - rect.left, e.clientY - rect.top);
    if (!coord) return;

    const allNodes = flattenNodes(psdData.layers);
    const hit = [...allNodes].reverse().find((n) => {
      if (layerStates[n.id]?.eyeOn === false) return false;
      return coord.x >= n.x && coord.x <= n.x + n.width && coord.y >= n.y && coord.y <= n.y + n.height;
    });

    throttledSetHovered(hit?.id ?? null);
  }

  if (!psdData) return null;

  const posStyle = { left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height };

  // 计算图层预览图的叠加位置（PSD 坐标 → 显示坐标）
  const previewOverlay = layerPreview && imgRect.width > 0 && psdData ? (() => {
    const scaleX = imgRect.width / psdData.psdWidth;
    const scaleY = imgRect.height / psdData.psdHeight;
    return {
      left: imgRect.left + layerPreview.x * scaleX,
      top: imgRect.top + layerPreview.y * scaleY,
      width: layerPreview.width * scaleX,
      height: layerPreview.height * scaleY,
    };
  })() : null;

  return (
    <div
      ref={containerRef}
      className="ppc-container"
      onClick={() => useAnnotatorStore.getState().clearSelection()}
    >
      <img
        src={`data:image/png;base64,${psdData.thumbnailB64}`}
        alt="PSD preview"
        className={`ppc-img${layerPreview ? " ppc-img--dimmed" : ""}`}
        style={posStyle}
      />
      {previewOverlay && (
        <img
          src={`data:image/png;base64,${layerPreview!.previewB64}`}
          alt="layer preview"
          className="ppc-layer-preview"
          style={previewOverlay}
        />
      )}
      <canvas
        ref={canvasRef}
        className="ppc-canvas"
        style={{ left: imgRect.left + 1, top: imgRect.top + 1 }}
        onClick={handleCanvasClick}
        onMouseMove={handleCanvasMouseMove}
        onMouseLeave={() => throttledSetHovered(null)}
      />
    </div>
  );
}
