/**
 * Electron 主进程入口占位。当前导出启动配置初始化和 Session IPC 注册入口。
 *
 * 进程划分（AGENTS.md 实现约定）：主进程承载 Runtime，渲染进程承载 UI。
 * 本文件之后负责创建窗口、装载渲染进程页面，并把 runtime/ 下的模块装配起来。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 1 节（总体架构）、第 28 节（Runtime 总体数据流）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 0
 */
export { initializeConfigFiles } from "./config-files.ts"
export type { ConfigFilePaths } from "./config-files.ts"
export { registerSessionIpcHandlers } from "./session-ipc.ts"
export type {
  HandleSessionCompletionFailure,
  IpcMainHandlePort,
  SessionCompletionFailure,
} from "./session-ipc.ts"
