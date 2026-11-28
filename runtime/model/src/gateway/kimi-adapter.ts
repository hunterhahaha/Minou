import { buildChatRequest, mapChatStream } from "./kimi/openai-chat-completions-adapter.ts"
import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** Kimi 开放平台和 Coding Plan 共用的 Chat Completions 转换器。 */
export class KimiAdapter implements ModelConverter {
  /**
   * 使用本轮模型配置构造 Kimi 流式请求。
   * @param request 统一上下文、工具与本轮推理档位。
   * @param context 本轮模型和协议配置。
   * @returns 带协议标记的 SDK 请求。
   * @throws AppError 当协议、上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    if (modelConfig.protocol !== "chat_completions") throw invalidRequest("Kimi Adapter 不支持当前协议")
    return { protocol: "chat_completions", params: buildChatRequest(request, modelConfig) }
  }

  /**
   * 将 Kimi SDK 流转换为 Runtime 块事件和终态。
   * @param raw 单次网络尝试的 SDK 流和取消信号。
   * @param _request 产生本次 SDK 流的统一请求。
   * @param context 用于核对流标记的模型协议。
   * @returns 单次尝试独立的统一事件流。
   * @throws 协议不匹配、流失败、取消或意外中断时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== "chat_completions" || modelConfig.protocol !== raw.protocol) {
      throw invalidRequest("Kimi Adapter 收到了不匹配的协议事件")
    }
    return mapChatStream(raw.events, raw.signal)
  }
}
