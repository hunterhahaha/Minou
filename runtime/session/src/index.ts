/**
 * Session 模块入口。
 *
 * 模块职责：SessionEvent（事件联合）、SessionEventLog（events.jsonl 追加与 seq）、
 * SessionState（meta.json / contextstate.json）、TurnFileChangeTracker。
 *
 * 文件划分：
 *   events.ts   事件结构与「待写入事件」契约：EventBase（第 8.2 节）、Turn / Step 生命周期、
 *               模型流、assistant/message、审批和 AppendSessionEvent 出口
 *   event-log.ts   events.jsonl 的逐行读取、恢复事件身份分配与单事件追加
 *   session-state.ts   meta / contextstate / AGENTS.md 快照 / tool_output 的初始化与恢复
 *
 * 当前已定义第 8.11 节的完整事件联合与事件出口契约，并实现 SessionEventLog 的文件读取、
 * 单事件追加及 SessionState 派生文件恢复。首批事件提交、TurnFileChangeTracker 及尚无生产方的
 * 事件仍未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8 节、第 9 节、第 10 节、第 30 节
 */
export * from "./events.ts"
export * from "./event-log.ts"
export * from "./session-state.ts"
