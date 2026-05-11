// 类型声明：window.pywebview.api 由 Python 端注入
export interface BackendResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface OpenExternalPayload {
  url: string;
  via?: string;
}

export interface PsStatusPayload {
  /** PS .app 路径（macOS）；为空字符串表示未配置 */
  ps_path: string;
  /** 派生自 ps_path 的应用名，如 "Adobe Photoshop 2026"；空 = 未配置 */
  ps_app_name: string;
  /** 是否检测到 PS 进程在跑 */
  ps_running: boolean;
  /** ready=true 表示已知道 PS 在哪，可以进入"选 PSD 处理"主流程 */
  ready: boolean;
  /** ps_pick_app 选完后顺手 launch 的结果，仅 ps_pick_app 返回时有 */
  just_launched?: boolean;
  launch_error?: string;
}

export interface PickPsdFilePayload {
  path: string;
  name: string;
  size_bytes: number;
}

export interface ProcessPsdPayload {
  /** 输出文件 _clean.psd 的绝对路径 */
  path: string;
  directory: string;
  size_bytes: number;
  /**
   * 部分步骤被跳过时的错误日志（多行文本，每行 "[step] 错误描述"）。
   * 空字符串表示所有步骤都成功。后端用 try/on error 让单步出错不中断
   * 整体流程，把错误集中收上来给前端展示。
   */
  step_errors: string;
}

export interface PsdLayerNode {
  id: string;
  /** Python 端 PsdSession 分配的稳定整数标识（load_psd_session / psd_* 系列接口返回）。
   *  结构性操作（删除/解散/合并）会导致 id（路径字符串）重建索引，
   *  前端通过 psdSid 在新旧 id 之间迁移 layerStates，避免标注数据丢失。
   *  get_psd_info 不返回此字段。 */
  psdSid?: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  isGroup: boolean;
  children?: PsdLayerNode[];
}

export interface PsdInfoPayload {
  thumbnailB64: string;
  psdWidth: number;
  psdHeight: number;
  layers: PsdLayerNode[];
  /** Python 端可回退的结构操作步数（load_psd_session / psd_* 系列接口返回）。
   *  get_psd_info 不返回此字段，使用时需做 undefined 判断。 */
  undoCount?: number;
}

export interface PyApi {
  open_external: (url: string) => Promise<BackendResult<OpenExternalPayload>>;

  /** 探测 PS 状态（不修改任何东西，可重复调用）。 */
  ps_get_status: () => Promise<BackendResult<PsStatusPayload>>;

  /** 弹原生 dialog 让用户手选 PS .app；选完会自动尝试 launch。 */
  ps_pick_app: () => Promise<BackendResult<PsStatusPayload>>;

  /** 启动 / 激活 PS（如果已知 ps_path）；返回最新 status。 */
  ps_launch: () => Promise<BackendResult<PsStatusPayload>>;

  /** 弹原生 dialog 选 .psd / .psb 文件，返回真实磁盘路径（不读字节）。 */
  pick_psd_file: () => Promise<BackendResult<PickPsdFilePayload>>;
  /** 弹原生 dialog 多选 .psd / .psb 文件，返回路径数组。 */
  pick_psd_files: () => Promise<BackendResult<PickPsdFilePayload[]>>;

  /** 弹原生 dialog 仅可选 .psd（不含 .psb）。 */
  pick_psd_only_file: () => Promise<BackendResult<PickPsdFilePayload>>;

  /** 将本应用窗口置顶（PS 队列全部完成后再调，避免每个文件处理完都抢一次焦点）。 */
  focus_app: () => Promise<BackendResult<Record<string, never>>>;

  /** 队列开始前：在 Photoshop 中依次打开所有路径对应的 PSD（不跑清洗脚本）。 */
  open_psd_queue: (paths: string[]) => Promise<BackendResult<{ count: number }>>;

  /**
   * 同步阻塞调用：让 PS 按顺序跑多个 jsx 串联清洗，返回 _clean.psd 路径。
   * 大 PSD 可能要 1~2 分钟，前端要做 loading 反馈。
   * skip_open=true：假定文件已由 open_psd_queue 打开，仅激活该文档后跑脚本。
   */
  process_psd: (
    file_path: string,
    skip_open?: boolean,
  ) => Promise<BackendResult<ProcessPsdPayload>>;

