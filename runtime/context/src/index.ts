/**
 * 目录占位，阶段 0 无实现。
 *
 * 模块职责：ContextBuilder（每个 Turn 启动前构建一次 content）、ContextWindowManager（85% 压缩判断）、
 * ContextCompressor（content[1...] 全量压缩）、ContextRecovery、TokenEstimator、
 * SessionProjector、SurfaceBuilder。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 11 节、第 32 节、第 30 节
 * 实施阶段：本阶段（TODOList 阶段 1–6）只依赖其中压缩判断相关内容，其余留给后续阶段
 */
export {}
