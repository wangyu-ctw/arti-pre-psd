/**
 * 标注器专用 Zustand store。
 *
 * 和主 store (store.ts) 分开，避免标注器频繁的 layerStates 变化污染全局。
 * LayerNode 直接订阅 s.layerStates[node.id]，做到只有自己的状态改变才重渲染。
 */
import { create } from "zustand";
import type { PsdInfoPayload, PsdLayerNode } from "../pywebview";
import type { LayerState } from "../utils/types";

// ─── 树工具（内部用）──────────────────────────────────────────────────────

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

function removeFromTree(nodes: PsdLayerNode[], ids: Set<string>): PsdLayerNode[] {
  return nodes
    .filter((n) => !ids.has(n.id))
    .map((n) => (n.children ? { ...n, children: removeFromTree(n.children, ids) } : n));
}

/**
 * 将 ids 中的组节点替换为其子节点（上移一级），非组节点直接删除。
 * 用于"保留内容"操作。
 */
function ungroupInTree(nodes: PsdLayerNode[], ids: Set<string>): PsdLayerNode[] {
  const result: PsdLayerNode[] = [];
  for (const node of nodes) {
    if (ids.has(node.id)) {
      if (node.isGroup && node.children && node.children.length > 0) {
        // 用子节点替换本组（递归处理子层，以防子层也在 ids 里）
        result.push(...ungroupInTree(node.children, ids));
      }
      // 非组节点或空组：直接删除（不 push）
    } else {
      result.push(
        node.children ? { ...node, children: ungroupInTree(node.children, ids) } : node,
      );
    }
  }
  return result;
}

/**
 * 收集 ids 中每个节点自身 + 所有后代的 id，用于清理 layerStates。
 */
function collectWithDescendants(nodes: PsdLayerNode[], ids: Set<string>): Set<string> {
  const result = new Set<string>();
  const walk = (list: PsdLayerNode[], inherit: boolean) => {
    for (const n of list) {
      const take = inherit || ids.has(n.id);
      if (take) result.add(n.id);
      if (n.children) walk(n.children, take);
    }
  };
  walk(nodes, false);
  return result;
}

// ─── 撤销历史 ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 10;

type HistorySnapshot = {
  layers: PsdLayerNode[];
  layerStates: Record<string, LayerState>;
};

/**
 * 全局屏蔽标志。
 * undo / loadPsdData / clearAll 在 set() 前后将其置 true/false，
 * 防止这些"系统性"状态变更被自动订阅器误判为需要入栈的用户操作。
 * Zustand 的 set() 是同步的，subscribe 在 set() 内部同步触发，
 * 所以 true → set() → false 的顺序完全可靠。
 */
let _skipHistory = false;

/**
 * 比较两个 layerStates 是否有"有意义"的变化（eyeOn / type 改变，或节点增删）。
 * 故意忽略 selected，让选中操作不触发历史入栈。
 * 若引用相同则直接返回 false，无任何额外开销。
 */
function hasMeaningfulStateChange(
  prev: Record<string, LayerState>,
  next: Record<string, LayerState>,
): boolean {
  if (prev === next) return false;
  const prevKeys = Object.keys(prev);
  if (prevKeys.length !== Object.keys(next).length) return true;
  for (const k of prevKeys) {
    const p = prev[k];
    const n = next[k];
    if (!n || p.eyeOn !== n.eyeOn || p.type !== n.type) return true;
  }
  return false;
}

// ─── Store 类型 ───────────────────────────────────────────────────────────

export type PendingDeleteState = { ids: Set<string>; groupCount: number } | null;

/** 点击画布时的命中节点选取策略 */
export type CanvasSelectMode = "top" | "ancestors" | "all";

