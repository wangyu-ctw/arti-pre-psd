import { useEffect, useRef, useState } from "react";
import {
  App as AntApp, Button, Empty, Input, InputNumber,
  Select, Splitter, Table,
} from "antd";
import type { TableColumnsType } from "antd";
import { TableOutlined, FolderOpenOutlined, PictureOutlined, XFilled } from "@ant-design/icons";
import { getApi } from "../api";
import { LAYER_TYPE_INDEX_MAP, LAYER_TYPE_MAP, LAYER_TYPE_OPTIONS, layerTypeLabel } from "../utils/config";
import LayerPreviewModal from "./LayerPreviewModal";
import "./RestoreImage.css";

// ── 数据类型 ────────────────────────────────────────────────────────────────

export interface AssetRow {
  key: string;
  layer_name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer_type: string;
  psd_layer_info: string;
  layer_asset: string;
}

// ── CSV 解析（处理字段内含逗号/引号的情况）────────────────────────────────

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      cols.push(cur); cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function csvField(val: string): string {
  return val.includes(",") || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
}

function parseCsvContent(content: string): {
  psdSize: { width: number; height: number } | null;
  rows: AssetRow[];
} {
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { psdSize: null, rows: [] };

  const [w, h] = lines[0].split(",").map(Number);
  const psdSize = w > 0 && h > 0 ? { width: w, height: h } : null;

  // 兼容旧格式：检查表头第 2 行是否含 layer_type_index 列
  const colHeader = lines[1] ?? "";
  const hasTypeIndex = colHeader.includes("layer_type_index");
  const offset = hasTypeIndex ? 1 : 0;

  const rows: AssetRow[] = lines.slice(2).map((line, idx) => {
    const cols = parseCsvLine(line);
    return {
      key: String(idx),
      layer_name: cols[0]?.trim() ?? "",
      x: Number(cols[1]) || 0,
      y: Number(cols[2]) || 0,
      w: Number(cols[3]) || 0,
      h: Number(cols[4]) || 0,
      layer_type: cols[5]?.trim() ?? "",
      psd_layer_info: cols[6 + offset]?.trim() ?? "",
      layer_asset: cols[7 + offset]?.trim() ?? "",
    };
  });

  return { psdSize, rows };
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

export function RestoreImage() {
  const { message } = AntApp.useApp();

  const [assetsFolder, setAssetsFolder] = useState("");
  const [csvName, setCsvName] = useState("");
  const [psdSize, setPsdSize] = useState<{ width: number; height: number } | null>(null);
  const [assetsData, setAssetsData] = useState<AssetRow[]>([]);
  const [rendering, setRendering] = useState(false);
  const [previewRowKey, setPreviewRowKey] = useState<string | null>(null);
  const [previewImageB64, setPreviewImageB64] = useState<string | null>(null);
  const previewRow = previewRowKey ? (assetsData.find((r) => r.key === previewRowKey) ?? null) : null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const imageCacheRef = useRef<Record<string, HTMLImageElement>>({});
  const imageB64Ref = useRef<Record<string, string>>({});
  const altKeyRef = useRef(false);
  const soloActiveRef = useRef(false);
  const hoveredRowRef = useRef<AssetRow | null>(null);
  const [tableScrollY, setTableScrollY] = useState(400);

  // 动态计算表格可滚动高度
  useEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setTableScrollY(Math.max(100, el.clientHeight - 39));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 监听 Alt 键
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      altKeyRef.current = true;
      if (hoveredRowRef.current) { soloActiveRef.current = true; drawSoloRow(hoveredRowRef.current); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      altKeyRef.current = false;
      if (soloActiveRef.current) {
        soloActiveRef.current = false;
        const size = psdSize;
        if (size) redrawCanvas(assetsData, size);
      }
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => { document.removeEventListener("keydown", down); document.removeEventListener("keyup", up); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [psdSize, assetsData]);

  // ── canvas 绘制 ──────────────────────────────────────────────────────────

  /** 仅重绘，不重新加载图片（供 x/y 修改时调用）。 */
  function redrawCanvas(data: AssetRow[], size: { width: number; height: number }) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    for (const row of data) {
      const img = imageCacheRef.current[row.layer_asset];
      if (!img) continue;
      ctx.drawImage(img, row.x, row.y, row.w, row.h);
    }
  }

  /** Alt+hover 单图层预览。 */
  function drawSoloRow(row: AssetRow) {
    const canvas = canvasRef.current;
    if (!canvas || !psdSize) return;
    const img = imageCacheRef.current[row.layer_asset];
    if (!img) return;
    canvas.width = psdSize.width;
    canvas.height = psdSize.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, psdSize.width, psdSize.height);
    ctx.drawImage(img, row.x, row.y, row.w, row.h);
  }

  /** 加载图片并绘制 canvas（文件夹或 CSV 变化时调用）。 */
  async function renderCanvas(
    data: AssetRow[],
    size: { width: number; height: number },
    folder: string,
  ) {
    const filenames = [...new Set(data.map((r) => r.layer_asset).filter(Boolean))];
    if (!filenames.length) return;

    setRendering(true);
    try {
      const api = await getApi();
      const r = await api.read_images_from_folder(folder, filenames);
      if (!r.ok) { message.error(r.error ?? "读取图片失败"); return; }

      const rawMap = r.data!;
      imageB64Ref.current = rawMap;

      const cache: Record<string, HTMLImageElement> = {};
      await Promise.all(
        Object.entries(rawMap).map(
          ([fname, b64]) =>
            new Promise<void>((resolve) => {
              const img = new Image();
              img.onload = () => { cache[fname] = img; resolve(); };
              img.onerror = () => resolve();
              img.src = `data:image/png;base64,${b64}`;
            }),
        ),
      );
      imageCacheRef.current = cache;
      redrawCanvas(data, size);
    } finally {
      setRendering(false);
    }
  }

  // ── 文件选择 ─────────────────────────────────────────────────────────────

  async function handlePickFolder() {
    const api = await getApi();
    const r = await api.pick_folder();
    if (!r.ok) {
      if (r.error !== "用户取消选择") message.error(r.error ?? "选择失败");
      return;
    }
    const folder = r.data!.path;
    setAssetsFolder(folder);
    imageCacheRef.current = {};
    if (psdSize && assetsData.length > 0) {
      renderCanvas(assetsData, psdSize, folder);
    }
  }

  async function handlePickCsv() {
    const api = await getApi();
    const r = await api.pick_and_read_csv();
    if (!r.ok) {
      if (r.error !== "用户取消选择") message.error(r.error ?? "读取失败");
      return;
    }
    setCsvName(r.data!.name);
    const { psdSize: size, rows } = parseCsvContent(r.data!.content);
    setPsdSize(size);
    setAssetsData(rows);
    imageCacheRef.current = {};
    if (assetsFolder && size && rows.length > 0) {
      renderCanvas(rows, size, assetsFolder);
    }
  }

  function handleClear() {
    setAssetsFolder("");
    setCsvName("");
    setPsdSize(null);
    setAssetsData([]);
    imageCacheRef.current = {};
    imageB64Ref.current = {};
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  // ── 预览 Modal ───────────────────────────────────────────────────────────

  function openPreview(row: AssetRow) {
    setPreviewRowKey(row.key);
    setPreviewImageB64(imageB64Ref.current[row.layer_asset] ?? null);
  }

  function closePreview() {
    setPreviewRowKey(null);
    setPreviewImageB64(null);
  }

  function handleAssetUpdated(key: string, patch: Partial<AssetRow>, newB64: string) {
    const newData = assetsData.map((r) => r.key === key ? { ...r, ...patch } : r);
    setAssetsData(newData);
    setPreviewImageB64(newB64);
    const row = assetsData.find((r) => r.key === key);
    if (row) {
      imageB64Ref.current[row.layer_asset] = newB64;
      const img = new Image();
      img.onload = () => {
        imageCacheRef.current[row.layer_asset] = img;
        if (psdSize) redrawCanvas(newData, psdSize);
      };
      img.src = `data:image/png;base64,${newB64}`;
    }
  }

  // ── 行数据修改 ───────────────────────────────────────────────────────────

  function updateRow(key: string, patch: Partial<AssetRow>) {
    setAssetsData((prev) => prev.map((row) => row.key === key ? { ...row, ...patch } : row));
  }

  function handleXYChange(key: string, field: "x" | "y", value: number | null) {
    if (value === null) return;
    const newData = assetsData.map((row) => row.key === key ? { ...row, [field]: value } : row);
    setAssetsData(newData);
    if (psdSize) redrawCanvas(newData, psdSize);
  }

  // ── 导出图片 ─────────────────────────────────────────────────────────────

  async function handleExportCsv() {
    if (!psdSize || assetsData.length === 0) return;
    const header = `${psdSize.width},${psdSize.height}`;
    const colNames = "layer_name,x,y,w,h,layer_type,layer_type_index,psd_layer_info,layer_asset";
    const rows = assetsData.map((r) =>
      [
        csvField(r.layer_name),
        r.x, r.y, r.w, r.h,
        csvField(r.layer_type),
        LAYER_TYPE_INDEX_MAP[r.layer_type] ?? "",
        csvField(r.psd_layer_info),
        csvField(r.layer_asset),
      ].join(",")
    );
    const content = [header, colNames, ...rows].join("\n");
    const filename = csvName.replace(/\.csv$/i, "")
    const suggested =  `${filename || 'annotation'}_${Number(new Date())}.csv`;
    try {
      const api = await getApi();
      const r = await api.save_csv(content, suggested);
      if (!r.ok && r.error !== "用户取消") message.error(r.error ?? "保存失败");
      else if (r.ok) message.success("已保存");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleExportImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    try {
      const api = await getApi();
      const suggested = csvName.replace(/\.csv$/i, "") || "restored_image";
      const r = await api.save_image_base64(dataUrl, `${suggested}.png`);
      if (!r.ok && r.error !== "用户取消") message.error(r.error ?? "保存失败");
      else if (r.ok) message.success("已保存");
    } catch (e) {
      message.error(String(e));
    }
  }

  // ── 表格列（含交互）─────────────────────────────────────────────────────

  const columns: TableColumnsType<AssetRow> = [
    {
      title: "layer_name",
      dataIndex: "layer_name",
      key: "layer_name",
      width: 180,
      ellipsis: true,
      render: (text: string, row) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: "auto" }}
          onClick={() => openPreview(row)}
        >
          {text}
        </Button>
      ),
    },
    {
      title: "x",
      dataIndex: "x",
      key: "x",
      width: 84,
      render: (val: number, row) => (
        <InputNumber
          size="small"
          value={val}
          style={{ width: 72 }}
          onChange={(v) => handleXYChange(row.key, "x", v)}
        />
      ),
    },
    {
      title: "y",
      dataIndex: "y",
      key: "y",
      width: 84,
      render: (val: number, row) => (
        <InputNumber
          size="small"
          value={val}
          style={{ width: 72 }}
          onChange={(v) => handleXYChange(row.key, "y", v)}
        />
      ),
    },
    { title: "w", dataIndex: "w", key: "w", width: 72 },
    { title: "h", dataIndex: "h", key: "h", width: 72 },
    {
      title: "layer_type",
      dataIndex: "layer_type",
      key: "layer_type",
      width: 120,
      render: (val: string, row) => (
        <Select
          size="small"
          style={{ width: 110 }}
          value={val || undefined}
          placeholder="类型"
          allowClear
          popupMatchSelectWidth={false}
          options={LAYER_TYPE_OPTIONS.map((o) => ({ value: o.value, label: layerTypeLabel(o.value) }))}
          labelRender={(label) => {
            const opt = LAYER_TYPE_MAP[String(label.value)];
            return opt ? (
              <span>
                <XFilled style={{ color: opt.color, marginRight: 4 }} />
                {label.label}
              </span>
            ) : <span>{String(label.label ?? label.value)}</span>;
          }}
          optionRender={(option) => {
            const opt = LAYER_TYPE_MAP[String(option.value)];
            return opt ? (
              <span>
                <XFilled style={{ color: opt.color, marginRight: 4 }} />
                {layerTypeLabel(String(option.value))}
              </span>
            ) : <span>{option.label}</span>;
          }}
          onChange={(v) => updateRow(row.key, { layer_type: v ?? "" })}
        />
      ),
    },
  ];

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  const canvasReady = !!(assetsFolder && psdSize);

  return (
    <>
      <Splitter className="ri-splitter">
        {/* ── 左侧 ── */}
        <Splitter.Panel defaultSize="65%" min="40%">
          <div className="ri-left">
            <div className="ri-controls">
              <div className="ri-row">
                <span className="ri-label">assets 文件夹</span>
                <Input
                  className="ri-path-input"
                  readOnly
                  value={assetsFolder}
                  placeholder="未选择"
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => handlePickFolder()}>
                  选择
                </Button>
              </div>

              <div className="ri-row">
                <span className="ri-label">csv 标注文件</span>
                <Input
                  className="ri-path-input"
                  readOnly
                  value={csvName}
                  placeholder="未选择"
                />
                <Button icon={<TableOutlined />} onClick={() => handlePickCsv()}>
                  选择
                </Button>
              </div>

              <div className="ri-row ri-row--actions">
                <Button onClick={handleClear}>清空</Button>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    icon={<TableOutlined />}
                    disabled={assetsData.length === 0}
                    onClick={() => handleExportCsv()}
                  >
                    导出 CSV
                  </Button>
                  <Button
                    type="primary"
                    icon={<PictureOutlined />}
                    loading={rendering}
                    disabled={!canvasReady || assetsData.length === 0}
                    onClick={() => handleExportImage()}
                  >
                    导出图片
                  </Button>
                </div>
              </div>
            </div>

            <div className="ri-table-wrap" ref={tableWrapRef}>
              <Table<AssetRow>
                columns={columns}
                dataSource={[...assetsData].reverse()}
                scroll={{ y: tableScrollY, x: "max-content" }}
                pagination={false}
                size="small"
                sticky
                onRow={(row) => ({
                  onMouseEnter: () => {
                    hoveredRowRef.current = row;
                    if (altKeyRef.current) { soloActiveRef.current = true; drawSoloRow(row); }
                  },
                  onMouseLeave: () => {
                    hoveredRowRef.current = null;
                    if (soloActiveRef.current) {
                      soloActiveRef.current = false;
                      if (psdSize) redrawCanvas(assetsData, psdSize);
                    }
                  },
                })}
              />
            </div>
          </div>
        </Splitter.Panel>

        {/* ── 右侧 ── */}
        <Splitter.Panel min="20%">
          <div className="ri-right">
            {canvasReady ? (
              <canvas ref={canvasRef} className="ri-canvas" />
            ) : (
              <Empty description="请先选择 assets 文件夹和 csv 标注文件" />
            )}
          </div>
        </Splitter.Panel>
      </Splitter>

      <LayerPreviewModal
        row={previewRow}
        imageB64={previewImageB64}
        assetsFolder={assetsFolder}
        onClose={closePreview}
        onAssetUpdated={handleAssetUpdated}
      />
    </>
  );
}
