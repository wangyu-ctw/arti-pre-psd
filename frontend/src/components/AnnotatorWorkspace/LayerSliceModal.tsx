import { useRef, useState } from "react";
import { Button, Modal } from "antd";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "./LayerSliceModal.css";

export interface SliceItem {
  id: string;
  base64: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── 单行拖拽组件 ───────────────────────────────────────────────────────────

function SortableSliceRow({
  item,
  index,
  onDelete,
}: {
  item: SliceItem;
  index: number;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: "relative",
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="lsm-slice-row">
      <span className="lsm-slice-row__drag" {...attributes} {...listeners}>
        ⠿
      </span>
      <div>
        <img
          src={`data:image/png;base64,${item.base64}`}
          className="lsm-slice-row__thumb"
          alt={`切片 ${index + 1}`}
        />
        <div className="lsm-slice-row__content">
          <span className="lsm-slice-row__info">
            #{index + 1}&nbsp;&nbsp;{item.w}×{item.h}
            <span className="lsm-slice-row__coord">
              x:{item.x} y:{item.y}
            </span>
          </span>
          <Button size="small" danger onClick={onDelete}>
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  imageB64: string;
  onClose: () => void;
  onCropConfirm: (slices: SliceItem[]) => void;
}

export function LayerSliceModal({ open, imageB64, onClose, onCropConfirm }: Props) {
  const [slices, setSlices] = useState<SliceItem[]>([]);
  const [crop, setCrop] = useState<PercentCrop | undefined>(undefined);
  const [cropDisplaySize, setCropDisplaySize] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(useSensor(PointerSensor));

  function handleClose() {
    setSlices([]);
    setCrop(undefined);
    setCropDisplaySize(null);
    onClose();
  }

  function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const container = containerRef.current;
    if (!container) return;
    const { naturalWidth: nw, naturalHeight: nh } = img;
    if (!nw || !nh) return;
    const { clientWidth: cw, clientHeight: ch } = container;
    if (!cw || !ch) return;
    const scale = Math.min(cw / nw, ch / nh);
    setCropDisplaySize({ w: Math.round(nw * scale), h: Math.round(nh * scale) });
  }

  function handleConfirmCrop() {
    if (!crop?.width || !crop?.height || !imgRef.current) return;
    const img = imgRef.current;
    const { naturalWidth: nw, naturalHeight: nh } = img;
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
    const dataUrl = canvas.toDataURL("image/png");
    const b64 = dataUrl.split(",")[1];

    setSlices((prev) => [
      ...prev,
      {
        id: `${Math.random().toString(36).slice(2)}`,
        base64: b64,
        x: pixelX,
        y: pixelY,
        w: pixelW,
        h: pixelH,
      },
    ]);
    setCrop(undefined);
  }

  function handleDelete(id: string) {
    setSlices((prev) => prev.filter((s) => s.id !== id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSlices((items) => {
        const oldIdx = items.findIndex((i) => i.id === active.id);
        const newIdx = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIdx, newIdx);
      });
    }
  }

  function handleConfirmAll() {
    onCropConfirm(slices);
    handleClose();
  }

  return (
    <Modal
      open={open}
      title="切分图层"
      footer={null}
      onCancel={handleClose}
      width="85%"
      styles={{ body: { padding: 12, display: "flex", gap: 12, height: "82vh" } }}
      centered
      destroyOnHidden
    >
      {/* 左侧：截图操作区 */}
      <div className="lsm-left">
        <div ref={containerRef} className="lsm-crop-container">
          <ReactCrop crop={crop} onChange={(_, pc) => setCrop(pc)}>
            <img
              ref={imgRef}
              src={`data:image/png;base64,${imageB64}`}
              alt="layer"
              style={{
                display: "block",
                width: cropDisplaySize?.w,
                height: cropDisplaySize?.h,
              }}
              onLoad={handleImgLoad}
            />
          </ReactCrop>
        </div>
        <div className="lsm-crop-actions">
          <Button
            type="primary"
            disabled={!crop?.width || !crop?.height}
            onClick={handleConfirmCrop}
          >
            确认截取
          </Button>
        </div>
      </div>

      {/* 右侧：切片列表 */}
      <div className="lsm-right">
        <div className="lsm-right__title">已截取（{slices.length}）</div>
        <div className="lsm-right__list">
          {slices.length === 0 ? (
            <div className="lsm-right__empty">暂无截图，请在左侧框选区域后点击"确认截取"</div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={slices.map((s) => s.id)}
                strategy={verticalListSortingStrategy}
              >
                {slices.map((s, i) => (
                  <SortableSliceRow
                    key={s.id}
                    item={s}
                    index={i}
                    onDelete={() => handleDelete(s.id)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
        <div className="lsm-right__footer">
          <Button
            type="primary"
            block
            disabled={slices.length === 0}
            onClick={handleConfirmAll}
          >
            确认切图
          </Button>
        </div>
      </div>
    </Modal>
  );
}
