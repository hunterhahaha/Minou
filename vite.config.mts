import { defineConfig } from "vite"

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [
    {
      name: "minou-dev-csp-styles",
      apply: "serve",
      /**
       * 为 Vite 开发客户端注入的样式节点和 HMR WebSocket 开放开发专用 CSP 权限。
       * @param html Vite 正在处理的 Renderer 页面。
       * @returns 允许开发样式注入和本机 HMR 连接的 Renderer 页面。
       * @throws Error 当页面中缺少预期的 CSP 指令时抛出。
       */
      transformIndexHtml(html) {
        const stylePolicy = "style-src 'self'"
        const defaultPolicy = "default-src 'self'"
        if (!html.includes(stylePolicy) || !html.includes(defaultPolicy)) {
          throw new Error("Renderer 页面缺少预期的 CSP 指令。")
        }
        return html
          .replace(defaultPolicy, `${defaultPolicy}; connect-src 'self' ws://127.0.0.1:5173`)
          .replace(stylePolicy, `${stylePolicy} 'unsafe-inline'`)
      },
    },
  ],
  build: {
    outDir: "../../dist/src/renderer",
    emptyOutDir: true,
  },
})
