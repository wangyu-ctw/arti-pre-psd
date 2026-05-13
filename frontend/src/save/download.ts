/**
 * 触发浏览器把一个 base64 字符串当作 PSD 文件下载。
 *
 * 这个函数被故意单独拆出来：当前是"自动下载"语义，未来可能会改成
 * "返回 ArrayBuffer 给上层处理"或"直接走 pywebview 写盘"等模式，
 * 调用处只需要换成对应的 helper 即可。
 */
export function downloadPsdBlob(b64: string, filename: string) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);

  const blob = new Blob([bytes], { type: "image/vnd.adobe.photoshop" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // 给浏览器一点时间消费 URL 再 revoke，否则下载可能未真正开始
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 以原文件名 "xxx.psd" 推导清洗后输出名 "xxx.cleaned.psd"。
 */
export function deriveCleanedName(originalName: string): string {
  const m = /^(.*)\.psd$/i.exec(originalName);
  return m ? `${m[1]}.cleaned.psd` : `${originalName}.cleaned.psd`;
}

/**
 * 触发浏览器下载 CSV 字符串为文件。
 * 头部加 UTF-8 BOM，保证 Excel 正确识别中文。
 */
export function downloadCsv(content: string, filename: string) {
  const blob = new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
