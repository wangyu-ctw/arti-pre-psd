import { ExportOutlined, FolderOpenOutlined, SelectOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Flex, Input, Splitter } from "antd";
import { getApi } from "../api";
import { useAppStore } from "../store";

/**
 * 标注器工作区 —— 英文名 Annotator Workspace（像素 / 语义标注等对 PSD 的后续操作）。
 */
export function AnnotatorWorkspace() {
  const { message } = AntApp.useApp();

  const annotatingFile           = useAppStore((s) => s.annotatingFile);
  const requestSetAnnotatingFile = useAppStore((s) => s.requestSetAnnotatingFile);

  async function handlePickFile() {
    try {
      const api = await getApi();
      const r = await api.pick_psd_only_file();
      if (!r.ok || !r.data) {
        if (r.error && r.error !== "用户取消选择") message.error(r.error);
        return;
      }
      requestSetAnnotatingFile(r.data.path);
    } catch (e) {
      message.error(String(e));
    }
  }

  async function handleOpenInPs() {
    const p = annotatingFile.trim();
    if (!p) return;
    try {
      const api = await getApi();
      const r = await api.open_psd_in_ps(p);
      if (!r.ok) message.error(r.error ?? "无法在 Photoshop 中打开");
    } catch (e) {
      message.error(String(e));
    }
  }

  function handleDownloadCsvPlaceholder() {
    // 预留：导出标注 CSV
  }

  return (
    <Flex vertical style={{ height: "100%", minHeight: 0, background: "#ffffff", borderRadius: 8, border: "1px solid #e5e7eb" }}>
      <div style={{ flexShrink: 0, padding: "12px", borderBottom: "1px solid #e5e7eb" }}>
        <Flex gap={8} align="center">
          <Input
            allowClear
            style={{ width: "50%" }}
            value={annotatingFile}
            onClear={() => requestSetAnnotatingFile("")}
            placeholder="本地 PSD 文件路径"
          />
          <Button type="primary" icon={<SelectOutlined />} onClick={() => void handlePickFile()}>
            选择
          </Button>
          <Button
            icon={<FolderOpenOutlined />}
            disabled={!annotatingFile.trim()}
            onClick={() => void handleOpenInPs()}
          >
            用 PS 打开
          </Button>
          <Button
            icon={<ExportOutlined />}
            onClick={handleDownloadCsvPlaceholder}
            disabled={!annotatingFile.trim()}
          >
            导出 CSV
          </Button>
        </Flex>
      </div>

      <Splitter orientation="horizontal" styles={{ root: { flex: 1, minHeight: 0 }, dragger: { background: "#f0f0f0" } }}>
        <Splitter.Panel defaultSize="33.333%" min="16.666%" max="66.666%">
          <div style={{ height: "100%", minHeight: 0, overflow: "auto", padding: 8 }} />
        </Splitter.Panel>
        <Splitter.Panel>
          <div style={{ height: "100%", minHeight: 0, overflow: "auto", padding: 8 }} />
        </Splitter.Panel>
      </Splitter>
    </Flex>
  );
}
