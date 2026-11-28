import OpenAI from "openai"

import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./xai/openai-chat-completions-adapter.ts"
import { buildResponsesRequest, mapResponsesStream } from "./xai/openai-responses-adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** xAI 的 Responses 与 Chat Completions 转换器，连接由共享 SDK 网关绑定。 */
export class XaiAdapter implements ModelConverter {
  /**
   * 按本轮协议将统一历史和工具转换为流式请求。
   * @param request 当前统一模型请求。
   * @param context 本轮转换使用的模型配置。
   * @returns 对应协议的 SDK 参数。
   * @throws AppError 当协议、上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    switch (modelConfig.protocol) {
      case "responses":
        return { protocol: "responses", params: buildResponsesRequest(request, modelConfig) }
      case "chat_completions":
        return { protocol: "chat_completions", params: buildChatCompletionsRequest(request, modelConfig) }
      default:
        throw invalidRequest("Xai Adapter 不支持当前协议")
    }
  }

  /**
   * 转换单次 SDK 流，清理可能回显请求内容的上游错误。
   * @param raw 带协议标记的一次 SDK 流。
   * @param _request 产生该流的统一请求，映射只使用 SDK 事件。
   * @param context 本轮协议，用于核对流标记。
   * @returns 本次网络尝试独立的统一事件流。
   * @throws 协议不匹配、请求失败或流中断时抛出，HTTP 状态保留给共享重试逻辑。
   */
  async *mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncGenerator<ModelStreamEvent> {
    if (raw.protocol !== modelConfig.protocol) throw invalidRequest("Xai Adapter 收到了不匹配的协议事件")

    try {
      switch (raw.protocol) {
        case "responses":
          yield* mapResponsesStream(raw.events)
          break
        case "chat_completions":
          yield* mapChatCompletionsStream(raw.events)
          break
        default:
          throw invalidRequest("Xai Adapter 不支持当前流协议")
      }
    } catch (error) {
      if (error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIUserAbortError)) {
        throw new OpenAI.APIError(error.status, undefined, "xAI 请求失败", undefined)
      }
      if (error instanceof SyntaxError) throw new Error("xAI 返回了无法解析的流事件")
      throw error
    }
  }
}
