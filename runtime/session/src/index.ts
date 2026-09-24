/**
 * Session 模块入口。
 *
 * 模块职责：SessionEvent（事件联合）、SessionEventLog（共享 SQLite 追加与 seq）、
 * SessionState（共享 Meta SQLite / contextstate.json）、TurnFileChangeTracker。
 *
 * 文件划分：
 *   events.ts   事件结构与「待写入事件」契约：EventBase（第 8.2 节）、Turn / Step 生命周期、
 *               模型流、assistant/message、审批和 AppendSessionEvent 出口
 *   event-log.ts   events.sqlite 的事件读取、身份分配与事务追加
 *   session-state.ts   meta / contextstate / AGENTS.md 快照 / tool_output 的初始化与恢复
 *
 * 当前已定义第 8.11 节的完整事件联合与事件出口契约，并实现 SessionEventLog 的
 * SQLite 读取与事务追加、首批事件提交及 SessionState 派生文件恢复。
 * TurnFileChangeTracker 及尚无生产方的事件仍未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8 节、第 9 节、第 10 节、第 30 节
 */
export * from "./events.ts"
export * from "./event-log.ts"
export * from "./session-state.ts"
export * from "./file-changes.ts"
