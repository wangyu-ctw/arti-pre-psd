import { useEffect } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Popover,
  Result,
  Spin,
  Table,
  Tooltip,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  IssuesCloseOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { getApi } from "../api";
import { useAppStore } from "../store";
import type { QueueItem } from "../store";

const FULL_HEIGHT_BOX: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  background: "#ffffff",
  borderRadius: 8,
  padding: 24,
};

const DROP_AREA: React.CSSProperties = {
  height: "100%",
  border: "2px dashed #d9d9d9",
  borderRadius: 8,
  background: "#ffffff",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  transition: "border-color 0.2s, background 0.2s",
};

const QUEUE_WRAP: React.CSSProperties = {
  height: "100%",
  minHeight: 0,
  background: "#ffffff",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const STATUS_TEXT = {
  queued: "排队中",
  running: "执行中",
  success: "处理完成",
  warning: "处理完成（部分步骤被跳过）",
  failed: "处理失败",
};

export function PsdUploader() {
  const { message } = AntApp.useApp();

  const stage = useAppStore((s) => s.preprocessStage);
  const queue = useAppStore((s) => s.queue);
  const psStatus = useAppStore((s) => s.psStatus);
  const setStage = useAppStore((s) => s.setPreprocessStage);
  const setPreprocessError = useAppStore((s) => s.setPreprocessError);
  const setPsStatus = useAppStore((s) => s.setPsStatus);
  const initQueue   = useAppStore((s) => s.initQueue);
  const appendQueue = useAppStore((s) => s.appendQueue);
  const setQueue = useAppStore((s) => s.setQueue);
  const cancelQueueItem = useAppStore((s) => s.cancelQueueItem);
  const resetPreprocess = useAppStore((s) => s.resetPreprocess);
  const requestSetAnnotatingFile = useAppStore((s) => s.requestSetAnnotatingFile);

  useEffect(() => {
    refreshStatus();
  }, []);

  async function refreshStatus() {
    setStage("loading_status");
    try {
      const api = await getApi();
      const r = await api.ps_get_status();
      if (!r.ok || !r.data) {
        setPreprocessError(r.error ?? "ps_get_status 失败");
        setStage("failure");
        return;
      }
      setPsStatus(r.data);
      setStage(r.data.ready ? "idle" : "ps_missing");
    } catch (e) {
      setPreprocessError(String(e));
      setStage("failure");
    }
  }

  async function handlePickPs() {
    try {
      const api = await getApi();
      const r = await api.ps_pick_app();
      if (!r.ok || !r.data) {
        if (r.error !== "用户取消选择") {
          message.error(r.error ?? "选择 Photoshop 失败");
        }
        return;
      }
      setPsStatus(r.data);
      if (r.data.ready) {
        setStage("idle");
        message.success(
          r.data.just_launched
            ? `已选择并启动：${r.data.ps_app_name}`
            : `已选择：${r.data.ps_app_name}`,
        );
      }
    } catch (e) {
      setPreprocessError(String(e));
      setStage("failure");
    }
  }

  async function handlePickPsdAndProcessQueue(append = false) {
    try {
      const api = await getApi();
      const pick = await api.pick_psd_files();
      if (!pick.ok || !pick.data) {
        if (pick.error && pick.error !== "用户取消选择") {
          message.error(pick.error);
        }
        return;
      }

      // append=true 时保留历史记录追加，否则清空重建
      if (append) {
        appendQueue(pick.data);
      } else {
        initQueue(pick.data);
      }
      const paths = pick.data.map((p) => p.path);

      try {
        const openAll = await api.open_psd_queue(paths);
        if (!openAll.ok) {
          setPreprocessError(openAll.error ?? "无法在 Photoshop 中打开队列文件");
          setStage("failure");
          return;
        }

        // 只处理本次新加入（status="queued"）的条目，历史条目不重复跑
        let workQueue = useAppStore.getState().queue.slice();
        const startIdx = workQueue.findIndex((it) => it.status === "queued");
        for (let i = startIdx < 0 ? 0 : startIdx; i < workQueue.length; i++) {
          workQueue[i] = { ...workQueue[i], status: "running", error: undefined, result: undefined };
          setQueue(workQueue.slice());

          const proc = await api.process_psd(workQueue[i].pick.path, true);
          if (!proc.ok || !proc.data) {
            workQueue[i] = { ...workQueue[i], status: "failed", error: proc.error ?? "处理失败" };
          } else {
            workQueue[i] = {
              ...workQueue[i],
              status: proc.data.step_errors ? "warning" : "success",
              result: proc.data,
            };
          }
          setQueue(workQueue.slice());
        }

        const hasNonFailed = workQueue.some(
          (it) => it.status === "success" || it.status === "warning",
        );
        setStage(hasNonFailed ? "success" : "failure");
      } catch (e) {
        setPreprocessError(String(e));
        setStage("failure");
      } finally {
        void api.focus_app();
      }
    } catch (e) {
      setPreprocessError(String(e));
      setStage("failure");
    }
  }

  function statusIcon(item: QueueItem) {
    if (item.status === "queued") {
      return <ClockCircleOutlined style={{ color: "#1677ff" }} />;
    } else if (item.status === "running") {
      return <LoadingOutlined style={{ color: "#1677ff" }} spin />;
    }
    if (item.status === "success") {
      return <CheckCircleOutlined style={{ color: "#52c41a" }} />;
    }
    if (item.status === "warning") {
      return (
        <Popover
          placement="left"
          title="部分步骤被跳过"
          content={      <Alert
            type="warning"
            showIcon
            message="以下步骤出错被跳过，文件已经保存但可能不完美"
            description={
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  color: "#92400e",
                  maxHeight: 240,
                  overflow: "auto",
                }}
              >
                {item.result?.step_errors}
              </pre>
            }
            style={{ width: 420, textAlign: "left" }}
          />}
        >
          <IssuesCloseOutlined style={{ color: "#faad14", cursor: "pointer" }} />
        </Popover>
      );
    }
    return (
      <Popover
        placement="left"
        title="处理失败详情"
        content={<p style={{ color: "#b91c1c", whiteSpace: "pre-wrap", maxWidth: 420, margin: 0 }}>
          {item.error ?? "未知错误"}
        </p>}
      >
        <InfoCircleOutlined style={{ color: "#ff4d4f", cursor: "pointer" }} />
      </Popover>
    );
  }

  async function handleOpenInPs(item: QueueItem) {
    const path = item.result?.path;
    if (!path) return;
    try {
      const api = await getApi();
      const r = await api.open_psd_in_ps(path);
      if (!r.ok) message.error(r.error ?? "在 Photoshop 中打开失败");
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleViewResult(item: QueueItem) {
    const path = item.result?.path;
    if (!path) return;
    // switchTab=true：写入成功（含 confirm 确认后）自动跳转到标注器 Tab
    requestSetAnnotatingFile(path, true);
  }

  const queueTableColumns: ColumnsType<QueueItem> = [
    {
      key: "name",
      render: (_, item) => <div>{item.pick.name}</div>,
    },
    {
      key: "status",
      render: (_, item) => (
        <div>
          {statusIcon(item)}
          {" "}
          {STATUS_TEXT[item.status]}
        </div>
      ),
    },
    {
      key: "actions",
      align: "right",
      width: 120,
      render: (_, item) => {
        if (item.status === "queued") {
          return (
            <Button key="cancel" type="link" size="small" onClick={() => cancelQueueItem(item.id)}>
              取消
            </Button>);
        }
        if (item.status === "warning" || item.status === "success") {
          return (<>
            <Tooltip title="确保所有的psd文件处理完成再打开">
              <Button key="open" type="link" size="small" onClick={() => void handleOpenInPs(item)}>
                打开
              </Button>
            </Tooltip>
            <Button key="view" type="link" size="small" onClick={() => void handleViewResult(item)}>
              标注
            </Button>
            </>);
        }
        return null;
      },
    },
  ];

  if (stage === "loading_status") {
    return (
      <div style={FULL_HEIGHT_BOX}>
        <Spin description="检测 Photoshop 状态..." size="large">
          <div style={{ width: 200, height: 60 }} />
        </Spin>
      </div>
    );
  }

  if (stage === "ps_missing") {
    return (
      <div style={FULL_HEIGHT_BOX}>
        <Result
          status="warning"
          icon={<ExclamationCircleOutlined style={{ color: "#faad14" }} />}
          title="未检测到 Photoshop"
          subTitle="请选择本机已安装的 Photoshop 应用，选定后会自动启动并记住路径，下次启动直接用。"
          extra={[
            <Button key="pick" type="primary" onClick={() => void handlePickPs()}>
              选择 Photoshop 应用
            </Button>,
          ]}
        />
      </div>
    );
  }

  if (stage === "running" || stage === "success" || stage === "failure") {
    let ResultStatus: React.ReactNode;
    switch (stage) {
      case "running":
        const total = queue.length;
        const done = queue.filter(
          (it) => it.status === "success" || it.status === "warning" || it.status === "failed",
        ).length;
        ResultStatus = (
          <Result
            status="info"
            icon={<ClockCircleOutlined style={{ color: "#1677ff" }} />}
            title="队列处理中"
            subTitle={`串行处理中：${done}/${total}`}
          />);
        break;
      case "success":
        const successCount = queue.filter((it) => it.status === "success").length;
        const warningCount = queue.filter((it) => it.status === "warning").length;
        const failedSCount  = queue.filter((it) => it.status === "failed").length;
        ResultStatus = (
          <Result
            status="success"
            icon={<CheckCircleOutlined style={{ color: "#52c41a" }} />}
            title="队列处理完成"
            subTitle={`全部完成：成功 ${successCount}，部分步骤跳过 ${warningCount}，失败 ${failedSCount}`}
            extra={[
              <Button key="reset" onClick={() => resetPreprocess(psStatus)}>返回</Button>,
              <Button key="process" type="primary" onClick={() => void handlePickPsdAndProcessQueue(true)}>再处理一批</Button>,
            ]}
          />);
        break;
      case "failure":
        const failedCount = queue.filter((it) => it.status === "failed").length;
        ResultStatus = (
          <Result
            status="error"
            icon={<InfoCircleOutlined style={{ color: "#ff4d4f" }} />}
            title="队列处理失败"
            subTitle={`本批次全部失败，共 ${failedCount} 个文件`}
            extra={[
              <Button key="reset" onClick={() => resetPreprocess(psStatus)}>返回</Button>,
              <Button key="process" type="primary" onClick={() => void handlePickPsdAndProcessQueue(true)}>再处理一批</Button>,
            ]}
          />);
        break;
      default:
        ResultStatus = null;
        break;
    }

    return (
      <div style={QUEUE_WRAP}>
        {ResultStatus}
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", width: "60%", margin: "0 auto" }}>
          <Table<QueueItem>
            styles={{ root: { borderStartEndRadius: "0", borderRadius: "0" }, content: { borderStartEndRadius: "0", borderRadius: "0" } }}
            showHeader={false}
            dataSource={queue}
            rowKey="id"
            columns={queueTableColumns}
            pagination={false}
            locale={{ emptyText: "暂无队列文件" }}
            size="small"
          />
        </div>
    </div>
    )
  }

  return (
    <div
      style={DROP_AREA}
      onClick={() => void handlePickPsdAndProcessQueue()}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "#4f8cff";
        e.currentTarget.style.background = "#f0f7ff";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "#d9d9d9";
        e.currentTarget.style.background = "#ffffff";
      }}
    >
      <div style={{ textAlign: "center" }}>
        <InboxOutlined style={{ fontSize: 56, color: "#4f8cff" }} />
        <div style={{ marginTop: 16, fontSize: 16 }}>点击选择多个 PSD 文件（串行排队处理）</div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          仅支持 .psd / .psb；失败不会阻塞后续文件
          <p style={{ color: "red" }}>*执行前请确保你的ps里没有正在编辑的文件</p>
        </div>
      </div>
    </div>
  );
}
