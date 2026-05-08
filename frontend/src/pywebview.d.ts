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
   */
  get_psd_info: (file_path: string) => Promise<BackendResult<PsdInfoPayload>>;

  /**
   * 弹原生 Save 对话框，将 CSV 字符串写入用户选择的路径（utf-8-sig 编码）。
   * pywebview 环境下不能用 blob URL 触发下载，必须走此 API。
   */
  save_csv: (
    content: string,
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
