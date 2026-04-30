import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 关键点：base: "./" 让 build 出来的 index.html 用相对路径加载资源，
// 这样 pywebview 直接从本地文件协议打开也能正常工作。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
