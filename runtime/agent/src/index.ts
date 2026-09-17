/**
 * Agent 模块入口。
 *
 * 模块职责：SessionRuntime（首次 / 继续入口与 turn/start + user/message 提交边界）、
 * AgentLoop（Turn、Step、压缩、工具小轮、Insert 消费、收尾）、UserMessageScheduler（Insert / Queue）。
 *
 * 文件划分：
 *   loop.ts   AgentLoop 的 Step 循环：正常模型请求 → 统一流事件转 Session 事件 → assistant/message
 *
 * 当前已实现的部分：只有 `runAgentLoop`（TODOList 阶段 6.1 的「正常模型请求」这条数据流）。
 * 压缩（6.2）、Usage 记账（6.3）、工具小轮（6.4）、Insert / Queue（6.5）、停止与收尾（6.6），
 * 以及 SessionRuntime、UserMessageScheduler 尚未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 13 节（Session 入口与 Agent Loop）、
 *          第 14 节（用户停止 Agent）、第 15 节（运行中用户消息）、第 30 节（模块边界）
 */
export * from "./loop.ts"
