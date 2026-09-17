/**
 * 目录占位，阶段 0 无实现。
 *
 * 模块职责：skill 工具本体 —— skill_load（第 12.4 节）。
 * 输入 `SkillLoadInput { name }`；执行时依据当前 Project / default 的 Skill 可用表判断目标 Skill 是否允许，
 * 允许则读取并返回完整 Skill 内容，不允许或不存在则返回结构化工具错误；
 * 成功数据为 `SkillLoadResult { name, content, scope }`，使用独立 renderer 组织为 ToolResultTextContent。
 *
 * 与 ../skill/ 的分工：../skill/ 是 Skill Runtime 本体（SkillManager / SkillContextManager，
 * Skill 可用表、Session Skill Context State、预算治理，第 12 节）；本目录只放暴露给模型的工具。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 12.4 节（Skill 内容载入工具）、第 12.6 节（Skill 工具成功数据）
 * 实施阶段：不在 TODOList 阶段 1–6 范围内
 */
export {}
