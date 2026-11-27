import type {ModelConversionContext, ModelConverter, ProtocolRequest, ProtocolResponseStream} from "./adapter.ts"
import {buildChatRequest, mapChatStream} from "./deepseek/openai-chat-completions-adapter.ts"
import {buildMessagesRequest, mapMessagesStream} from "./deepseek/anthropic-messages-adapter.ts"
import {buildResponsesRequest, mapResponsesStream} from "./deepseek/openai-responses-adapter.ts"
import {invalidRequest} from "../shared.ts"
import type {ModelStreamEvent, UnifiedModelRequest} from "../types.ts"

/** DeepSeek 三种兼容协议的请求和响应转换器。 */
export class DeepSeekAdapter implements ModelConverter {
    /**
     * 按选定协议设置思考开关、输出上限和会话历史回放。
     * @param request 本次模型请求，包含选定档位与已裁剪的上下文。
     * @param context 本轮模型与协议配置，开启思考时沿用模型配置的档位字段。
     * @returns 可直接交给对应 SDK 的流式请求。
     * @throws AppError 当统一上下文或推理配置无效时抛出。
     */
    buildRequest(request: UnifiedModelRequest, {modelConfig}: ModelConversionContext): ProtocolRequest {
        const thinkingDisabled = !modelConfig.supportsReasoning || request.model.reasoningLevel === "none"
        const thinking = {type: thinkingDisabled ? "disabled" as const : "enabled" as const}

        switch (modelConfig.protocol) {
            case "chat_completions":
                return {protocol: "chat_completions", params: buildChatRequest(request, modelConfig, thinking)}
            case "responses":
                return {protocol: "responses", params: buildResponsesRequest(request, modelConfig, thinkingDisabled)}
            case "anthropic_messages":
                return {
                    protocol: "anthropic_messages",
                    params: buildMessagesRequest(request, modelConfig, thinking),
                    useBeta: false
                }
        }
    }

    /**
     * 将 DeepSeek SDK 流转换为统一块事件和最终用量。
     * @param raw 本次网络尝试返回的 SDK 事件流。
     * @param request 发起该流的统一请求，用来区分独立摘要与可回放的消息。
     * @param context 绑定的模型协议，用来核对原始流标记。
     * @returns 本次网络尝试独立的统一事件流。
     * @throws AppError 当协议不匹配时抛出；协议流失败或提前断开时抛出流错误。
     */
    mapResponseStream(
        raw: ProtocolResponseStream,
        request: UnifiedModelRequest,
        {modelConfig}: ModelConversionContext,
    ): AsyncIterable<ModelStreamEvent> {
        if (raw.protocol !== modelConfig.protocol) throw invalidRequest("DeepSeek Adapter 收到了不匹配的协议事件")

        switch (raw.protocol) {
            case "chat_completions":
                return mapChatStream(raw.events)
            case "responses":
                return mapResponsesStream(raw.events)
            case "anthropic_messages":
                return mapMessagesStream(raw.events, request.context.purpose !== "summary")
        }
    }
}
