import { App as AntApp, Layout } from "antd";
import { getApi } from "./api";
import { PsdUploader } from "./components/PsdUploader";

const { Header, Content, Footer } = Layout;

const CONTACT_EMAIL = "wang.yu1@ctw.inc";

export default function App() {
  const { message } = AntApp.useApp();

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
      <Header
        style={{
          height: 48,
          lineHeight: "32px",
          padding: "8px 16px",
          background: "#ffffff",
          borderBottom: "1px solid #e5e7eb",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, color: "#374151" }}>
          Arti Pre PSD
        </div>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>
          自动清洗<span style={{ color: "red" }}>*执行前请确保你的ps里没有正在编辑的文件</span>
        </div>
      </Header>

      <Content style={{ padding: 24 }}>
        <div style={{ height: "calc(100vh - 140px)" }}>
          <PsdUploader />
        </div>
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
            void openMail();
          }}
          style={{ color: "#4f8cff" }}
        >
          {CONTACT_EMAIL}
        </a>
      </Footer>
    </Layout>
  );
}
