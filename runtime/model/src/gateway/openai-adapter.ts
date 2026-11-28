import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./openai/openai-chat-completions-adapter.ts"
import { buildResponsesRequest, mapResponsesStream } from "./openai/openai-responses-adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** OpenAI Responses 和 Chat Completions 的双向转换器。 */
export class OpenAIAdapter implements ModelConverter {
  /**
   * 按本轮协议构造 OpenAI SDK 请求，Responses 可回放历史推理项。
   * @param request 本次统一请求，包含上下文、模型引用和工具定义。
   * @param context 本轮绑定的模型与协议配置。
   * @returns 可交给对应 SDK 入口的流式请求。
   * @throws AppError 当协议、上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    switch (modelConfig.protocol) {
      case "responses":
        return { protocol: "responses", params: buildResponsesRequest(request, modelConfig) }
      case "chat_completions":
        return { protocol: "chat_completions", params: buildChatCompletionsRequest(request, modelConfig) }
      default:
        throw invalidRequest("OpenAI Adapter 不支持当前协议")
    }
  }

  /**
   * 将本次 SDK 流转换成统一内容块和结束状态。
   * @param raw 带协议标记的 SDK 事件流。
   * @param _request 发起本次尝试的统一请求，转换使用 SDK 事件本身。
   * @param context 本轮绑定的模型配置，用于核对协议。
   * @returns 本次网络尝试独立的统一事件流。
   * @throws 当协议不匹配，或消费期间发现流失败或提前中断时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== modelConfig.protocol) throw invalidRequest("OpenAI Adapter 收到了不匹配的协议事件")

    switch (raw.protocol) {
      case "responses":
        return mapResponsesStream(raw.events)
      case "chat_completions":
        return mapChatCompletionsStream(raw.events)
      default:
        throw invalidRequest("OpenAI Adapter 不支持当前流协议")
    }
  }
}
