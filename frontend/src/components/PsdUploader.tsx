import { useEffect, useState } from "react";
import {
  Alert,
  App as AntApp,
  Button,
  Result,
  Spin,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  InboxOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { getApi } from "../api";
import type {
  PickPsdFilePayload,
  ProcessPsdPayload,
  PsStatusPayload,
} from "../pywebview";

const { Text, Title } = Typography;

type Stage =
  | "loading_status"   // 启动时检测 PS
  | "ps_missing"       // 没找到 PS，需用户手选
  | "idle"             // PS 就绪，等用户选 PSD
  | "running"          // PS 正在跑 4 个脚本
  | "success"          // 处理完成
  | "failure";         // 处理失败

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

export function PsdUploader() {
  const { message } = AntApp.useApp();
  const [stage, setStage] = useState<Stage>("loading_status");
  const [status, setStatus] = useState<PsStatusPayload | null>(null);
  const [picked, setPicked] = useState<PickPsdFilePayload | null>(null);
  const [result, setResult] = useState<ProcessPsdPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshStatus() {
    setStage("loading_status");
    try {
      const api = await getApi();
      const r = await api.ps_get_status();
      if (!r.ok || !r.data) {
        setError(r.error ?? "ps_get_status 失败");
        setStage("failure");
        return;
      }
      setStatus(r.data);
      setStage(r.data.ready ? "idle" : "ps_missing");
    } catch (e) {
      setError(String(e));
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
      message.error(String(e));
    }
  }

  async function handlePickPsdAndProcess() {
    try {
      const api = await getApi();
      const pick = await api.pick_psd_file();
      if (!pick.ok || !pick.data) {
        if (pick.error && pick.error !== "用户取消选择") {
          message.error(pick.error);
        }
        return;
      }
      setPicked(pick.data);
      setError(null);
      setResult(null);
      setStage("running");

      const proc = await api.process_psd(pick.data.path);
      if (!proc.ok || !proc.data) {
        setError(proc.error ?? "处理失败");
        setStage("failure");
        return;
      }
      setResult(proc.data);
      setStage("success");
    } catch (e) {
      setError(String(e));
      setStage("failure");
    }
  }

  function reset() {
    setPicked(null);
    setResult(null);
    setError(null);
    setStage(status?.ready ? "idle" : "ps_missing");
  }

  async function openFolder(dir: string) {
    try {
      const api = await getApi();
      const r = await api.open_external(`file://${dir}`);
      if (!r.ok) message.error(r.error ?? "无法打开文件夹");
    } catch (e) {
      message.error(String(e));
    }
  }

  async function openInPs(filePath: string) {
    try {
      const api = await getApi();
      const r = await api.open_psd_in_ps(filePath);
      if (!r.ok) message.error(r.error ?? "无法在 Photoshop 中打开");
    } catch (e) {
      message.error(String(e));
    }
  }

  // ---- 各 stage 渲染 ----

  if (stage === "loading_status") {
    return (
      <div style={FULL_HEIGHT_BOX}>
        <Spin tip="检测 Photoshop 状态..." size="large">
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
    return (
      <div style={FULL_HEIGHT_BOX}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <Title level={5} style={{ margin: 0 }}>
            Photoshop 正在处理中...
          </Title>
          {picked && (
            <Text type="secondary">
              {picked.name}（{formatBytes(picked.size_bytes)}）
            </Text>
          )}
          <div style={{ marginTop: 12, color: "#9ca3af", fontSize: 12 }}>
            大文件可能需要 1~2 分钟，请勿关闭 Photoshop。
          </div>
        </div>
      </div>
    );
  }

  if (stage === "success") {
    const hasStepErrors = !!result?.step_errors;
    return (
      <div style={{ ...FULL_HEIGHT_BOX, border: "1px solid #e5e7eb" }}>
        <Result
          status={hasStepErrors ? "warning" : "success"}
          icon={
            hasStepErrors ? (
              <ExclamationCircleOutlined style={{ color: "#faad14" }} />
            ) : (
              <CheckCircleOutlined />
            )
          }
          title={hasStepErrors ? "处理完成（部分步骤被跳过）" : "处理完成"}
          subTitle={result?.path}
          extra={[
            <Button
              key="ps-check"
              type="default"
              onClick={() => result?.path && void openInPs(result.path)}
            >
              人工PS检查
            </Button>,
            <Button
              key="next"
              type="primary"
              onClick={() => {
                reset();
                void handlePickPsdAndProcess();
              }}
            >
              再处理一个
            </Button>,
            result?.directory ? (
              <Button key="open" onClick={() => void openFolder(result.directory)}>
                打开所在文件夹
              </Button>
            ) : null,
            <Button key="back" onClick={reset}>
              返回
            </Button>,
          ]}
        >
          {hasStepErrors && (
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
                  {result!.step_errors}
                </pre>
              }
              style={{ textAlign: "left" }}
            />
          )}
        </Result>
      </div>
    );
  }

  if (stage === "failure") {
    return (
      <div style={{ ...FULL_HEIGHT_BOX, border: "1px solid #e5e7eb" }}>
        <Result
          status="error"
          title="处理失败"
          subTitle={picked?.name}
          extra={[
            <Button key="reset" type="primary" onClick={reset}>
              重新开始
            </Button>,
            <Button key="refresh" onClick={() => void refreshStatus()}>
              重新检测 Photoshop
            </Button>,
          ]}
        >
          <div
            style={{
              padding: 12,
              background: "#fef2f2",
              borderRadius: 4,
              maxHeight: 240,
              overflow: "auto",
            }}
          >
            <p style={{ color: "#b91c1c", whiteSpace: "pre-wrap" }}>
              {error}
            </p>
          </div>
        </Result>
      </div>
    );
  }

  // stage === "idle"
  return (
    <div
      style={DROP_AREA}
      onClick={() => void handlePickPsdAndProcess()}
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
        <div style={{ marginTop: 16, fontSize: 16 }}>点击选择 PSD 文件（不支持拖拽上传）</div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>
          仅支持 .psd / .psb；选中后会让 Photoshop 自动清洗
          <p style={{ color: "red" }}>*执行前请确保你的ps里没有正在编辑的文件</p>
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
