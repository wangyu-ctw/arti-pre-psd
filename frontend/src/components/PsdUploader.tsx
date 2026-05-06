import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  List,
  Popover,
  Result,
  Spin,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  IssuesCloseOutlined,
} from "@ant-design/icons";
import { getApi } from "../api";
import type {
  PickPsdFilePayload,
  ProcessPsdPayload,
  PsStatusPayload,
} from "../pywebview";

const { Text, Title } = Typography;

export type PreprocessBadgeState =
  | "none"
  | "running"
  | "success"
  | "warning"
  | "error";

type Stage =
  | "loading_status"
  | "ps_missing"
  | "idle"
  | "running"
  | "success"
  | "failure";

type QueueItemStatus = "queued" | "running" | "success" | "warning" | "failed";

type QueueItem = {
  id: string;
  pick: PickPsdFilePayload;
  status: QueueItemStatus;
  result?: ProcessPsdPayload;
  error?: string;
};

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

type PsdUploaderProps = {
  onBadgeStateChange?: (state: PreprocessBadgeState) => void;
};

export function PsdUploader({ onBadgeStateChange }: PsdUploaderProps) {
  const { message } = AntApp.useApp();
  const [stage, setStage] = useState<Stage>("loading_status");
  const [status, setStatus] = useState<PsStatusPayload | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const badgeState = useMemo<PreprocessBadgeState>(() => {
    if (stage === "running") return "running";
    if (stage === "ps_missing") return "error";
    if (stage === "failure" && queue.length === 0) return "error";
    if (queue.length === 0) return "none";

    const successCount = queue.filter((it) => it.status === "success").length;
    const warningCount = queue.filter((it) => it.status === "warning").length;
    const failedCount = queue.filter((it) => it.status === "failed").length;
    const hasPending = queue.some((it) => it.status === "queued" || it.status === "running");

    if (hasPending) return "running";
    if (failedCount === queue.length) return "error";
    if (failedCount > 0 || warningCount > 0) return "warning";
    if (successCount === queue.length) return "success";
    return "none";
  }, [queue, stage]);

  useEffect(() => {
    onBadgeStateChange?.(badgeState);
  }, [badgeState, onBadgeStateChange]);

  async function refreshStatus() {
    setStage("loading_status");
    try {
      const api = await getApi();
      const r = await api.ps_get_status();
      if (!r.ok || !r.data) {
        setGlobalError(r.error ?? "ps_get_status 失败");
        setStage("failure");
        return;
      }
      setStatus(r.data);
      setStage(r.data.ready ? "idle" : "ps_missing");
    } catch (e) {
      setGlobalError(String(e));
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
      setStatus(r.data);
      if (r.data.ready) {
        setStage("idle");
        message.success(
          r.data.just_launched
            ? `已选择并启动：${r.data.ps_app_name}`
            : `已选择：${r.data.ps_app_name}`,
        );
      }
    } catch (e) {
      setGlobalError(String(e));
      setStage("failure");
    }
  }

  async function handlePickPsdAndProcessQueue() {
    try {
      const api = await getApi();
      const pick = await api.pick_psd_files();
      if (!pick.ok || !pick.data) {
        if (pick.error && pick.error !== "用户取消选择") {
          message.error(pick.error);
        }
        return;
      }

      const initialQueue: QueueItem[] = pick.data.map((p, idx) => ({
        id: `${Date.now()}-${idx}-${p.path}`,
        pick: p,
        status: "queued",
      }));
      setQueue(initialQueue);
      setGlobalError(null);
      setStage("running");

      let workQueue = initialQueue.slice();
      for (let i = 0; i < workQueue.length; i++) {
        workQueue[i] = { ...workQueue[i], status: "running", error: undefined, result: undefined };
        setQueue(workQueue.slice());

        const proc = await api.process_psd(workQueue[i].pick.path);
        if (!proc.ok || !proc.data) {
          workQueue[i] = { ...workQueue[i], status: "failed", error: proc.error ?? "处理失败" };
          setQueue(workQueue.slice());
          continue;
        }
        workQueue[i] = {
          ...workQueue[i],
          status: proc.data.step_errors ? "warning" : "success",
          result: proc.data,
        };
        setQueue(workQueue.slice());
      }

      const hasNonFailed = workQueue.some((it) => it.status === "success" || it.status === "warning");
      setStage(hasNonFailed ? "success" : "failure");
    } catch (e) {
      setGlobalError(String(e));
      setStage("failure");
    }
  }

  function resetToIdle() {
    setQueue([]);
    setGlobalError(null);
    setStage(status?.ready ? "idle" : "ps_missing");
  }

  function statusText(s: QueueItemStatus): string {
    if (s === "queued") return "排队中";
    if (s === "running") return "执行中";
    if (s === "success") return "处理完成";
    if (s === "warning") return "处理完成（部分步骤被跳过）";
    return "处理失败";
  }

  function warningPopoverContent(stepErrors: string | undefined) {
    return (
      <Alert
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
            {stepErrors}
          </pre>
        }
        style={{ width: 420, textAlign: "left" }}
      />
    );
  }

  function failedPopoverContent(err: string | undefined) {
    return (
      <p style={{ color: "#b91c1c", whiteSpace: "pre-wrap", maxWidth: 420, margin: 0 }}>
        {err ?? "未知错误"}
      </p>
    );
  }

  function statusIcon(item: QueueItem) {
    if (item.status === "queued" || item.status === "running") {
      return <ClockCircleOutlined style={{ color: "#1677ff" }} />;
    }
    if (item.status === "success") {
      return <CheckCircleOutlined style={{ color: "#52c41a" }} />;
    }
    if (item.status === "warning") {
      return (
        <Popover placement="left" title="部分步骤被跳过" content={warningPopoverContent(item.result?.step_errors)}>
          <IssuesCloseOutlined style={{ color: "#faad14", cursor: "pointer" }} />
        </Popover>
      );
    }
    return (
      <Popover placement="left" title="处理失败详情" content={failedPopoverContent(item.error)}>
        <InfoCircleOutlined style={{ color: "#ff4d4f", cursor: "pointer" }} />
      </Popover>
    );
  }

  function handleCancel(id: string) {
    setQueue(queue.filter((it) => it.id !== id));
  }

  function handleViewResult(id: string) {
    console.log(id);
  }

  function getItemActions(item: QueueItem) {
    if (item.status === "queued") {
      return [<Button key="cancel" type="link" onClick={() => void handleCancel(item.id)}>
        取消
      </Button>];
    }
    if (item.status === "warning" || item.status === "success") {
      return [<Button key="view" type="link" onClick={() => void handleViewResult(item.id)}>
          标注
      </Button>];
    }
    return [<div style={{minWidth: 67}}/>];
  }

  function renderQueueList(title: string, hint?: string) {
    return (
      <div style={QUEUE_WRAP}>
        <div>
          <Title level={5} style={{ margin: 0 }}>
            {title}
          </Title>
          {hint ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {hint}
            </Text>
          ) : null}
          {globalError ? (
            <div style={{ marginTop: 8 }}>
              <Text type="danger">{globalError}</Text>
            </div>
          ) : null}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <List
            dataSource={queue}
            pagination={false}
            locale={{ emptyText: "暂无队列文件" }}
            renderItem={(item) => (
              <List.Item actions={[getItemActions(item)]}>
                <div>{item.pick.name}</div>
                <div>{statusIcon(item)}{" "}{statusText(item.status)}</div>
              </List.Item>
            )}
          />
        </div>

        {(stage === "success" || stage === "failure") && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <Button onClick={resetToIdle}>返回</Button>
            <Button type="primary" onClick={() => void handlePickPsdAndProcessQueue()}>
              再处理一批
            </Button>
          </div>
        )}
      </div>
    );
  }

  function runningHint() {
    const total = queue.length;
    const done = queue.filter(
      (it) => it.status === "success" || it.status === "warning" || it.status === "failed",
    ).length;
    return `串行处理中：${done}/${total}，失败不会阻塞后续文件`;
  }

  function successHint() {
    const successCount = queue.filter((it) => it.status === "success").length;
    const warningCount = queue.filter((it) => it.status === "warning").length;
    const failedCount = queue.filter((it) => it.status === "failed").length;
    return `全部完成：成功 ${successCount}，部分步骤跳过 ${warningCount}，失败 ${failedCount}`;
  }

  function failureHint() {
    const failedCount = queue.filter((it) => it.status === "failed").length;
    return `本批次全部失败，共 ${failedCount} 个文件`;
  }

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

  if (stage === "running") {
    return renderQueueList("Photoshop 队列处理中...", runningHint());
  }

  if (stage === "success") {
    return renderQueueList("队列处理完成", successHint());
  }

  if (stage === "failure") {
    return renderQueueList("队列处理失败", failureHint());
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
