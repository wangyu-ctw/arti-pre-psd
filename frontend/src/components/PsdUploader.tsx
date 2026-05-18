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
  InfoCircleOutlined,
  IssuesCloseOutlined,
  InboxOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { getApi } from "../api";
import { useAppStore } from "../store/appStore";
import type { QueueItem } from "../store/appStore";
import "./PsdUploader.css";

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
  const initQueue = useAppStore((s) => s.initQueue);
  const appendQueue = useAppStore((s) => s.appendQueue);
  const updateQueueItem = useAppStore((s) => s.updateQueueItem);
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
        setStage("ps_missing");
        return;
      }
      setPsStatus(r.data);
      setStage(r.data.ready ? "idle" : "ps_missing");
    } catch (e) {
      setPreprocessError(String(e));
      setStage("ps_missing");
    }
  }

  async function handlePickPs() {
    try {
      const api = await getApi();
      const r = await api.ps_pick_app();
      if (!r.ok || !r.data) {
        if (r.error !== "用户取消选择") {
          message.error(r.error ?? "选择 Photoshop 失败");
          console.error(r.error, r.data);
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
          console.error(pick.error, pick.data);
        }
        return;
      }

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

        const workQueue = useAppStore.getState().queue.slice();
        const startIdx = workQueue.findIndex((it) => it.status === "queued");
        for (let i = startIdx < 0 ? 0 : startIdx; i < workQueue.length; i++) {
          const currentItem = useAppStore
            .getState()
            .queue
            .find((it) => it.id === workQueue[i].id);
          if (!currentItem || currentItem.status !== "queued") {
            continue;
          }

          updateQueueItem(currentItem.id, { status: "running", error: undefined, result: undefined });

          const proc = await api.process_psd(currentItem.pick.path, true);
          const stillInQueue = useAppStore
            .getState()
            .queue
            .some((it) => it.id === currentItem.id);
          if (!stillInQueue) continue;

          updateQueueItem(
            currentItem.id,
            !proc.ok || !proc.data
              ? { status: "failed", error: proc.error ?? "处理失败" }
              : {
                  status: proc.data.step_errors ? "warning" : "success",
                  result: proc.data,
                },
          );
        }

        const finalQueue = useAppStore.getState().queue;
        const hasNonFailed = finalQueue.some(
          (it) => it.status === "success" || it.status === "warning",
        );
        setStage(hasNonFailed ? "success" : "failure");
      } catch (e) {
        setPreprocessError(String(e));
        setStage("failure");
      } finally {
        api.focus_app();
      }
    } catch (e) {
      setPreprocessError(String(e));
      setStage("failure");
    }
  }

  function statusIcon(item: QueueItem) {
    if (item.status === "queued") {
      return <ClockCircleOutlined className="psu-icon-primary" />;
    } else if (item.status === "running") {
      return <LoadingOutlined className="psu-icon-primary" spin />;
    }
    if (item.status === "success") {
      return <CheckCircleOutlined className="psu-icon-success" />;
    }
    if (item.status === "warning") {
      return (
        <Popover
          placement="left"
          title="部分步骤被跳过"
          content={
            <Alert
              type="warning"
              showIcon
              message="以下步骤出错被跳过，文件已经保存但可能不完美"
              description={<pre className="psu-popover-pre">{item.result?.step_errors}</pre>}
              className="psu-popover-alert"
            />
          }
        >
          <IssuesCloseOutlined className="psu-icon-warning psu-icon-pointer" />
        </Popover>
      );
    }
    return (
      <Popover
        placement="left"
        title="处理失败详情"
        content={<p className="psu-popover-error-text">{item.error ?? "未知错误"}</p>}
      >
        <InfoCircleOutlined className="psu-icon-danger psu-icon-pointer" />
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
      console.error(e);
    }
  }

  function handleViewResult(item: QueueItem) {
    const path = item.result?.path;
    if (!path) return;
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
            </Button>
          );
        }
        if (item.status === "warning" || item.status === "success") {
          return (
            <>
              <Tooltip title="确保所有的psd文件处理完成再打开">
                <Button key="open" type="link" size="small" onClick={() => handleOpenInPs(item)}>
                  打开
                </Button>
              </Tooltip>
              <Button key="view" type="link" size="small" onClick={() => handleViewResult(item)}>
                标注
              </Button>
            </>
          );
        }
        return null;
      },
    },
  ];

  if (stage === "loading_status") {
    return (
      <div className="psu-full-height-box">
        <Spin description="检测 Photoshop 状态..." size="large">
          <div className="psu-spin-placeholder" />
        </Spin>
      </div>
    );
  }

  if (stage === "ps_missing") {
    return (
      <div className="psu-full-height-box">
        <Result
          status="warning"
          icon={<ExclamationCircleOutlined className="psu-result-warning-icon" />}
          title="未检测到 Photoshop"
          subTitle="请选择本机已安装的 Photoshop 应用，选定后会自动启动并记住路径，下次启动直接用。"
          extra={[
            <Button key="pick" type="primary" onClick={() => handlePickPs()}>
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
      case "running": {
        const total = queue.length;
        const done = queue.filter(
          (it) => it.status === "success" || it.status === "warning" || it.status === "failed",
        ).length;
        ResultStatus = (
          <Result
            status="info"
            icon={<ClockCircleOutlined className="psu-icon-primary" />}
            title="队列处理中"
            subTitle={`串行处理中：${done}/${total}`}
          />
        );
        break;
      }
      case "success": {
        const successCount = queue.filter((it) => it.status === "success").length;
        const warningCount = queue.filter((it) => it.status === "warning").length;
        const failedSCount = queue.filter((it) => it.status === "failed").length;
        ResultStatus = (
          <Result
            status="success"
            icon={<CheckCircleOutlined className="psu-icon-success" />}
            title="队列处理完成"
            subTitle={`全部完成：成功 ${successCount}，部分步骤跳过 ${warningCount}，失败 ${failedSCount}`}
            extra={[
              <Button key="reset" onClick={() => resetPreprocess(psStatus)}>
                返回
              </Button>,
              <Button key="process" type="primary" onClick={() => handlePickPsdAndProcessQueue(true)}>
                再处理一批
              </Button>,
            ]}
          />
        );
        break;
      }
      case "failure": {
        const failedCount = queue.filter((it) => it.status === "failed").length;
        ResultStatus = (
          <Result
            status="error"
            icon={<InfoCircleOutlined className="psu-icon-danger" />}
            title="队列处理失败"
            subTitle={`本批次全部失败，共 ${failedCount} 个文件`}
            extra={[
              <Button key="reset" onClick={() => resetPreprocess(psStatus)}>
                返回
              </Button>,
              <Button key="process" type="primary" onClick={() => handlePickPsdAndProcessQueue(true)}>
                再处理一批
              </Button>,
            ]}
          />
        );
        break;
      }
      default:
        ResultStatus = null;
        break;
    }

    return (
      <div className="psu-queue-wrap">
        {ResultStatus}
        <div className="psu-queue-table-wrap">
          <Table<QueueItem>
            className="psu-queue-table"
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
    );
  }

  return (
    <div className="psu-drop-area" onClick={() => handlePickPsdAndProcessQueue()}>
      <div className="psu-drop-inner">
        <InboxOutlined className="psu-drop-icon" />
        <div className="psu-drop-title">点击选择多个 PSD 文件</div>
        <div className="psu-drop-sub">
          仅支持 .psd / .psb；
          <span className="psu-drop-warning">执行前请确保你的ps里没有正在编辑的文件</span>
        </div>
      </div>
    </div>
  );
}