type AnnotatorStore = {
  psdData: PsdInfoPayload | null;
  layerStates: Record<string, LayerState>;
  hoveredLayerId: string | null;
  scrollToId: string | null;
  /** 待确认删除的状态（由 requestDelete 写入，Modal 读取） */
  pendingDeleteState: PendingDeleteState;
  /** 点击画布时的命中节点选取策略（用户可在图层面板顶栏切换） */
  canvasSelectMode: CanvasSelectMode;
  /** 撤销历史栈（最多 MAX_HISTORY 条） */
  history: HistorySnapshot[];

  /** 加载新 PSD：一次性写入数据并初始化所有节点状态 */
  loadPsdData: (data: PsdInfoPayload) => void;
  /** 清空全部（切换/关闭文件时调用） */
  clearAll: () => void;

  toggleEye: (id: string) => void;
  setType: (id: string, type: string) => void;
  setHovered: (id: string | null) => void;
  setScrollToId: (id: string | null) => void;

  /**
   * 选中逻辑：
   * - metaOrCtrl=true → toggle 单节点
   * - shift=true      → 追加单节点
   * - 普通             → 单选（再次点击取消）
   * 同时更新 scrollToId
   */
  selectNode: (id: string, metaOrCtrl: boolean, shift: boolean) => void;

  /** canvas 点击批量选中：只改实际需要变化的节点，scrollToId = ids[0] */
  selectByIds: (ids: string[]) => void;

  /** 清空所有 selected（点击空白时） */
  clearSelection: () => void;

  /** 读取当前选中 id 集合（供 Delete 确认弹窗使用） */
  getSelectedIds: () => Set<string>;

  /** 从图层树与 layerStates 中删除指定节点（含其所有后代） */
  deleteNodes: (ids: Set<string>) => void;

  /** 删除指定节点，但将组节点的子节点上移一级保留（"保留内容"） */
  deleteNodesUngroup: (ids: Set<string>) => void;

  /** 切换画布点选模式 */
  setCanvasSelectMode: (mode: CanvasSelectMode) => void;

  /**
   * 计算 groupCount 并写入 pendingDeleteState，触发删除确认弹窗。
   * 键盘 Delete 和右键菜单都通过此 action 发起删除流程。
   */
  requestDelete: (ids: Set<string>) => void;
  /** 清除 pendingDeleteState（关闭弹窗） */
  clearPendingDelete: () => void;

  /** 将节点自身及其所有后代的 type 一并设置（图层组批量标记） */
  setTypeForSubtree: (id: string, type: string) => void;

  /**
   * 将图层组合并为普通图层：删除所有子节点，isGroup 改为 false。
   * TODO: 未来可考虑调用 Python API 将 PSD 文件中对应的图层组也合并
   */
  mergeGroup: (id: string) => void;

  /** 撤销上一步操作（Cmd+Z），最多回退 MAX_HISTORY 步 */
  undo: () => void;
};

// ─── 创建 store ───────────────────────────────────────────────────────────

