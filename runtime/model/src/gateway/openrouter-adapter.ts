import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"
import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatRequest, mapChatStream } from "./openrouter/openai-chat-completions-adapter.ts"

/** OpenRouter Chat Completions 的请求和响应转换器。 */
export class OpenRouterAdapter implements ModelConverter {
  /**
   * 将统一上下文及 OpenRouter 原生回放转换为 SDK 请求。
   * @param request 当前模型请求与会话上下文。
   * @param context 本轮模型及协议配置。
   * @returns 带 Chat Completions 协议标记的流式请求。
   * @throws AppError 当协议、上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    if (modelConfig.protocol !== "chat_completions") throw invalidRequest("OpenRouter Adapter 不支持当前协议")
    return { protocol: "chat_completions", params: buildChatRequest(request, modelConfig) }
  }

  /**
   * 将本次尝试的 SDK 分片转换为统一流事件和原生思考回放。
   * @param raw 本次尝试的原始事件流。
   * @param _request 产生此流的统一请求，各用途使用同一响应转换规则。
   * @param context 本轮模型配置，用于核对原始流协议。
   * @returns 本次尝试独立的异步模型事件流。
   * @throws 协议不匹配、流报告失败或提前断开时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== "chat_completions" || modelConfig.protocol !== raw.protocol) {
      throw invalidRequest("OpenRouter Adapter 收到了不匹配的协议事件")
    }
    return mapChatStream(raw.events)
  }
}
