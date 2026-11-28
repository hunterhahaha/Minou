import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./minimax/openai-chat-completions-adapter.ts"
import { buildResponsesRequest, mapResponsesStream } from "./minimax/openai-responses-adapter.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** MiniMax 各地区 Provider 共用的转换器，SDK Client 由共享网关按 Turn 创建。 */
export class MiniMaxAdapter implements ModelConverter {
  /**
   * 按本轮选定的协议转换历史消息、工具定义和模型参数。
   * @param request 统一模型请求及本次使用的上下文。
   * @param context 本轮模型与协议配置。
   * @returns 可由共享网关交给对应 SDK 的流式请求。
   * @throws 协议不受支持、上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    switch (modelConfig.protocol) {
      case "responses":
        return { protocol: "responses", params: buildResponsesRequest(request, modelConfig) }
      case "chat_completions":
        return { protocol: "chat_completions", params: buildChatCompletionsRequest(request, modelConfig) }
      default:
        throw invalidRequest("MiniMax Adapter 不支持当前协议")
    }
  }

  /**
   * 将本次网络尝试的 SDK 流转换为统一块事件与最终 Usage。
   * @param raw 带协议标记的 SDK 响应流。
   * @param _request 发起此次调用的统一请求。
   * @param context 本轮模型配置，用于核对协议标记。
   * @returns 独立维护分片状态的统一事件流。
   * @throws 协议不匹配、不受支持、上游失败或提前断流时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== modelConfig.protocol) throw invalidRequest("MiniMax Adapter 收到了不匹配的协议事件")
    switch (raw.protocol) {
      case "responses":
        return mapResponsesStream(raw.events)
      case "chat_completions":
        return mapChatCompletionsStream(raw.events, raw.signal)
      default:
        throw invalidRequest("MiniMax Adapter 不支持当前流协议")
    }
  }
}
