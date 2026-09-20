/**
 * Agent 模块入口。
 *
 * 模块职责：SessionRuntime（首次 / 继续入口与 turn/start + user/message 提交边界）、
 * AgentLoop（Turn、Step、压缩、工具小轮、Insert 消费、收尾）、UserMessageScheduler（Insert / Queue）。
 *
 * 文件划分：
 *   loop.ts   AgentLoop 的 Step 循环：正常模型请求 → 统一流事件转 Session 事件 → assistant/message
 *   session-runtime.ts   首次 / 继续 Session 的 Turn 入口
 *
 * 当前已实现 `runAgentLoop` 的正常模型请求及工具小轮，并提供 SessionRuntime 的两个入口
 * 与 Event Log 确定性恢复。SessionRepairPorts 已有文件系统组合实现；当前 AGENTS.md / Skill / MCP
 * 基线及 ContextBuilder 仍通过接口注入。压缩、运行期 Usage 记账、Insert / Queue、Turn 收尾及
 * UserMessageScheduler 尚未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 13 节（Session 入口与 Agent Loop）、
 *          第 14 节（用户停止 Agent）、第 15 节（运行中用户消息）、第 30 节（模块边界）
 */
export * from "./loop.ts"
export * from "./session-runtime.ts"
