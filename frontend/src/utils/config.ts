export interface LayerTypeOption {
  value: string;
  label: string;
  desc: string;
  color: string;
}

export const LAYER_TYPE_OPTIONS: LayerTypeOption[] = [
  {
    value: "Panel",
    label: "1-面板",
    desc: "很长或者很宽，上面放这一个或者多个素材",
    color: "#ff2d2d",
  },
  {
    value: "Bg",
    label: "2-背景",
    desc: "alpha 都是不为 0 的",
    color: "#ff7a00",
  },
  {
    value: "Btn",
    label: "3-按钮",
    desc: "四边形的框内有文字素材",
    color: "#f5d000",
  },
  {
    value: "Icon",
    label: "4-图标",
    desc: "不规则的形状",
    color: "#00c940",
  },
  {
    value: "Bar",
    label: "5-进度条",
    desc: "长条形的素材",
    color: "#0088ff",
  },
  {
    value: "Text",
    label: "6-文字",
    desc: "需要紧贴文字区域的框",
    color: "#9b30ff",
  },
  {
    value: "Decor",
    label: "7-装饰",
    desc: "与背景类像素，但是 alpha 有部份是为 0 的",
    color: "#ff3399",
  },
];

/** type 为空时的默认画框颜色，使用 Panel 的颜色 */
export const DEFAULT_BOX_COLOR = LAYER_TYPE_OPTIONS[0].color;

export const LAYER_TYPE_MAP: Record<string, LayerTypeOption> = Object.fromEntries(
  LAYER_TYPE_OPTIONS.map((o) => [o.value, o]),
);
