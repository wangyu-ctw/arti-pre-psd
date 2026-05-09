import {
  ExportOutlined,
  FolderOpenOutlined,

  SaveOutlined,
  SelectOutlined,
} from "@ant-design/icons";
import { App as AntApp, Button, Flex, Input, Modal, Spin, Splitter } from "antd";
import { useEffect, useState } from "react";
import { getApi } from "../api";
import { useAppStore } from "../store/appStore";
import { useAnnotatorStore } from "../store/annotatorStore";
import type { PsdLayerNode } from "../pywebview";
import { PsdPreviewCanvas } from "./PsdPreviewCanvas";
import { PsdLayerPanel } from "./PsdLayerPanel";

import "./AnnotatorWorkspace.css";

// ─── 工具函数 ──────────────────────────────────────────────────────────────

function flattenNodes(nodes: PsdLayerNode[]): PsdLayerNode[] {
  const result: PsdLayerNode[] = [];
  const walk = (list: PsdLayerNode[]) => {
    for (const n of list) { result.push(n); if (n.children) walk(n.children); }
  };
  walk(nodes);
  return result;
}

// ─── 组件 ──────────────────────────────────────────────────────────────────

/**
 * 标注器工作区。
 * layerStates / hoveredLayerId / scrollToId 全部住在 annotatorStore，
 * 本组件只负责：
 *   1. 监听 annotatingFile，调后端 API，驱动 store.loadPsdData / clearAll
 *   2. 监听键盘 Delete 键，弹确认框后调 store.deleteNodes
 *   3. 提供导出 CSV 的入口（读 store.getState 快照）
 */
