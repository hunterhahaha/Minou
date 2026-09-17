/**
 * Session 模块入口。
 *
 * 模块职责：SessionEvent（事件联合）、SessionEventLog（events.jsonl 追加与 seq）、
 * SessionState（meta.json / contextstate.json）、TurnFileChangeTracker。
 *
 * 文件划分：
 *   events.ts   事件结构与「待写入事件」契约：EventBase（第 8.2 节）、Step 生命周期与
 *               模型流事件、assistant/message（第 8.4、8.5、8.9 节）、AppendSessionEvent 出口
 *
 * 当前已实现的部分：只有 AgentLoop 会写出的那部分事件类型与事件出口契约。
 * SessionEventLog / SessionState / TurnFileChangeTracker、以及其余事件
 * （`user/message`、`tool/result`、`context_update`、`summary/*`、`turn/*`、审批）
 * 尚未实现，随各自模块接入时补齐。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 8 节、第 9 节、第 10 节、第 30 节
 */
export * from "./events.ts"
