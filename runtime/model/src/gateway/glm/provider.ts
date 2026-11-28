import { isAbortError } from "../../../../error/src/abort.ts"
import { isAppError } from "../../shared.ts"
import type { AssistantContentBlock, BlockReplay, Protocol } from "../../types.ts"

/** BigModel 的路由和错误、Usage 提取共用这些 Provider 名称。 */
export const BIGMODEL_NAMES = ["BigModel", "BigModel API", "BigModel Coding Plan"] as const
/** Z.AI 的路由和错误、Usage 提取共用这些 Provider 名称。 */
export const ZAI_NAMES = ["ZAI", "Z.AI", "Z.AI API", "Z.AI Coding Plan"] as const

/** 自定义 Provider 经模型规则命中时使用协议默认字段。 */
export type GlmProvider = "bigmodel" | "zai" | "default"

/**
 * 使用和适配器路由相同的名称规则选择字段提取方式。
 * @param providerName Provider 快照中的名称。
 * @returns 已登记的平台或协议默认分支。
 */
export function glmProvider(providerName?: string): GlmProvider {
  const name = providerName?.trim().toLowerCase()
  if (BIGMODEL_NAMES.some((alias) => alias.toLowerCase() === name)) return "bigmodel"
  if (ZAI_NAMES.some((alias) => alias.toLowerCase() === name)) return "zai"
  return "default"
}

/**
 * 检查一个来自 JSON 或 SDK 的值是否可读取对象属性。
 * @param value 待检查的值。
 * @returns 非数组对象或 undefined。
 */
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/**
 * 读取同来源、同协议的思考回放对象，具体原生字段由协议校验。
 * @param block 从会话历史读取的统一内容块。
 * @param protocol 目标请求协议。
 * @returns 可供协议验证的 JSON 对象，来源或 JSON 无效时省略。
 */
export function readThinkingReplay(block: AssistantContentBlock, protocol: Protocol): Record<string, unknown> | undefined {
  if (block.type !== "thinking" || block.replay?.name !== "GLM" || block.replay.protocol !== protocol) return undefined
  try { return record(JSON.parse(block.replay.payloadJson)) }
  catch { return undefined }
}

/**
 * 封装已完成的原生思考块供后续同协议请求使用。
 * @param protocol 产生思考的协议。
 * @param payload 该协议构造的可 JSON 序列化原生字段。
 * @returns 可随统一思考块持久化的回放。
 * @throws TypeError 原生字段无法序列化时抛出。
 */
export function thinkingReplay(protocol: Protocol, payload: object): BlockReplay {
  return { name: "GLM", protocol, payloadJson: JSON.stringify(payload) }
}

/**
 * 提取 Provider 流或 SDK 错误，同时保留共享层重试所需的原始异常。
 * @param error 原始事件、SDK 异常或已解包的错误体。
 * @param protocol 当前 SDK 协议。
 * @param provider 本轮识别的 Provider。
 * @param fallback 已确认是错误事件时使用的兜底消息。
 * @returns 可由共享网关归一化的错误，未识别的 SDK 或传输异常原样返回。
 */
export function extractProviderError(error: unknown, protocol: Protocol, provider: GlmProvider, fallback?: string): unknown {
  if (isAbortError(error) || isAppError(error)) return error
  const top = record(error)
  const response = protocol === "responses" ? record(top?.response) : undefined
  const envelope = record(top?.error)
  const body = record(response?.error) ?? record(envelope?.error) ?? envelope ?? top

  const bodyCode = body?.code ?? top?.code
  const code = typeof bodyCode === "string" && bodyCode.length > 0 ? bodyCode
    : protocol === "chat_completions" && provider === "zai" && typeof bodyCode === "number" && Number.isInteger(bodyCode)
      ? String(bodyCode) : undefined
  const bodyType = body?.type
  const type = typeof bodyType === "string" && bodyType !== "error" && bodyType !== "response.failed" ? bodyType : undefined
  const message = typeof body?.message === "string" && body.message.length > 0 ? body.message : undefined
  if (fallback === undefined && (body === top || message === undefined) && code === undefined && type === undefined) return error

  const requestId = [top?.requestID, top?.requestId, top?.request_id, response?.request_id,
    envelope?.request_id, body?.request_id].find((value) => typeof value === "string" && value.length > 0)
  const sdkMessage = typeof top?.message === "string" ? top.message : undefined
  return Object.assign(new Error(message ?? sdkMessage ?? fallback ?? String(error), { cause: error }), {
    ...(typeof top?.status === "number" ? { status: top.status } : {}),
    ...(requestId !== undefined ? { requestID: requestId } : {}),
    error: { code, type: type ?? (protocol === "responses" ? code : undefined) },
  })
}

/**
 * 读取原始 SDK 流，并在 SDK 自行抛出错误体时应用同一提取规则。
 * @param events 本次尝试的原始 SDK 事件。
 * @param protocol 当前 SDK 协议。
 * @param provider 本轮识别的 Provider。
 * @returns 由协议转换器继续消费的事件。
 * @throws SDK 或传输错误经提取后交给共享网关处理。
 */
export async function* readProviderStream<T>(events: AsyncIterable<T>, protocol: Protocol, provider: GlmProvider): AsyncGenerator<T> {
  try { yield* events }
  catch (error) { throw extractProviderError(error, protocol, provider) }
}
