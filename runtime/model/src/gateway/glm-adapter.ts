import type { ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream } from "./adapter.ts"
import { buildMessagesRequest, mapMessagesStream } from "./glm/anthropic-messages-adapter.ts"
import { buildChatRequest, mapChatStream } from "./glm/openai-chat-completions-adapter.ts"
import { buildResponsesRequest, mapResponsesStream } from "./glm/openai-responses-adapter.ts"
import { glmProvider, readProviderStream } from "./glm/provider.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** BigModel 与 Z.AI 共用的三协议转换器，每次流转换独立维护状态。 */
export class GLMAdapter implements ModelConverter {
  /**
   * 按模型配置构造可由网关发送的流式请求。
   * @param request 本轮模型引用、会话上下文和工具定义。
   * @param context 当前模型的协议、输出上限和推理配置。
   * @returns 带 SDK 协议标记的请求参数。
   * @throws AppError 当上下文或推理配置无效时抛出。
   */
  buildRequest(request: UnifiedModelRequest, { modelConfig }: ModelConversionContext): ProtocolRequest {
    switch (modelConfig.protocol) {
      case "chat_completions":
        return { protocol: "chat_completions", params: buildChatRequest(request, modelConfig) }
      case "responses":
        return { protocol: "responses", params: buildResponsesRequest(request, modelConfig) }
      case "anthropic_messages":
        return { protocol: "anthropic_messages", params: buildMessagesRequest(request, modelConfig), useBeta: false }
    }
  }

  /**
   * 转换一次 SDK 请求的流，并按 Provider 提取错误与用量。
   * @param raw 本次尝试的 SDK 事件流。
   * @param _request 生成流的统一请求，当前转换只依赖协议与 Provider。
   * @param context 本轮绑定的协议与 Provider 名称。
   * @returns 本次尝试的统一事件流。
   * @throws AppError 当协议不匹配时抛出；流报告失败或缺少终态时由迭代器抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    _request: UnifiedModelRequest,
    { modelConfig, providerName }: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== modelConfig.protocol) throw invalidRequest("GLM Adapter 收到了不匹配的协议事件")
    const provider = glmProvider(providerName)
    switch (raw.protocol) {
      case "chat_completions":
        return mapChatStream(readProviderStream(raw.events, raw.protocol, provider), provider)
      case "responses":
        return mapResponsesStream(readProviderStream(raw.events, raw.protocol, provider), provider)
      case "anthropic_messages":
        return mapMessagesStream(readProviderStream(raw.events, raw.protocol, provider), provider)
    }
  }
}
