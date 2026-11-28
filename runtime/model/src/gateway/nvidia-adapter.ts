import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"
import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./nvidia/openai-chat-completions-adapter.ts"

/** NVIDIA Build 托管 NIM 的 Chat Completions 双向转换器。 */
export class NvidiaAdapter implements ModelConverter {
  /**
   * 将统一历史和本轮模型设置转换为 NVIDIA 的流式请求。
   * @param request 本轮模型引用、历史消息和工具定义。
   * @param context 本轮绑定的模型配置。
   * @returns 交给共享网关的 Chat Completions SDK 请求。
   * @throws AppError 当协议、统一上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    if (modelConfig.protocol !== "chat_completions") throw invalidRequest("NVIDIA Adapter 不支持当前协议")
    return { protocol: "chat_completions", params: buildChatCompletionsRequest(request, modelConfig) }
  }

  /**
   * 将 NVIDIA SDK 分片映射成 Runtime 的统一事件。
   * @param raw 本次网络尝试的原始 SDK 流和取消信号。
   * @param _request 产生该流的统一请求，流转换不读取历史。
   * @param context 本轮绑定的模型配置，用于核对协议。
   * @returns 独立维护分片状态的单次尝试事件流。
   * @throws 协议不匹配、流中断、服务端失败、取消或工具调用缺少必要字段时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== "chat_completions" || raw.protocol !== modelConfig.protocol) {
      throw invalidRequest("NVIDIA Adapter 收到了不匹配的协议事件")
    }
    return mapChatCompletionsStream(raw.events, raw.signal)
  }
}
