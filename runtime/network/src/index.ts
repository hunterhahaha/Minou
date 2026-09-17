/**
 * 网络层：进程级 HTTP Dispatcher 与请求重试。
 *
 * 文件划分：
 *   dispatcher.ts  进程级 HTTP Dispatcher（undici Agent + Keep-Alive 复用）
 *   retry.ts       自动重试、退避与流式重试边界
 *
 * 本模块不依赖任何厂商 SDK，也不理解 `ModelStreamEvent`；协议差异留在各 Adapter 内部。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 7 节（网络层）
 */

export * from "./dispatcher.ts"
export * from "./retry.ts"
