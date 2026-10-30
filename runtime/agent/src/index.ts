/**
 * Agent 模块公开入口，导出 Step 循环、SessionRuntime 及其类型。
 *
 * SessionRuntime 绑定单个 Session，负责 Turn 首批事件、FIFO 消息队列、上下文基线、
 * 按 Turn 装配模型与工具、压缩检查、审批、Usage 同步、文件变化及 Turn 收尾。
 * runAgentLoop 负责 Turn 内的模型流、Step 事件、工具小轮和结果回填；
 * 桌面宿主通过 SessionRuntime 使用它，CLI 也可独立装配资源后直接调用。
 *
 * Session 恢复以 Event Log 为依据，校验事件与生命周期后补写未完成记录，
 * 并修复派生状态。运行中用户消息通过队列等待下一 Turn，队列不提前固定模型选择。
 */
export * from "./loop.ts"
export * from "./session-runtime.ts"
