import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import type { PsdLayerNode } from "../../pywebview";

interface Props {
  open: boolean;
  node: PsdLayerNode | null;
  imageB64: string;
  onClose: () => void;
  onAdjustLayerArea: (node: PsdLayerNode) => void;
}

/** 根据节点现有的 ax/ay/awidth/aheight 计算初始百分比裁剪区；无则默认全图 */
function initCrop(node: PsdLayerNode): PercentCrop {
  if (
    node.ax != null &&
    node.ay != null &&
    node.awidth != null &&
    node.aheight != null
  ) {
    return {
      unit: "%",
      x: ((node.ax - node.x) / node.width) * 100,
      y: ((node.ay - node.y) / node.height) * 100,
      width: (node.awidth / node.width) * 100,
      height: (node.aheight / node.height) * 100,
    };
  }
  return { unit: "%", x: 0, y: 0, width: 100, height: 100 };
}

export function AdjustLayerAreaModal({
  open,
  node,
  imageB64,
  onClose,
  onAdjustLayerArea,
}: Props) {
  const [crop, setCrop] = useState<PercentCrop | undefined>(undefined);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 每次打开或切换节点时重置裁剪区
  useEffect(() => {
    if (open && node) {
      setCrop(initCrop(node));
      setDisplaySize(null);
    }
  }, [open, node]);

  function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const container = containerRef.current;
    if (!container) return;
    const { naturalWidth: nw, naturalHeight: nh } = img;
    if (!nw || !nh) return;
    const { clientWidth: cw, clientHeight: ch } = container;
    if (!cw || !ch) return;
    const scale = Math.min(cw / nw, ch / nh);
    setDisplaySize({ w: Math.round(nw * scale), h: Math.round(nh * scale) });
  }

  function handleConfirm() {
    if (!crop || !node) return;
    const ax = Math.round(node.x + (crop.x / 100) * node.width);
    const ay = Math.round(node.y + (crop.y / 100) * node.height);
    const awidth = Math.round((crop.width / 100) * node.width);
    const aheight = Math.round((crop.height / 100) * node.height);
    onAdjustLayerArea({ ...node, ax, ay, awidth, aheight });
    onClose();
  }

  return (
    <Modal
      open={open}
      title="修正边框"
      footer={null}
      onCancel={onClose}
      width="65%"
      styles={{
        body: {
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          height: "72vh",
        },
      }}
      centered
      destroyOnHidden
    >
      {/* 图层图片 + 裁剪交互区 */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#eee",
          borderRadius: 4,
        }}
      >
        {imageB64 && (
          <ReactCrop crop={crop} onChange={(_, pc) => setCrop(pc)}>
            <img
              ref={imgRef}
              src={`data:image/png;base64,${imageB64}`}
              alt="layer"
              style={{
                display: "block",
                width: displaySize?.w,
                height: displaySize?.h,
              }}
              onLoad={handleImgLoad}
            />
          </ReactCrop>
        )}
      </div>

      {/* 底部：坐标信息 + 确认按钮 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ color: "#888", fontSize: 12 }}>
          {node && crop
            ? (() => {
                const ax = Math.round(node.x + (crop.x / 100) * node.width);
                const ay = Math.round(node.y + (crop.y / 100) * node.height);
                const aw = Math.round((crop.width / 100) * node.width);
                const ah = Math.round((crop.height / 100) * node.height);
                return `修正后 x:${ax} y:${ay} w:${aw} h:${ah}`;
              })()
            : ""}
        </span>
        <Button
          type="primary"
          disabled={!crop?.width || !crop?.height}
          onClick={handleConfirm}
        >
          确认修正
        </Button>
      </div>
    </Modal>
  );
}
