/**
 * Zustand 全局 store
 */
import { Modal } from "antd";
import { create } from "zustand";
import type { PickPsdFilePayload, ProcessPsdPayload, PsStatusPayload } from "./pywebview";

// ─── 公共类型（从 PsdUploader 提升到全局）──────────────────────────────────

export type QueueItemStatus = "queued" | "running" | "success" | "warning" | "failed";

export type QueueItem = {
  id: string;
  pick: PickPsdFilePayload;
  status: QueueItemStatus;
  result?: ProcessPsdPayload;
  error?: string;
};

export type PreprocessStage =
  | "loading_status"
  | "ps_missing"
  | "idle"
  | "running"
  | "success"
  | "failure";

export type PreprocessBadgeState = "none" | "running" | "success" | "warning" | "error";

// ─── preprocess slice ────────────────────────────────────────────────────────

type PreprocessSlice = {
  preprocessStage: PreprocessStage;
  queue: QueueItem[];
  preprocessError: string | null;

  setPreprocessStage: (stage: PreprocessStage) => void;
  /** 完整替换 queue 数组（每步处理后调用）。 */
  setQueue: (queue: QueueItem[]) => void;
  /** 仅更新 queue 中 id 匹配的单项（减少不必要的引用变化）。 */
  updateQueueItem: (id: string, patch: Partial<Omit<QueueItem, "id">>) => void;
  setPreprocessError: (error: string | null) => void;
  /** 取消排队中的单个文件。 */
  cancelQueueItem: (id: string) => void;
  /** 初始化一批新队列，清空已有数据（首次处理时调用）。 */
  initQueue: (picks: PickPsdFilePayload[]) => void;
  /** 追加一批到已有队列末尾，保留历史记录（"再处理一批"时调用）。 */
  appendQueue: (picks: PickPsdFilePayload[]) => void;
  /** 整批完成后 / 点击"返回"时重置。 */
  resetPreprocess: (psStatus: PsStatusPayload | null) => void;
};

// ─── app slice ───────────────────────────────────────────────────────────────

type AppSlice = {
  psStatus: PsStatusPayload | null;
  setPsStatus: (status: PsStatusPayload | null) => void;
};

// ─── annotator slice ─────────────────────────────────────────────────────────

type AnnotatorSlice = {
  /** 当前正在标注的 PSD 文件绝对路径；空字符串表示未选择。 */
  annotatingFile: string;
  setAnnotatingFile: (path: string) => void;
  /**
   * 统一的"设置标注文件"入口（全局可用）。
   * 新旧路径都非空时弹确认 Modal，用户确认后再写入 store。
   * switchTab=true 时，写入成功后同时切换到标注器 Tab。
   */
  requestSetAnnotatingFile: (newPath: string, switchTab?: boolean) => void;
};

// ─── navigation slice ────────────────────────────────────────────────────────

type NavigationSlice = {
  /** 当前激活的顶层 Tab key */
  activeTab: string;
  setActiveTab: (key: string) => void;
};

// ─── 合并 store ──────────────────────────────────────────────────────────────

type AppStore = PreprocessSlice & AppSlice & AnnotatorSlice & NavigationSlice;

export const useAppStore = create<AppStore>((set) => ({
  // ── preprocess ──
  preprocessStage: "loading_status",
  queue: [],
  preprocessError: null,

  setPreprocessStage: (stage) => set({ preprocessStage: stage }),

  setQueue: (queue) => set({ queue }),

  updateQueueItem: (id, patch) =>
    set((s) => ({
      queue: s.queue.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),

  setPreprocessError: (error) => set({ preprocessError: error }),

  cancelQueueItem: (id) =>
    set((s) => ({ queue: s.queue.filter((it) => it.id !== id) })),

  initQueue: (picks) =>
    set({
      queue: picks.map((p, idx) => ({
        id: `${Date.now()}-${idx}-${p.path}`,
        pick: p,
        status: "queued",
      })),
      preprocessError: null,
      preprocessStage: "running",
    }),

  appendQueue: (picks) =>
    set((s) => {
      const offset = s.queue.length;
      const newItems: QueueItem[] = picks.map((p, idx) => ({
        id: `${Date.now()}-${offset + idx}-${p.path}`,
        pick: p,
        status: "queued",
      }));
      return {
        queue: [...s.queue, ...newItems],
        preprocessError: null,
        preprocessStage: "running",
      };
    }),

  resetPreprocess: (psStatus) =>
    set({
      queue: [],
      preprocessError: null,
      preprocessStage: psStatus?.ready ? "idle" : "ps_missing",
    }),

  // ── app ──
  psStatus: null,
  setPsStatus: (status) => set({ psStatus: status }),

  // ── annotator ──
  annotatingFile: "",
  setAnnotatingFile: (path) => set({ annotatingFile: path }),
  requestSetAnnotatingFile: (newPath, switchTab = false) => {
    const current = useAppStore.getState().annotatingFile;
    const apply = () => {
      set({ annotatingFile: newPath, ...(switchTab ? { activeTab: "annotator" } : {}) });
    };
    if (current.length > 0 && newPath.length > 0) {
      Modal.confirm({
        title: "你确认要切换标注文件？",
        content: "切换后将放弃当前修改",
        okText: "确认切换",
        cancelText: "取消",
        onOk: apply,
      });
    } else {
      apply();
    }
  },

  // ── navigation ──
  activeTab: "preprocess",
  setActiveTab: (key) => set({ activeTab: key }),
}));

// ─── 派生选择器（纯函数，可在非组件处使用）──────────────────────────────────

/** 根据 queue + preprocessStage 派生预处理 tab 角标状态。 */
export function selectPreprocessBadge(store: AppStore): PreprocessBadgeState {
  const { preprocessStage, queue } = store;
  if (preprocessStage === "running") return "running";
  if (preprocessStage === "ps_missing") return "error";
  if (preprocessStage === "failure" && queue.length === 0) return "error";
  if (queue.length === 0) return "none";

  const successCount = queue.filter((it) => it.status === "success").length;
  const warningCount = queue.filter((it) => it.status === "warning").length;
  const failedCount  = queue.filter((it) => it.status === "failed").length;
  const hasPending   = queue.some((it) => it.status === "queued" || it.status === "running");

  if (hasPending) return "running";
  if (failedCount === queue.length) return "error";
  if (failedCount > 0 || warningCount > 0) return "warning";
  if (successCount === queue.length) return "success";
  return "none";
}
