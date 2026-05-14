import configJson from "../config.json";

export interface LayerTypeOption {
  value: string;
  label: string;
  desc: string;
  color: string;
}

export const LAYER_TYPE_OPTIONS: LayerTypeOption[] = [
  {
    value: "Plate",
    label: "底板",
    desc: "[几何&扁平]具备清晰的几何轮廓（矩形/圆角/多边形/彩带），内部具有大面积平滑或相对单调的连续像素，用来承载别的元素。",
    color: "#ff2d2d",
  },
  {
    value: "Badge_Pill",
    label: "按钮",
    desc: "[3D体积&凸起感]通常偏紧凑（胶囊/正圆），拥有极其明显的打光（顶部高光、内发光）和厚度（底部深色投影、内阴影），有强烈可按压感。",
    color: "#ff7a00",
  },
  // {
  //   value: "Bar_Track",
  //   label: "按钮",
  //   desc: "四边形的框内有文字素材",
  //   color: "#f5d000",
  // },
  {
    value: "Bar_Track",
    label: "进度条",
    desc: "[嵌套&极长] 两层结构具有极端的长宽比，并且视觉上必须呈现**“包含背景长条凹槽 (Track) + 内部高亮填充色块 (Fill)” 的平行双层嵌套结构**。",
    color: "#00c940",
  },
  {
    value: "Sprite",
    label: "图标",
    desc: "边缘透明切边极不规则，内部充满高频复杂的像素细节（脸部、衣服、木纹、裂缝），在视觉上是一幅画/一个具体物件。",
    color: "#0088ff",
  },
  {
    value: "Text",
    label: "文字",
    desc: "极其分明的高对比度笔画像素群（中英文数字）。",
    color: "#9b30ff",
  },
  // {
  //   value: "Decor",
  //   label: "装饰",
  //   desc: "与背景类像素，但是 alpha 有部份是为 0 的",
  //   color: "#ff3399",
  // },
];

/** type 为空时的默认画框颜色，使用 Panel 的颜色 */
export const DEFAULT_BOX_COLOR = LAYER_TYPE_OPTIONS[0].color;

export const LAYER_TYPE_MAP: Record<string, LayerTypeOption> = Object.fromEntries(
  LAYER_TYPE_OPTIONS.map((o) => [o.value, o]),
);

/** value → 序号（Panel→1, Bg→2 …），来自 frontend/src/config.json */
export const LAYER_TYPE_INDEX_MAP: Record<string, number> =
  (configJson as { layer_type_index_map: Record<string, number> }).layer_type_index_map ?? {};

/** 拼接带序号前缀的展示标签，如 "1-面板"；找不到时原样返回 value */
export function layerTypeLabel(value: string): string {
  const opt = LAYER_TYPE_MAP[value];
  if (!opt) return value;
  const idx = LAYER_TYPE_INDEX_MAP[value];
  return idx != null ? `${idx}-${opt.label}` : opt.label;
}