export const useAnnotatorStore = create<AnnotatorStore>((set, get) => ({
  psdData: null,
  layerStates: {},
  hoveredLayerId: null,
  scrollToId: null,
  pendingDeleteState: null,
  canvasSelectMode: "top",
  history: [],

  loadPsdData: (data) => {
    const states: Record<string, LayerState> = {};
    for (const n of flattenNodes(data.layers)) {
      states[n.id] = { eyeOn: true, type: "", selected: false };
    }
    _skipHistory = true;
    set({ psdData: data, layerStates: states, hoveredLayerId: null, scrollToId: null, history: [] });
    _skipHistory = false;
  },

  clearAll: () => {
    _skipHistory = true;
    set({ psdData: null, layerStates: {}, hoveredLayerId: null, scrollToId: null, pendingDeleteState: null, history: [] });
    _skipHistory = false;
  },

  toggleEye: (id) =>
    set((s) => ({
      layerStates: {
        ...s.layerStates,
        [id]: { ...s.layerStates[id], eyeOn: !s.layerStates[id]?.eyeOn },
      },
    })),

  setType: (id, type) =>
    set((s) => ({
      layerStates: { ...s.layerStates, [id]: { ...s.layerStates[id], type } },
    })),

  setHovered: (id) => set({ hoveredLayerId: id }),

  setScrollToId: (id) => set({ scrollToId: id }),

  selectNode: (id, metaOrCtrl, shift) =>
    set((s) => {
      const prev = s.layerStates;
      if (metaOrCtrl) {
        const cur = prev[id];
        if (!cur) return {};
        return {
          layerStates: { ...prev, [id]: { ...cur, selected: !cur.selected } },
          scrollToId: id,
        };
      }
      if (shift) {
        const cur = prev[id];
        if (!cur || cur.selected) return {};
        return {
          layerStates: { ...prev, [id]: { ...cur, selected: true } },
          scrollToId: id,
        };
      }
      // 普通点击：只给真正发生变化的节点创建新对象
      const wasSelected = prev[id]?.selected ?? false;
      let changed = false;
      const next: typeof prev = {};
      for (const k of Object.keys(prev)) {
        const st = prev[k];
        if (k === id) {
          const newSel = !wasSelected;
          if (st.selected !== newSel) {
            next[k] = { ...st, selected: newSel };
            changed = true;
          } else {
            next[k] = st;
          }
        } else if (st.selected) {
          next[k] = { ...st, selected: false };
          changed = true;
        } else {
          next[k] = st;
        }
      }
      return changed ? { layerStates: next, scrollToId: id } : { scrollToId: id };
    }),

  selectByIds: (ids) =>
    set((s) => {
      const hitSet = new Set(ids);
      const prev = s.layerStates;
      let changed = false;
      const next: typeof prev = {};
      for (const k of Object.keys(prev)) {
        const st = prev[k];
        const should = hitSet.has(k);
        if (st.selected !== should) {
          next[k] = { ...st, selected: should };
          changed = true;
        } else {
          next[k] = st;
        }
      }
      return changed
        ? { layerStates: next, scrollToId: ids[0] ?? null }
        : { scrollToId: ids[0] ?? null };
    }),

  clearSelection: () =>
    set((s) => {
      let changed = false;
      const next: typeof s.layerStates = {};
      for (const k of Object.keys(s.layerStates)) {
        const st = s.layerStates[k];
        if (st.selected) {
          next[k] = { ...st, selected: false };
          changed = true;
        } else {
          next[k] = st;
        }
      }
      return changed ? { layerStates: next } : {};
    }),

  getSelectedIds: () =>
    new Set(
      Object.entries(get().layerStates)
        .filter(([, s]) => s.selected)
        .map(([id]) => id),
    ),

  deleteNodes: (ids) =>
    set((s) => {
      if (!s.psdData) return {};
      const allIds = collectWithDescendants(s.psdData.layers, ids);
      const newStates = { ...s.layerStates };
      for (const id of allIds) delete newStates[id];
      return {
        psdData: { ...s.psdData, layers: removeFromTree(s.psdData.layers, ids) },
        layerStates: newStates,
        pendingDeleteState: null,
      };
    }),

  deleteNodesUngroup: (ids) =>
    set((s) => {
      if (!s.psdData) return {};
      const newStates = { ...s.layerStates };
      for (const id of ids) delete newStates[id];
      return {
        psdData: { ...s.psdData, layers: ungroupInTree(s.psdData.layers, ids) },
        layerStates: newStates,
        pendingDeleteState: null,
      };
    }),

  setCanvasSelectMode: (mode) => set({ canvasSelectMode: mode }),

  requestDelete: (ids) => {
    const { psdData: pd } = get();
    const nodeMap = pd
      ? new Map(flattenNodes(pd.layers).map((n) => [n.id, n]))
      : new Map<string, PsdLayerNode>();
    const groupCount = [...ids].filter((id) => nodeMap.get(id)?.isGroup).length;
    set({ pendingDeleteState: { ids, groupCount } });
  },

  clearPendingDelete: () => set({ pendingDeleteState: null }),

  setTypeForSubtree: (id, type) =>
    set((s) => {
      if (!s.psdData) return {};
      const all = flattenNodes(s.psdData.layers);
      const target = all.find((n) => n.id === id);
      if (!target) return {};
      const ids = new Set([id, ...flattenNodes(target.children ?? []).map((n) => n.id)]);
      const newStates = { ...s.layerStates };
      for (const nid of ids) {
        if (newStates[nid]) newStates[nid] = { ...newStates[nid], type };
      }
      return { layerStates: newStates };
    }),

  mergeGroup: (id) =>
    set((s) => {
      if (!s.psdData) return {};
      const all = flattenNodes(s.psdData.layers);
      const groupNode = all.find((n) => n.id === id && n.isGroup);
      if (!groupNode) return {};
      const childIds = new Set(flattenNodes(groupNode.children ?? []).map((n) => n.id));
      const newStates = { ...s.layerStates };
      for (const cid of childIds) delete newStates[cid];
      // TODO: 未来可考虑调用 Python API 将 PSD 文件中对应的图层组也合并
      const updateTree = (nodes: PsdLayerNode[]): PsdLayerNode[] =>
        nodes.map((n) => {
          if (n.id === id) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { children: _c, ...rest } = n;
            return { ...rest, isGroup: false };
          }
          return n.children ? { ...n, children: updateTree(n.children) } : n;
        });
      return {
        psdData: { ...s.psdData, layers: updateTree(s.psdData.layers) },
        layerStates: newStates,
      };
    }),

  undo: () => {
    const s = get();
    if (s.history.length === 0) return;
    const snapshot = s.history[s.history.length - 1];
    _skipHistory = true;
    set({
      psdData: s.psdData ? { ...s.psdData, layers: snapshot.layers } : null,
      layerStates: snapshot.layerStates,
      history: s.history.slice(0, -1),
      pendingDeleteState: null,
    });
    _skipHistory = false;
  },
}));

// ─── 自动历史订阅器 ───────────────────────────────────────────────────────
//
// 替代在每个 action 里手动调 pushSnap 的做法：
// 每当 store 更新后，自动检测是否有"有意义"的数据变化（layers 结构或 eyeOn/type），
// 若有则把变化前的快照压入历史栈。
//
// 屏蔽条件（不入栈）：
//   - _skipHistory === true  → undo / loadPsdData / clearAll 等系统操作
//   - prevState 无 psdData   → 尚未加载文件
//   - state 无 psdData       → clearAll 后
// 选中（selected）/ hover / scroll 等 UI 状态变化不触发入栈。
useAnnotatorStore.subscribe((state, prevState) => {
  if (_skipHistory) return;
  if (!prevState.psdData || !state.psdData) return;

  const layersChanged = prevState.psdData.layers !== state.psdData.layers;
  const statesChanged = hasMeaningfulStateChange(prevState.layerStates, state.layerStates);
  if (!layersChanged && !statesChanged) return;

  const snapshot: HistorySnapshot = {
    layers: prevState.psdData.layers,
    layerStates: prevState.layerStates,
  };
  _skipHistory = true;
  useAnnotatorStore.setState((s) => ({
    history: [...s.history, snapshot].slice(-MAX_HISTORY),
  }));
  _skipHistory = false;
});
