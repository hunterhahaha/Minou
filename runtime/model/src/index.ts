/**
 * 模型协议层模块入口。
 *
 * 模块职责：统一模型格式与三个 Protocol Adapter
 * （ModelAdapter / AnthropicAdapter / ChatCompletionsAdapter / ResponsesAdapter）。
 * 厂商协议细节只存在于本模块内部，Agent Runtime 只处理 `./types` 定义的统一格式。
 *
 * 文件划分：
 *   types.ts            统一模型格式（阶段 1）：请求、事件、内容块、Usage 与派生量
 *   usage.ts            三个协议的 Usage 字段 → 统一 Usage（第 27 节 / Usage 设计文档）
 *   shared.ts           跨协议公共：请求校验、文本拼接、参数序列化、重试与错误归一化
 *   anthropic.ts        Anthropic Messages Adapter（第 6 节、阶段 3）
 *   chat-completions.ts Chat Completions Adapter（第 6 节、阶段 4）
 *   responses.ts        Responses Adapter（第 6 节、阶段 5）
 *   adapter.ts          按 `ModelConfig.protocol` 选择实现的创建入口
 *
 * 数据流：AgentLoop → `UnifiedModelRequest` + `AbortSignal` → Adapter（请求转换）
 *   → 官方 SDK → 协议流 → Adapter（事件转换）→ `ModelStreamEvent` → AgentLoop。
 * 重试与错误归一化在 `shared.ts` 的 `runModelStream` 内统一处理，
 * 因此 Adapter 抛出的一定是 `AppError`（`source = "model"`）。
 *
 * 已实现：三个协议的流式调用与双向转换、Usage 转换、取消（AbortSignal → SDK signal）、
 * 接入 `runtime/network/` 的重试与 `runtime/error/` 的归一化。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 6 节（模型协议层）、第 7 节（网络层）、
 *          第 8.4 / 8.5 节（流事件与完成态）、第 27 节（Usage）、第 25 节（错误）
 */
export * from "./types.ts"
export * from "./usage.ts"
export * from "./shared.ts"
export * from "./anthropic.ts"
export * from "./chat-completions.ts"
export * from "./responses.ts"
export * from "./adapter.ts"
