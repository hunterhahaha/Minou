import assert from "node:assert/strict"

import { AnthropicAdapter } from "../src/gateway/anthropic-adapter.ts"
import { AdapterRoutingError, MODEL_ADAPTER_REGISTRY, resolveModelConverter } from "../src/gateway/adapter-router.ts"
import type { AdapterRegistry } from "../src/gateway/adapter-router.ts"
import { AnthropicMessagesAdapter } from "../src/gateway/anthropic-messages-adapter.ts"
import { ChatCompletionsAdapter } from "../src/gateway/openai-chat-completions-adapter.ts"
import { GeminiAdapter } from "../src/gateway/gemini-adapter.ts"
import { GLMAdapter } from "../src/gateway/glm-adapter.ts"
import { NvidiaAdapter } from "../src/gateway/nvidia-adapter.ts"
import { OpenAIAdapter } from "../src/gateway/openai-adapter.ts"
import { XaiAdapter } from "../src/gateway/xai-adapter.ts"
import { ResponsesAdapter } from "../src/gateway/openai-responses-adapter.ts"
import { OpenRouterAdapter } from "../src/gateway/openrouter-adapter.ts"
import { PROTOCOLS } from "../src/types.ts"

/**
 * 用独立厂商条目验证路由优先级、冲突及三种通用兜底。
 * @returns 路由断言全部通过后完成。
 * @throws 选出的转换器或错误与预期不符时拒绝。
 */
