/**
 * Session 模块公开入口，导出事件契约、SQLite 事件日志、派生状态和 Turn 文件变化追踪器。
 *
 * 调用方提交事件输入，日志层分配身份并事务写入；派生状态依据已校验事件更新或恢复。
 * TurnFileChangeTracker 在内存保存首次修改前与最终内容，生成供调用方持久化的净变化。
 */
export * from "./events.ts"
export * from "./event-log.ts"
export * from "./session-state.ts"
export * from "./file-changes.ts"
