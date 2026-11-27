/**
 * 按 Turn 快照选择转换器，统一执行协议流式请求。
 *
 * 连接参数由调用方提供，本入口不读取凭据或数据库，也不缓存 SDK Client 与 Adapter。
 */

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { MODEL_ADAPTER_REGISTRY, resolveModelConverter } from "./adapter-router.ts"
import type { AdapterRegistry } from "./adapter-router.ts"
import { requestAnthropicStream } from "./anthropic.ts"
import type { AnthropicRequest } from "./anthropic.ts"
import { requestChatCompletionsStream } from "./chat-completions.ts"
import { requestResponsesStream } from "./responses.ts"
import { assertRequestMatchesModel, invalidRequest, runModelStream } from "../shared.ts"
import type { ModelAdapter, ModelConfig, ModelStreamEvent, ModelStreamOptions, ReplaySource, UnifiedModelRequest } from "../types.ts"

/** 启用端点原生回放及可选的会话内工具变更。 */
export type NativeHistoryPolicy = ReplaySource & { inlineToolChanges: boolean }

/**
 * 创建一个 Adapter 所需的协议侧连接参数。
 *
 * 凭据本身由 `CredentialStore` 按 providerId 提供，本接口只接收它的结果，
 * 因此这里没有 providerId 字段 —— Adapter 不查凭据，只被喂凭据。
 *
 * `baseURL` 与 `defaultHeaders` 由宿主从 Provider 配置快照提供；
 * 未传地址时使用 SDK 默认值。
 */
export interface ProtocolClientOptions {
  /** 由 CredentialStore 按 Provider 提供的 API Key。 */
  apiKey: string
  /** 协议客户端使用的 Provider 地址；缺失时使用 SDK 默认地址。 */
  baseURL?: string
  /** 传给协议客户端的额外请求头。 */
  defaultHeaders?: Record<string, string>
  /** 匹配兼容目录规则时可回放的原生块来源。 */
  nativeHistory?: NativeHistoryPolicy
}

/** 两个转换方法在本轮共用的模型和回放配置。 */
export interface ModelConversionContext {
  /** 绑定到本轮的模型、协议与推理配置。 */
  readonly modelConfig: ModelConfig
  /** 本轮允许使用的原生历史。 */
  readonly nativeHistory?: NativeHistoryPolicy
}

/** A 产出的请求，协议标记对应 SDK 参数类型。 */
export type ProtocolRequest =
  | { protocol: "anthropic_messages"; params: AnthropicRequest; useBeta: boolean }
  | { protocol: "chat_completions"; params: OpenAI.ChatCompletionCreateParamsStreaming }
  | { protocol: "responses"; params: OpenAI.Responses.ResponseCreateParamsStreaming }

/** B 消费的一次请求尝试的原始协议事件。 */
export type ProtocolResponseStream =
  | { protocol: "anthropic_messages"; events: AsyncIterable<Anthropic.Messages.RawMessageStreamEvent> }
  | { protocol: "chat_completions"; events: AsyncIterable<OpenAI.ChatCompletionChunk> }
  | { protocol: "responses"; events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent> }

/** 注册表中的双向转换器。每次 B 调用独立维护流解析状态。 */
export interface ModelConverter {
  /**
   * 将统一请求转换为所选协议的 SDK 参数。
   * @param request 当前统一请求。
   * @param context 本轮转换配置。
   * @returns 发送前的协议请求。
   * @throws AppError 请求无法转换时抛出。
   */
  A(request: UnifiedModelRequest, context: ModelConversionContext): ProtocolRequest
  /**
   * 消费协议事件，逐步生成 Runtime 事件。
   * @param raw 原始事件的协议标记和异步流。
   * @param request 生成本次流的统一请求，用于识别历史与摘要等用途。
   * @param context 本轮转换配置。
   * @returns 此次尝试的新事件流。
   * @throws 当协议不匹配、报告失败或流被截断时抛出。
   */
  B(raw: ProtocolResponseStream, request: UnifiedModelRequest, context: ModelConversionContext): AsyncIterable<ModelStreamEvent>
}

/**
 * 通过本轮选定的 A/B 发出一次模型请求，并流式返回统一事件。
 * @param converter 本轮路由选定的转换器。
 * @param context 本轮模型和回放配置。
 * @param client 绑定到 Provider 连接配置的 SDK Client。
 * @param request Runtime 提交的统一请求。
 * @param signal 调用方的取消信号。
 * @param options 单次请求的 SDK 超时和网络重试设置。
 * @returns 由 B 转换并由共享重试入口交付的模型事件流。
 * @throws AppError 请求无效、失败或取消时抛出。
 */
async function* stream(
  converter: ModelConverter,
  context: ModelConversionContext,
  client: Anthropic | OpenAI,
  request: UnifiedModelRequest,
  signal: AbortSignal,
  options?: ModelStreamOptions,
): AsyncGenerator<ModelStreamEvent> {
  assertRequestMatchesModel(request, context.modelConfig)
  const outbound = converter.A(request, context)
  if (outbound.protocol !== context.modelConfig.protocol) {
    throw invalidRequest("Adapter 生成的请求协议与当前模型配置不一致")
  }

  yield* runModelStream((attemptSignal) => {
    const timeout = options?.timeoutMs
    let raw: ProtocolResponseStream
    switch (outbound.protocol) {
      case "anthropic_messages":
        if (!(client instanceof Anthropic)) throw invalidRequest("Anthropic Messages 需要 Anthropic SDK Client")
        raw = {
          protocol: outbound.protocol,
          events: requestAnthropicStream(client, outbound.params, attemptSignal, outbound.useBeta, timeout),
        }
        break
      case "chat_completions":
        if (!(client instanceof OpenAI)) throw invalidRequest("Chat Completions 需要 OpenAI SDK Client")
        raw = {
          protocol: outbound.protocol,
          events: requestChatCompletionsStream(client, outbound.params, attemptSignal, timeout),
        }
        break
      case "responses":
        if (!(client instanceof OpenAI)) throw invalidRequest("Responses 需要 OpenAI SDK Client")
        raw = {
          protocol: outbound.protocol,
          events: requestResponsesStream(client, outbound.params, attemptSignal, timeout),
        }
        break
    }
    return converter.B(raw, request, context)
  }, signal, options?.retry)
}

/**
 * 选择一个转换器，创建本轮 SDK Client 并绑定共享流入口。
 *
 * @param config 要绑定的 Provider、协议和模型配置。
 * @param options 协议客户端所需的凭据、地址和额外请求头。
 * @param providerName 快照中的 Provider 名称，未提供时从模型规则开始查找。
 * @param registry 路由定义，默认使用进程级注册表。
 * @returns 已绑定当前模型和连接信息的 Runtime 流接口。
 * @throws 当路由冲突、厂商不支持所选协议或 SDK Client 初始化失败时抛出。
 */
export function createModelAdapter(
  config: ModelConfig,
  options: ProtocolClientOptions,
  providerName?: string,
  registry: AdapterRegistry = MODEL_ADAPTER_REGISTRY,
): ModelAdapter {
  const converter = resolveModelConverter(registry, config, providerName)
  const clientOptions = {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    defaultHeaders: options.defaultHeaders,
    maxRetries: 0,
  }
  const client = config.protocol === "anthropic_messages" ? new Anthropic(clientOptions) : new OpenAI(clientOptions)
  const context = { modelConfig: config, nativeHistory: options.nativeHistory }
  return { stream: stream.bind(undefined, converter, context, client) }
}