  /**
   * 用 Photoshop 打开指定 PSD 文件（人工检查用）。
   * 调用后 2 秒会把本 APP 窗口重新置顶。
   */
  open_psd_in_ps: (file_path: string) => Promise<BackendResult<Record<string, never>>>;

  /**
   * 解析 PSD 文件，返回原尺寸合成缩略图（base64 PNG）和完整图层树。
   * 已被 load_psd_session 取代用于标注流程，保留供向后兼容。
   */
  get_psd_info: (file_path: string) => Promise<BackendResult<PsdInfoPayload>>;

  /** 释放内存中的 PSD 会话（关闭/切换文件时调用）。 */
  close_psd_session: () => Promise<BackendResult<Record<string, never>>>;

  /**
   * 加载 PSD 并初始化内存会话（PsdSession）。
   * 返回与 get_psd_info 相同的结构，额外含 undoCount（初始为 0）。
   * 后续结构性操作（psd_delete_nodes 等）需先调用此接口。
   */
  load_psd_session: (file_path: string) => Promise<BackendResult<PsdInfoPayload>>;

  /** 删除指定 id 的图层节点（含后代），返回更新后的树和缩略图。 */
  psd_delete_nodes: (ids: string[]) => Promise<BackendResult<PsdInfoPayload>>;

  /** 解散指定图层组（将子节点上移一级），返回更新后的树和缩略图。 */
  psd_ungroup: (ids: string[]) => Promise<BackendResult<PsdInfoPayload>>;

  /** 合并图层组（简化版：移除子节点，组变叶节点），返回更新后的树和缩略图。 */
  psd_merge_group: (node_id: string) => Promise<BackendResult<PsdInfoPayload>>;

  /**
   * 将选中的多个节点合并为单一叶节点，边界框为所有节点的并集（需 >= 2 个）。
   * layer_name 为合并后节点的名称（可选，默认"合并图层"）。
   */
  psd_merge_to_layer: (
    ids: string[],
    layer_name?: string,
  ) => Promise<BackendResult<PsdInfoPayload>>;

  /** 返回当前会话的图层树和 PSD 尺寸（不渲染缩略图，供调试用）。 */
  psd_get_tree: () => Promise<BackendResult<{ psdWidth: number; psdHeight: number; layers: PsdLayerNode[]; undoCount: number }>>;

  /**
   * 合成单个图层/图层组的预览图，返回 base64 PNG 及图层在 PSD 中的位置。
   * sid 为 PsdLayerNode.psdSid；虚拟节点（合并为一个图层产生的占位）返回 ok=false。
   */
  psd_get_layer_preview: (sid: number) => Promise<BackendResult<{
    previewB64: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>>;

  /** 回退上一步结构性操作，返回回退后的树和缩略图；无历史时 ok=false。 */
  psd_undo: () => Promise<BackendResult<PsdInfoPayload>>;

  /**
   * 将后端 PSD 历史栈裁剪到 keep_count 条，释放多余的 BytesIO 快照内存。
   * 在 updateFromPsdOp 更新前端 history 后，传入 history 中 hasPsdChange=true 的数量。
   */
  psd_trim_history: (keep_count: number) => Promise<BackendResult<Record<string, never>>>;

  /** 弹原生 Save 对话框，将当前 PSD 状态写出为新文件。 */
  psd_save_as: (suggested_name: string) => Promise<BackendResult<{ path: string }>>;

  /**
   * 弹原生 Save 对话框，将 CSV 字符串写入用户选择的路径（utf-8-sig 编码）。
   * pywebview 环境下不能用 blob URL 触发下载，必须走此 API。
   */
  save_csv: (
    content: string,
    suggested_name: string,
  ) => Promise<BackendResult<{ path: string }>>;

  /**
   * 弹原生 Save 对话框，将 CSV（含 layer_asset 列）、PSD 和图层切片打包为 ZIP。
   * layer_states_json: annotatorStore.layerStates 的 JSON 序列化。
   * ZIP 结构：{name}.csv / {name}.psd / assets/*.png
   */
  save_zip: (
    layer_states_json: string,
    suggested_name: string,
  ) => Promise<BackendResult<{ path: string }>>;
}

declare global {
  interface Window {
    pywebview?: {
      api: PyApi;
    };
  }
}

export {};
