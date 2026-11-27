import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildMessagesRequest, mapMessagesStream } from "./anthropic/anthropic-messages-adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** Anthropic 官方 Messages 协议的请求与流事件转换器。 */
export class AnthropicAdapter implements ModelConverter {
  /**
   * 构造本轮 Messages 请求及 SDK 入口选项。
   * @param request 含模型、会话上下文与工具定义的统一请求。
   * @param context 本轮绑定的模型及协议配置。
   * @returns 可由共享网关直接发出的 Messages 请求。
   * @throws AppError 当协议、上下文、原生回放或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    if (modelConfig.protocol !== "anthropic_messages") {
      throw invalidRequest("Anthropic Adapter 需要 Anthropic Messages 协议")
    }
    return buildMessagesRequest(request, modelConfig)
  }

  /**
   * 将一次 Messages 流尝试转换为独立的统一事件流。
   * @param raw 共享网关交付的 SDK 原始流及其协议。
   * @param _request 发起该流的统一请求，回放来源固定于此转换器。
   * @param context 本轮绑定的协议，用于核对原始流的标记。
   * @returns 块事件、原生回放和最终用量组成的异步流。
   * @throws AppError 当流或模型协议与此转换器不匹配时抛出；流不完整时消费事件会失败。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== "anthropic_messages" || raw.protocol !== modelConfig.protocol) {
      throw invalidRequest("Anthropic Adapter 收到了不匹配的协议事件")
    }
    return mapMessagesStream(raw.events)
  }
}