export function AnnotatorWorkspace() {
  const { message } = AntApp.useApp();

  const annotatingFile = useAppStore((s) => s.annotatingFile);
  const requestSetAnnotatingFile = useAppStore((s) => s.requestSetAnnotatingFile);

  const psdData = useAnnotatorStore((s) => s.psdData);
  const pendingDelete = useAnnotatorStore((s) => s.pendingDeleteState);
  const [loading, setLoading] = useState(false);

  const loadPsdData = useAnnotatorStore((s) => s.loadPsdData);
  const clearAll = useAnnotatorStore((s) => s.clearAll);

  // ── 监听 annotatingFile，加载 PSD ─────────────────────────────────────────

  useEffect(() => {
    if (!annotatingFile.trim()) {
      clearAll();
      // 释放 Python 端内存中的 PSD 会话（fire-and-forget，失败不影响 UI）
      void getApi().then((api) => api.close_psd_session()).catch(() => {});
      return;
    }

    // 切换文件时立即清空旧状态，防止加载期间 Cmd+Z 触发上一个文件的旧 undo 历史
    clearAll();

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const api = await getApi();
        const r = await api.load_psd_session(annotatingFile);
        if (cancelled) return;
        if (!r.ok || !r.data) {
          message.error(r.error ?? "无法解析 PSD 文件");
          console.error(r.error, r.data);
          setLoading(false);
          return;
        }
        loadPsdData(r.data);
      } catch (e) {
        if (!cancelled) message.error(String(e));
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [annotatingFile, message, loadPsdData, clearAll]);

  // ── 键盘 Delete：二次确认后删除选中节点 ──────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Cmd/Ctrl + G → 将选中节点编为一组
      if ((e.metaKey || e.ctrlKey) && e.key === "g") {
        e.preventDefault();
        const selectedIds = [
          ...Object.entries(useAnnotatorStore.getState().layerStates)
            .filter(([, s]) => s.selected)
            .map(([id]) => id),
        ];
        if (selectedIds.length < 2) {
          message.info("请先选中 2 个以上节点再合并");
          return;
        }
        void (async () => {
          try {
            useAnnotatorStore.setState({ structuralLoading: true });
            const api = await getApi();
            const r = await api.psd_merge_to_layer(selectedIds);
            if (!r.ok || !r.data) {
              useAnnotatorStore.setState({ structuralLoading: false });
              message.error(r.error ?? "合并失败");
              return;
            }
            useAnnotatorStore.getState().updateFromPsdOp(r.data);
          } catch (err) {
            useAnnotatorStore.setState({ structuralLoading: false });
            message.error(String(err));
          }
        })();
        return;
      }

      // Cmd/Ctrl + Z → 撤销（最多 10 步，无重做）
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        const { history, undo } = useAnnotatorStore.getState();
        if (history.length === 0) return;

        const hasPsdChange = undo();
        if (!hasPsdChange) {
          message.info(`已撤销（还可回退 ${history.length - 1} 步）`, 1.5);
          return;
        }

        // 该步涉及 PSD 结构性改动，同步撤销 Python 端
        void (async () => {
          try {
            useAnnotatorStore.setState({ structuralLoading: true });
            const api = await getApi();
            const r = await api.psd_undo();
            if (!r.ok || !r.data) {
              useAnnotatorStore.setState({ structuralLoading: false });
              message.error(r.error ?? "PSD 撤销失败");
              return;
            }
            useAnnotatorStore.getState().updateFromPsdOp(r.data, true);
            message.info(`已撤销（还可回退 ${history.length - 1} 步）`, 1.5);
          } catch (err) {
            useAnnotatorStore.setState({ structuralLoading: false });
            message.error(String(err));
          }
        })();
        return;
      }

      // Delete / Backspace → 删除选中节点
      if (e.key !== "Delete" && e.key !== "Backspace") return;

      const { layerStates } = useAnnotatorStore.getState();
      const selectedIds = new Set(
        Object.entries(layerStates).filter(([, s]) => s.selected).map(([id]) => id),
      );
      if (selectedIds.size === 0) return;

      e.preventDefault();
      useAnnotatorStore.getState().requestDelete(selectedIds);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // ── 文件操作 ─────────────────────────────────────────────────────────────

  async function handlePickFile() {
    try {
      const api = await getApi();
      const r = await api.pick_psd_only_file();
      if (!r.ok || !r.data) {
        if (r.error && r.error !== "用户取消选择") message.error(r.error);
        return;
      }
      requestSetAnnotatingFile(r.data.path);
    } catch (e) {
      message.error(String(e));
      console.error(e);
    }
  }

  async function handleOpenInPs() {
    const p = annotatingFile.trim();
    if (!p) return;
    try {
      const api = await getApi();
      const r = await api.open_psd_in_ps(p);
      if (!r.ok) message.error(r.error ?? "无法在 Photoshop 中打开");
      console.error(r.error, r.data);
    } catch (e) {
      message.error(String(e));
      console.error(e);
    }
  }

  // ── Python 结构性操作（通过 Python API + updateFromPsdOp 更新） ──────────

  /**
   * 删除确认后调用：发起 Python 删除/解散请求，并用返回结果更新 store。
   * 替代原本直接调用 store.deleteNodes / store.deleteNodesUngroup 的做法。
   */
  async function handleDeleteConfirm(mode: "delete" | "ungroup") {
    if (!pendingDelete) return;
    const ids = [...pendingDelete.ids];
    useAnnotatorStore.getState().clearPendingDelete();
    try {
      useAnnotatorStore.setState({ structuralLoading: true });
      const api = await getApi();
      const r =
        mode === "delete"
          ? await api.psd_delete_nodes(ids)
          : await api.psd_ungroup(ids);
      if (!r.ok || !r.data) {
        useAnnotatorStore.setState({ structuralLoading: false });
        message.error(r.error ?? "操作失败");
        return;
      }
      useAnnotatorStore.getState().updateFromPsdOp(r.data); // 内部已清 structuralLoading
    } catch (e) {
      useAnnotatorStore.setState({ structuralLoading: false });
      message.error(String(e));
    }
  }


  /** 弹原生 Save 对话框，将当前 PSD 状态写出为新文件。 */
  async function handleSavePsd() {
    const baseName = annotatingFile.split(/[\\/]/).pop() ?? "output";
    const suggested = baseName.replace(/\.psd$/i, "") + "_annotated.psd";
    try {
      const api = await getApi();
      const r = await api.psd_save_as(suggested);
      if (!r.ok) {
        if (r.error !== "用户取消") message.error(r.error ?? "保存失败");
        return;
      }
      message.success(`已保存：${r.data?.path ?? ""}`);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleDownloadCsv() {
    // 直接读快照，不订阅 store（避免触发重渲染）
    const { psdData: pd, layerStates } = useAnnotatorStore.getState();
    if (!pd) return;

    const rows: string[] = [];
    for (const node of flattenNodes(pd.layers)) {
      const state = layerStates[node.id];
      if (!state?.type) continue;
      const layerInfo = JSON.stringify({ layer_name: node.name });
      const escapedInfo = `"${layerInfo.replace(/"/g, '""')}"`;
      rows.push(`${state.type},${node.x},${node.y},${node.width},${node.height},${escapedInfo}`);
    }

    if (rows.length === 0) {
      message.warning("暂无已标注的图层，请先为图层选择类型");
      return;
    }

    const content = ["class_label,x,y,w,h,psd_layer_info", ...rows].join("\n");
    const baseName = annotatingFile.split(/[\\/]/).pop() ?? "export";
    const filename = baseName.replace(/\.psd$/i, "") + ".csv";

    // pywebview 环境下 blob URL + a.click() 会导航页面，必须走 Python 原生 Save 对话框
    try {
      const api = await getApi();
      const r = await api.save_csv(content, filename);
      if (!r.ok && r.error !== "用户取消") message.error(r.error ?? "保存失败");
    } catch (e) {
      message.error(String(e));
    }
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  return (
    <Flex vertical className="aw-root">
      {/* 顶部工具栏 */}
      <div className="aw-toolbar">
        <Flex gap={8} align="center">
          <Input
            className="aw-file-input"
            allowClear
            value={annotatingFile}
            onClear={() => requestSetAnnotatingFile("")}
            placeholder="本地 PSD 文件路径"
          />
          <Button
            type="primary"
            icon={<SelectOutlined />}
            onClick={() => void handlePickFile()}
          >
            选择
          </Button>
          <Button
            icon={<FolderOpenOutlined />}
            disabled={!annotatingFile.trim()}
            onClick={() => void handleOpenInPs()}
          >
            用 PS 打开
          </Button>
          <Button
            icon={<ExportOutlined />}
            onClick={() => void handleDownloadCsv()}
            disabled={!annotatingFile.trim() || !psdData}
          >
            导出 CSV
          </Button>

          <Button
            icon={<SaveOutlined />}
            onClick={() => void handleSavePsd()}
            disabled={!annotatingFile.trim() || !psdData}
            title="将当前 PSD 结构另存为新文件"
          >
            保存 PSD
          </Button>
        </Flex>
      </div>

      {/* 主体 */}
      <Splitter
        orientation="horizontal"
        styles={{
          root: { flex: 1, minHeight: 0 },
          dragger: { background: "#f0f0f0" },
        }}
      >
        {/* 展示区 */}
        <Splitter.Panel defaultSize="40%" min="20%" max="80%">
          <div className="aw-preview-panel">
            {loading && (
              <Flex className="aw-loading-overlay" align="center" justify="center">
                <Spin tip="正在解析 PSD…" />
              </Flex>
            )}
            {!loading && psdData && <PsdPreviewCanvas />}
            {!loading && !psdData && (
              <Flex align="center" justify="center" className="aw-empty-hint">
                请选择 PSD 文件
              </Flex>
            )}
          </div>
        </Splitter.Panel>

        {/* 图层区 */}
        <Splitter.Panel>
          <div className="aw-layer-panel">
            {psdData ? (
              <PsdLayerPanel />
            ) : (
              <Flex align="center" justify="center" className="aw-empty-hint">
                暂无图层信息
              </Flex>
            )}
          </div>
        </Splitter.Panel>
      </Splitter>

      {/* ── 删除确认弹窗 ──────────────────────────────────────────────────── */}
      <Modal
        open={pendingDelete !== null}
        title={`删除 ${pendingDelete?.ids.size ?? 0} 个节点`}
        onCancel={() => useAnnotatorStore.getState().clearPendingDelete()}
        footer={null}
        destroyOnHidden
      >
        {pendingDelete?.groupCount ? (
          <>
            <p>
              其中包含 <strong>{pendingDelete.groupCount}</strong> 个图层组，请选择处理方式：
            </p>
            <p className="aw-delete-hint">此操作不可撤销。</p>
            <Flex justify="flex-end" gap={8} className="aw-delete-footer">
              <Button onClick={() => useAnnotatorStore.getState().clearPendingDelete()}>
                取消
              </Button>
              <Button onClick={() => void handleDeleteConfirm("ungroup")}>
                保留内容，将子节点上移一级
              </Button>
              <Button
                danger
                type="primary"
                onClick={() => void handleDeleteConfirm("delete")}
              >
                删除整组，并删除子节点
              </Button>
            </Flex>
          </>
        ) : (
          <>
            <p>此操作不可撤销，将从当前标注中移除这些节点。</p>
            <Flex justify="flex-end" gap={8} className="aw-delete-footer">
              <Button onClick={() => useAnnotatorStore.getState().clearPendingDelete()}>
                取消
              </Button>
              <Button
                danger
                type="primary"
                onClick={() => void handleDeleteConfirm("delete")}
              >
                确认删除
              </Button>
            </Flex>
          </>
        )}
      </Modal>
    </Flex>
  );
}