async function main(): Promise<void> {
  const messagesAdapter = new AnthropicMessagesAdapter()
  const chatAdapter = new ChatCompletionsAdapter()
  const responsesAdapter = new ResponsesAdapter()
  const registry: AdapterRegistry = {
    genericByProtocol: MODEL_ADAPTER_REGISTRY.genericByProtocol,
    vendors: [
      {
        name: "Messages",
        providerNames: ["Messages", "  M Alias  "],
        supportedProtocols: ["anthropic_messages"],
        modelRules: [
          { modelPattern: "claude*", protocol: "anthropic_messages" },
          { modelPattern: "claude-exact", protocol: "anthropic_messages" },
        ],
        adapter: messagesAdapter,
      },
      {
        name: "Chat",
        providerNames: ["Chat"],
        supportedProtocols: ["chat_completions"],
        modelRules: [{ modelPattern: "claude*", protocol: "chat_completions" }],
        adapter: chatAdapter,
      },
      {
        name: "Responses",
        providerNames: ["Responses"],
        supportedProtocols: ["responses"],
        modelRules: [{ modelPattern: "gpt-exact", protocol: "responses" }],
        adapter: responsesAdapter,
      },
      {
        name: "Another Messages",
        providerNames: ["Another Alias"],
        supportedProtocols: ["anthropic_messages"],
        modelRules: [{ modelPattern: "claude-sonnet*", protocol: "anthropic_messages" }],
        adapter: new AnthropicMessagesAdapter(),
      },
    ],
  }

  const messagesModel = { name: "claude-exact", protocol: "anthropic_messages" } as const
  const overlappingModel = { ...messagesModel, name: "claude-sonnet-latest" }
  assert.equal(resolveModelConverter(registry, overlappingModel, "  m ALIAS  "), messagesAdapter)
  assert.equal(resolveModelConverter(registry, { ...messagesModel, name: "other" }, "MESSAGES"), messagesAdapter)
  assert.throws(
    () => resolveModelConverter(registry, { ...messagesModel, protocol: "chat_completions" }, "Messages"),
    { constructor: AdapterRoutingError, message: /Messages.*不支持协议 chat_completions/ },
  )
  assert.equal(resolveModelConverter(registry, messagesModel, "Unknown Proxy"), messagesAdapter)
  assert.equal(resolveModelConverter(registry, { ...messagesModel, protocol: "chat_completions" }), chatAdapter)
  assert.equal(resolveModelConverter(registry, { name: "gpt-exact", protocol: "responses" }), responsesAdapter)
  assert.throws(
    () => resolveModelConverter(registry, overlappingModel, "Unknown Proxy"),
    { constructor: AdapterRoutingError, message: /claude-sonnet-latest.*Messages、Another Messages/ },
  )
  assert.equal(resolveModelConverter(registry, { ...messagesModel, name: "Claude-exact" }), registry.genericByProtocol.anthropic_messages)
  assert.equal(resolveModelConverter(registry, { name: "gpt-exact-extra", protocol: "responses" }), registry.genericByProtocol.responses)
  assert.equal(resolveModelConverter(registry, { ...messagesModel, protocol: "responses" }), registry.genericByProtocol.responses)

  const anthropic = resolveModelConverter(MODEL_ADAPTER_REGISTRY, messagesModel, "Unknown Proxy")
  assert.ok(anthropic instanceof AnthropicAdapter)
  for (const name of ["anthropic", "Anthropic", "  ANtHrOPic  "]) {
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...messagesModel, name: "alias-model" }, name), anthropic)
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...messagesModel, name: "claude" }), registry.genericByProtocol.anthropic_messages)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...messagesModel, name: "Claude-exact" }), registry.genericByProtocol.anthropic_messages)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...messagesModel, name: "alias-model" }, "ant"), registry.genericByProtocol.anthropic_messages)
  assert.throws(
    () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...messagesModel, protocol: "chat_completions" }, "Anthropic"),
    { constructor: AdapterRoutingError, message: /Anthropic.*不支持协议 chat_completions/ },
  )

  const openRouterModel = { name: "anthropic/claude-test", protocol: "chat_completions" } as const
  const openRouter = resolveModelConverter(MODEL_ADAPTER_REGISTRY, openRouterModel, "OpenRouter")
  assert.ok(openRouter instanceof OpenRouterAdapter)
  for (const name of ["Openrouter", "openRouter", "openrouter", " oPeNrOuTeR ", "Open Router"]) {
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, openRouterModel, name), openRouter)
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, openRouterModel, "Unknown Proxy"),
    MODEL_ADAPTER_REGISTRY.genericByProtocol.chat_completions)
  assert.throws(
    () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: openRouterModel.name, protocol: "responses" }, "OpenRouter"),
    { constructor: AdapterRoutingError, message: /OpenRouter.*不支持协议 responses/ },
  )

  const geminiModel = { name: "custom-model", protocol: "chat_completions" } as const
  const gemini = resolveModelConverter(MODEL_ADAPTER_REGISTRY, geminiModel, "Gemini")
  assert.ok(gemini instanceof GeminiAdapter)
  for (const providerName of ["Gemini", "gemini", "  GEMINI  "]) {
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, geminiModel, providerName), gemini)
  }
  for (const name of ["gemini-test", "GEMINI-test"]) {
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...geminiModel, name }, "Unknown Proxy"), gemini)
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...geminiModel, name: "Gemini-test" }),
    MODEL_ADAPTER_REGISTRY.genericByProtocol.chat_completions)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "gemini-test", protocol: "responses" }),
    MODEL_ADAPTER_REGISTRY.genericByProtocol.responses)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...geminiModel, name: "gemini-test" }, "OpenRouter"), openRouter)
  assert.throws(
    () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "gemini-test", protocol: "responses" }, "Gemini"),
    { constructor: AdapterRoutingError, message: /Gemini.*不支持协议 responses/ },
  )

  const nvidiaModel = { name: "openai/gpt-oss-120b", protocol: "chat_completions" } as const
  const nvidia = resolveModelConverter(MODEL_ADAPTER_REGISTRY, nvidiaModel, "NVIDIA")
  assert.ok(nvidia instanceof NvidiaAdapter)
  for (const name of [nvidiaModel.name, "meta/llama-3.3-70b-instruct"]) {
    const model = { ...nvidiaModel, name }
    for (const providerName of ["NVIDIA", "nvidia", "Nvidia", "  NvIdIa\t"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, model, providerName), nvidia)
    }
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, model, "OpenRouter"), openRouter)
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, model, "Unknown Proxy"),
      MODEL_ADAPTER_REGISTRY.genericByProtocol.chat_completions)
  }
  for (const protocol of ["responses", "anthropic_messages"] as const) {
    assert.throws(
      () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { ...nvidiaModel, protocol }, "Nvidia"),
      { constructor: AdapterRoutingError, message: new RegExp(`NVIDIA.*不支持协议 ${protocol}`) },
    )
  }

  const openAI = resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "custom-model", protocol: "responses" }, "OpenAI")
  assert.ok(openAI instanceof OpenAIAdapter)
  for (const protocol of ["responses", "chat_completions"] as const) {
    for (const providerName of ["OpenAI", "OpenAi", "openAI", "openai", "  oPeNaI  "]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "custom-model", protocol }, providerName), openAI)
    }
    for (const name of ["gpt-test", "GPT-test"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name, protocol }, "Unknown Proxy"), openAI)
    }
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "Gpt-test", protocol }), registry.genericByProtocol[protocol])
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "gpt-test", protocol: "chat_completions" }, "OpenRouter"), openRouter)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "gpt-test", protocol: "anthropic_messages" }), registry.genericByProtocol.anthropic_messages)
  assert.throws(
    () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "gpt-test", protocol: "anthropic_messages" }, "OpenAI"),
    { constructor: AdapterRoutingError, message: /OpenAI.*不支持协议 anthropic_messages/ },
  )

  const xai = resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "custom-model", protocol: "responses" }, "xAI")
  assert.ok(xai instanceof XaiAdapter)
  for (const protocol of ["responses", "chat_completions"] as const) {
    for (const providerName of ["xAI", "Xai", "XAI", "xai", "  xAi  "]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "custom-model", protocol }, providerName), xai)
    }
    for (const name of ["grok-test", "GROK-test"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name, protocol }, "Unknown Proxy"), xai)
    }
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "Grok-test", protocol }), registry.genericByProtocol[protocol])
  }
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "grok-test", protocol: "chat_completions" }, "OpenRouter"), openRouter)
  assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "grok-test", protocol: "anthropic_messages" }), registry.genericByProtocol.anthropic_messages)
  assert.throws(
    () => resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "grok-test", protocol: "anthropic_messages" }, "xAI"),
    { constructor: AdapterRoutingError, message: /Xai.*不支持协议 anthropic_messages/ },
  )

  const glm = resolveModelConverter(MODEL_ADAPTER_REGISTRY, { name: "glm-5.3", protocol: "chat_completions" })
  assert.ok(glm instanceof GLMAdapter)
  for (const protocol of PROTOCOLS) {
    for (const providerName of ["BigModel", "bigmodel", "BIGMODEL", " BigModel API ", "BigModel Coding Plan",
      "ZAI", "Zai", "zai", "Z.AI", "z.ai", " Z.AI API ", "Z.AI Coding Plan"]) {
      assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { protocol, name: "configured-alias" }, providerName), glm)
    }
    for (const name of ["glm-5.3", "GLM-5.3"]) {
      for (const providerName of [undefined, " ", "My Relay"]) {
        assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { protocol, name }, providerName), glm)
      }
    }
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { protocol, name: "Glm-5.3" }, "Z.AI relay"),
      MODEL_ADAPTER_REGISTRY.genericByProtocol[protocol])
  }

  for (const protocol of PROTOCOLS) {
    assert.equal(resolveModelConverter(registry, { protocol, name: "unknown-model" }, "Unknown Proxy"), registry.genericByProtocol[protocol])
    assert.equal(resolveModelConverter(MODEL_ADAPTER_REGISTRY, { protocol, name: "claude-exact" }, "Messages"),
      protocol === "anthropic_messages" ? anthropic : registry.genericByProtocol[protocol])
  }
  console.log("adapter-router.test.ts: Adapter 路由断言通过")
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
