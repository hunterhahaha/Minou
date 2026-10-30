/**
 * 错误模块公开入口，导出统一错误类型、取消识别与构造函数，以及错误归一化函数。
 *
 * 本模块只提供错误数据转换和识别；重试、事件持久化与界面展示由调用方负责。
 */
export * from "./types.ts"
export * from "./abort.ts"
export * from "./normalizer.ts"
