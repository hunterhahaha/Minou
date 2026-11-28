/** xAI 全球 API 入口与 Grok 4.5 至 4.7 的文本模型创建资料。 */

import type { CompatibleProviderDefinition } from "../compatible-providers.ts"

/** 两种协议共用模型规格，Responses 优先展示。 */
export const XAI_PROVIDERS: readonly CompatibleProviderDefinition[] = ([
  "responses", "chat_completions",
] as const).map((protocol) => ({
  protocol,
  url: "https://api.x.ai/v1",
  models: ["grok-4.7", "grok-4.6", "grok-4.5"].map((name) => ({
    name,
    contextWindow: 500000,
    /** Minou 下发的输出预算，采用 xAI Responses 的默认值。 */
    maxOutputTokens: 128000,
    supportsReasoning: true,
    /** Grok 4.5 将 xhigh 按 high 执行。 */
    reasoningLevels: name === "grok-4.5" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"],
    reasoningField: { path: protocol === "responses" ? ["reasoning", "effort"] : ["reasoning_effort"] },
  })),
}))
