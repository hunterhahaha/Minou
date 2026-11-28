import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./gemini/openai-chat-completions-adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** Gemini OpenAI 兼容 Chat Completions 的请求和响应转换器。 */
export class GeminiAdapter implements ModelConverter {
  /**
   * 构造 Gemini 的流式请求，并按历史块的来源恢复原生签名。
   * @param request 本次统一请求，包含历史消息和工具定义。
   * @param context 本轮绑定的模型配置。
   * @returns 交给共享网关的 Chat Completions SDK 请求。
   * @throws AppError 当协议、统一上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    if (modelConfig.protocol !== "chat_completions") throw invalidRequest("Gemini Adapter 不支持当前协议")
    return { protocol: "chat_completions", params: buildChatCompletionsRequest(request, modelConfig) }
  }

  /**
   * 将 Gemini SDK 分片转换为统一内容块和最终流状态。
   * @param raw 本次网络尝试的原始协议流。
   * @param _request 产生该流的统一请求。
   * @param context 本轮绑定的模型配置，用于核对协议。
   * @returns 单次尝试独立的统一事件流。
   * @throws 协议不匹配、SDK 流失败、意外中断或结束后工具调用仍缺少必要字段时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== "chat_completions" || raw.protocol !== modelConfig.protocol) {
      throw invalidRequest("Gemini Adapter 收到了不匹配的协议事件")
    }
    return mapChatCompletionsStream(raw.events)
  }
}
