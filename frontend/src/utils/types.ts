export interface LayerState {
  /** 眼睛开关：false → 完全屏蔽（不展示框、不可被选中） */
  eyeOn: boolean;
  /** 标注类型，默认 '' */
  type: string;
  /** 是否被选中 */
  selected: boolean;
}
