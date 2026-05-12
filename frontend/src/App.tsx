import { App as AntApp, Layout, Tabs } from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  IssuesCloseOutlined,
} from "@ant-design/icons";
import { useMemo } from "react";
import { getApi } from "./api";
import { AnnotatorWorkspace } from "./components/AnnotatorWorkspace";
import { PsdUploader } from "./components/PsdUploader";
import { RestoreImage } from "./components/RestoreImage";
import { useAppStore, selectPreprocessBadge } from "./store/appStore";

const { Content, Footer } = Layout;

const contentAreaStyle: React.CSSProperties = {
  height: "calc(100vh - 108px)",
  padding: "0 0 12px",
};

const CONTACT_EMAIL = "wang.yu1@ctw.inc";

export default function App() {
  const { message } = AntApp.useApp();
  const preprocessBadge = useAppStore(selectPreprocessBadge);
  const activeTab       = useAppStore((s) => s.activeTab);
  const setActiveTab    = useAppStore((s) => s.setActiveTab);

  const preprocessLabel = useMemo(() => {
    let icon: React.ReactNode = null;
    if (preprocessBadge === "running") {
      icon = <ClockCircleOutlined style={{ color: "#1677ff" }} />;
    } else if (preprocessBadge === "success") {
      icon = <CheckCircleOutlined style={{ color: "#52c41a" }} />;
    } else if (preprocessBadge === "warning") {
      icon = <IssuesCloseOutlined style={{ color: "#faad14" }} />;
    } else if (preprocessBadge === "error") {
      icon = <InfoCircleOutlined style={{ color: "#ff4d4f" }} />;
    }
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span>预处理</span>
        {icon}
      </span>
    );
  }, [preprocessBadge]);

  async function openMail() {
    try {
      const api = await getApi();
      const res = await api.open_external(`mailto:${CONTACT_EMAIL}`);
      if (!res.ok) message.error(res.error ?? "无法打开邮件客户端");
    } catch (e) {
      message.error(String(e));
    }
  }

  return (
    <Layout style={{ minHeight: "100vh", background: "#f5f7fa" }}>
      <Content>
        <Tabs
          styles={{content: {padding: "0 24px"}, header: {padding: "0 24px"}}}
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: "preprocess",
              label: preprocessLabel,
              children: (
                <div style={contentAreaStyle}>
                  <PsdUploader />
                </div>
              ),
            },
            {
              key: "annotator",
              label: "标注器",
              children: (
                <div style={contentAreaStyle}>
                  <AnnotatorWorkspace />
                </div>
              ),
            },
            {
              key: "restore",
              label: "还原器",
              children: (
                <div style={contentAreaStyle}>
                  <RestoreImage />
                </div>
              ),
            },
          ]}
        />
      </Content>

      <Footer
        style={{
          textAlign: "center",
          padding: "12px 16px",
          background: "#ffffff",
          borderTop: "1px solid #e5e7eb",
          color: "#6b7280",
          fontSize: 12,
        }}
      >
        CTW 2026{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          onClick={(e) => {
            e.preventDefault();
            openMail();
          }}
          style={{ color: "#4f8cff" }}
        >
          {CONTACT_EMAIL}
        </a>
      </Footer>
    </Layout>
  );
}
