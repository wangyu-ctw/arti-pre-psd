import type { PyApi } from "./pywebview";

// pywebview 注入 window.pywebview.api 是异步的（页面加载后才注入）。
// 这里提供一个 Promise，等待注入完成后再返回 api 句柄。
export function getApi(timeoutMs = 5000): Promise<PyApi> {
  return new Promise((resolve, reject) => {
    if (window.pywebview?.api) {
      resolve(window.pywebview.api);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      if (window.pywebview?.api) {
        clearInterval(timer);
        resolve(window.pywebview.api);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("pywebview api 注入超时（是否在普通浏览器里打开了？）"));
      }
    }, 50);
  });
}
