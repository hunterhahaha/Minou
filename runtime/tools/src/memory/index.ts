/**
 * 目录占位，阶段 0 无实现。
 *
 * 模块职责：memory 工具本体 —— memory_list（只返回一级 / 二级标题索引）、
 * memory_read（按需读取指定章节正文）、memory_write（追加记忆，标题不存在则自动创建，
 * Runtime 自动写入精确 createdAt）；三者均将成功数据格式化为 ToolResultTextContent。
 *
 * 与 ../memory/ 的分工：../memory/ 是 Memory Runtime 本体（MemoryManager，
 * memory.md 的存放、按需访问与写入规则，第 31 节）；本目录只放暴露给模型的工具。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 31 节（Memory Runtime）、第 31.1–31.4 节
 * 实施阶段：不在 TODOList 阶段 1–6 范围内
 */
export {}
