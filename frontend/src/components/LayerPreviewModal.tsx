import { useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Empty, Modal } from "antd";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { getApi } from "../api";
import type { AssetRow } from "./RestoreImage";

interface Props {
  row: AssetRow | null;
  imageB64: string | null;
  assetsFolder: string;
  onClose: () => void;
  onAssetUpdated: (key: string, patch: Partial<AssetRow>, newB64: string) => void;
}

export default function LayerPreviewModal({ row, imageB64, assetsFolder, onClose, onAssetUpdated }: Props) {
  const { message } = AntApp.useApp();
  const [mode, setMode] = useState<"preview" | "crop">("preview");
  const [crop, setCrop] = useState<PercentCrop | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [cropDisplaySize, setCropDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode("preview");
    setCrop(undefined);
    setCropDisplaySize(null);
  }, [row?.key]);

  function handleCropImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const container = containerRef.current;
    if (!container) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!cw || !ch) return;
    const scale = Math.min(cw / nw, ch / nh);
    setCropDisplaySize({ w: Math.round(nw * scale), h: Math.round(nh * scale) });
  }

  function handleClose() {
    setMode("preview");
    setCrop(undefined);
    setCropDisplaySize(null);
    onClose();
  }

  async function handleConfirmCrop() {
    if (!row || !crop || !imgRef.current) return;
    if (!crop.width || !crop.height) {
      message.warning("请先选择裁切区域");
      return;
    }

    const img = imgRef.current;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const pixelX = Math.round((crop.x / 100) * nw);
    const pixelY = Math.round((crop.y / 100) * nh);
    const pixelW = Math.round((crop.width / 100) * nw);
    const pixelH = Math.round((crop.height / 100) * nh);

    const canvas = document.createElement("canvas");
    canvas.width = pixelW;
    canvas.height = pixelH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, pixelX, pixelY, pixelW, pixelH, 0, 0, pixelW, pixelH);
    const croppedDataUrl = canvas.toDataURL("image/png");

    setSaving(true);
    try {
      const api = await getApi();
      const r = await api.save_asset_file(assetsFolder, row.layer_asset, croppedDataUrl);
      if (!r.ok) {
        message.error(r.error ?? "保存失败");
        return;
      }

      const newB64 = croppedDataUrl.split(",")[1];
      onAssetUpdated(
        row.key,
        { x: row.x + pixelX, y: row.y + pixelY, w: pixelW, h: pixelH },
        newB64,
      );
      message.success("已保存");
      setMode("preview");
      setCrop(undefined);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={row !== null}
      title={row?.layer_name}
      footer={null}
      onCancel={handleClose}
      width="80%"
      styles={{ body: { padding: 8, display: "flex", flexDirection: "column", height: "80vh" } }}
      centered
    >
      {row && (
        imageB64 ? (
          <>
            {/* 图片区 */}
            <div
              ref={containerRef}
              style={{ flex: 1, display: "flex", justifyContent: "center", alignItems: "center", overflow: "hidden", minHeight: 0 }}
            >
              {mode === "preview" ? (
                <img
                  src={`data:image/png;base64,${imageB64}`}
                  alt={row.layer_name}
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                />
              ) : (
                <ReactCrop crop={crop} onChange={(_, pc) => setCrop(pc)}>
                  <img
                    ref={imgRef}
                    src={`data:image/png;base64,${imageB64}`}
                    alt={row.layer_name}
                    style={{
                      display: "block",
                      width: cropDisplaySize?.w,
                      height: cropDisplaySize?.h,
                    }}
                    onLoad={handleCropImgLoad}
                  />
                </ReactCrop>
              )}
            </div>

            {/* 按钮区 */}
            <div style={{ paddingTop: 8, display: "flex", justifyContent: "center", gap: 8, flexShrink: 0 }}>
              {mode === "preview" ? (
                <Button onClick={() => setMode("crop")}>编辑图片</Button>
              ) : (
                <>
                  <Button onClick={() => { setMode("preview"); setCrop(undefined); }}>取消</Button>
                  <Button
                    type="primary"
                    loading={saving}
                    disabled={!crop?.width || !crop?.height}
                    onClick={() => void handleConfirmCrop()}
                  >
                    确定修改，覆盖原图
                  </Button>
                </>
              )}
            </div>
          </>
        ) : (
          <Empty description="图片未加载（请先选择 assets 文件夹）" />
        )
      )}
    </Modal>
  );
}
