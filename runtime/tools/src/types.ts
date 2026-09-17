/**
 * 工具运行时的统一结果结构（第 16.2 节）。
 *
 * 每个工具的 render 把该工具的专属 Result 或 AppError 转成本文件的 `ToolResult`，
 * 统一 execute 返回它，AgentLoop 据此写 `tool/result` 事件、并把它转成回放用的 tool 消息。
 * 因此这里是「工具 → 上下文 / Event Log」这条数据流的契约。
 *
 * 当前只定义了结果结构，工具本体（ToolRegistry / ToolExecutor / ToolScheduler 与各工具）尚未实现。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 16.2 节（统一 ToolResult 与内容块）、
 *          第 16.4 节（统一 execute 流程）、第 16.5 节（日志、上下文与 UI）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.4（只接调度入口与 tool/result 写入）
 */

import type { AppError } from "../../error/src/types.ts"

/**
 * 工具结果的统一内容块（第 16.2 节）。
 *
 * 成功与错误分支都必须有 content。当前三种模型协议的工具结果转换**只处理 `type = "text"`**，
 * 其余类型是统一结构保留的表达能力，不在当前协议转换范围内。
 */
export type ToolResultContent =
  | ToolResultTextContent
  | ToolResultImageContent
  | ToolResultAudioContent
  | ToolResultResourceContent
  | ToolResultResourceLinkContent

export interface ToolResultTextContent {
  type: "text"
  text: string
}

export interface ToolResultImageContent {
  type: "image"
  /** base64。 */
  data: string
  mimeType: string
}

export interface ToolResultAudioContent {
  type: "audio"
  /** base64。 */
  data: string
  mimeType: string
}

export interface ToolResultResourceContent {
  type: "resource"
  resource: {
    uri: string
    mimeType?: string
    /** 文本资源。 */
    text?: string
    /** base64 二进制资源。 */
    blob?: string
  }
}

export interface ToolResultResourceLinkContent {
  type: "resource_link"
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/**
 * 统一 ToolResult（第 16.2 节）。
 *
 * `error` 保存 Runtime 统一错误；`content` 保存经过 render 处理的模型可见内容，
 * 内部堆栈等 details 不默认暴露。普通工具失败只用 `status = "error"` 表示，
 * 不为同一次失败额外写 `app/error`（第 8.6 节）。
 */
export type ToolResult =
  | {
      status: "success"
      content: ToolResultContent[]
    }
  | {
      status: "error"
      content: ToolResultContent[]
      error: AppError
    }
