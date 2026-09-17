/**
 * 错误模块入口。
 *
 * 模块职责：AppError、取消识别与 ErrorNormalizer（底层异常 → 统一 AppError）。
 *
 * 文件划分：
 *   types.ts        AppError 与 AppErrorSource（第 25 节）
 *   abort.ts        取消（Abort）错误的识别与构造（第 7、14 节）
 *   normalizer.ts   底层异常 → AppError（第 25 节）
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 25 节（工具错误与取消处理）、
 *          第 7 节（网络层）、第 14 节（用户停止 Agent）
 */
export * from "./types.ts"
export * from "./abort.ts"
export * from "./normalizer.ts"
