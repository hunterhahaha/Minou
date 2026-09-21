/**
 * Agent 模块入口。
 *
 * 模块职责：SessionRuntime（活动实例、首次 / 继续入口、Queue 与事件流）、
 * AgentLoop（Turn、Step、压缩、工具小轮、Insert 消费与收尾）。
 *
 * 文件划分：
 *   loop.ts   AgentLoop 的 Step 循环：正常模型请求 → 统一流事件转 Session 事件 → assistant/message
 *   session-runtime.ts   单 Session 活动实例、首次 / 继续入口、Queue 与恢复
 *
 * 当前已实现 `runAgentLoop` 的正常模型请求及工具小轮，并提供 SessionRuntime 的两个入口
 * 与 Event Log 确定性恢复。SessionRepairPorts 已有文件系统组合实现；当前 AGENTS.md / Skill / MCP
 * 基线及 ContextBuilder 仍通过接口注入。Queue 与最小 Turn 收尾已经接入；压缩、运行期 Usage 记账、
 * Insert、文件变更汇总和最终 Surface 尚未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 13 节（Session 入口与 Agent Loop）、
 *          第 14 节（用户停止 Agent）、第 15 节（运行中用户消息）、第 30 节（模块边界）
 */
export * from "./loop.ts"
export * from "./session-runtime.ts"
