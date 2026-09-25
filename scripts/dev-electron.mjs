import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { createServer } from "vite"

const projectRoot = fileURLToPath(new URL("../", import.meta.url))
const viteServer = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.mts", import.meta.url)),
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
})

await viteServer.listen()
const address = viteServer.httpServer?.address()
if (!address || typeof address === "string") {
  await viteServer.close()
  throw new Error("无法读取 Vite 开发服务器地址。")
}

const rendererUrl = `http://127.0.0.1:${address.port}/`
const require = createRequire(import.meta.url)
const electronPath = require("electron")
const electronProcess = spawn(electronPath, [projectRoot], {
  cwd: projectRoot,
  env: {
    ...process.env,
    NICODE_RENDERER_URL: rendererUrl,
  },
  stdio: "inherit",
})

console.log(`NiCode Renderer HMR 已启动：${rendererUrl}`)

let receivedSignal = false
const stopElectron = () => {
  receivedSignal = true
  electronProcess.kill()
}
process.once("SIGINT", stopElectron)
process.once("SIGTERM", stopElectron)

try {
  const exitResult = await new Promise((resolve, reject) => {
    electronProcess.once("error", reject)
    electronProcess.once("exit", (code, signal) => resolve({ code, signal }))
  })
  process.exitCode = exitResult.code ?? (receivedSignal ? 0 : 1)
} finally {
  process.removeListener("SIGINT", stopElectron)
  process.removeListener("SIGTERM", stopElectron)
  await viteServer.close()
}
