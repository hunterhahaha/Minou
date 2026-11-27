# 新增模型 Adapter

厂商 Adapter 将 Minou 的统一请求转换成厂商请求，并将厂商的流式响应转换成 Runtime 事件。厂商逻辑放在 `runtime/model/src/gateway/`，每个厂商实现一个 `ModelConverter`。同一厂商支持多种协议时，在它的 `buildRequest()` 和 `mapResponseStream()` 内分别处理协议分支。 [模型网关源码](../runtime/model/src/gateway/)

## Adapter 在调用链中的位置

桌面和 CLI 在进入 `runAgentLoop()` 前共用 Turn 模型装配。装配读取同一份 Provider 快照，用 Provider 名称、API 模型名和所选协议选出转换器，再绑定本轮 SDK Client。实际请求由共享 `stream()` 按下图执行。 [Turn 模型装配](../src/main/model-adapters.ts) · [共享流入口](../runtime/model/src/gateway/adapter.ts)

```text
统一请求 → Adapter.buildRequest() → 按协议发起 SDK 请求 → Adapter.mapResponseStream() → 统一事件流
```

路由表中的 `ModelConverter` 是转换器，Runtime 拿到的 `ModelAdapter` 是绑定本轮模型和连接的流接口。当前网关支持 `anthropic_messages`、`chat_completions` 和 `responses`，生产路由表目前登记这三种协议的通用转换器。新增厂商适配使用其中已有的协议。新增协议或改变 SDK 传输方式涉及网关与配置契约，应先独立确认范围。 [统一模型类型](../runtime/model/src/types.ts) · [架构与执行流程](architecture.md)

## 实现请求与响应流转换

| 方法或字段 | 含义 |
| --- | --- |
| `buildRequest(request, context): ProtocolRequest` | 每次逻辑请求执行一次。把统一上下文、工具定义、模型及推理设置转换成 SDK 请求参数。 |
| `mapResponseStream(raw, request, context): AsyncIterable<ModelStreamEvent>` | 每次网络尝试执行一次。消费 SDK 事件，增量产出统一事件。原始请求可用于区分会话历史、独立摘要和其他直接消息请求。 |
| `context.modelConfig` | 本轮模型与协议配置，包括 API 模型名、`protocol`、`maxOutputTokens`、`supportsReasoning`、`reasoningLevels` 和 `reasoningField` 等。 |
| `context.providerName` | 本轮 Provider 快照中的原始名称。厂商转换器可按名称判断是否启用自身的协议扩展。 |
| `ProtocolRequest.protocol`、`params` | 协议标记及该协议的 SDK 请求参数。Anthropic Messages 分支另有 `useBeta`，供共享流选择 Messages SDK 入口。 |
| `ProtocolResponseStream.protocol`、`events` | 原始流的协议标记及 SDK 事件的异步迭代器。先按协议收窄类型，再读取事件字段。 |

下面的 `ExampleAdapter` 是示例厂商，展示如何在一个类里支持 Chat Completions 和 Responses。把文件放在 `runtime/model/src/gateway/example.ts`，在各自的请求构造和事件映射处实现厂商差异。协议共有部分可以复用现有构造函数和流映射器。 [Chat Completions 实现](../runtime/model/src/gateway/chat-completions.ts) · [Responses 实现](../runtime/model/src/gateway/responses.ts) · [Anthropic Messages 实现](../runtime/model/src/gateway/anthropic.ts)

```ts
import type {
  ModelConversionContext,
  ModelConverter,
  ProtocolRequest,
  ProtocolResponseStream,
} from "./adapter.ts"
import { buildChatCompletionsRequest, mapChatCompletionsStream } from "./chat-completions.ts"
import { buildResponsesRequest, mapResponsesStream } from "./responses.ts"
import { invalidRequest } from "../shared.ts"
import type { ModelStreamEvent, UnifiedModelRequest } from "../types.ts"

/** 示例厂商的双向转换器。 */
export class ExampleAdapter implements ModelConverter {
  /**
   * 按本轮选定协议构造流式请求。
   * @param request 统一模型请求。
   * @param context 本轮模型和 Provider 信息。
   * @returns 带协议标记的 SDK 请求。
   * @throws 本轮协议或请求内容无法转换时抛出。
   */
  buildRequest(request: UnifiedModelRequest, context: ModelConversionContext): ProtocolRequest {
    const { modelConfig, providerName } = context
    switch (modelConfig.protocol) {
      case "chat_completions":
        return {
          protocol: "chat_completions",
          params: buildChatCompletionsRequest(request, modelConfig, providerName),
        }
      case "responses":
        return {
          protocol: "responses",
          params: buildResponsesRequest(request, modelConfig),
        }
      default:
        throw invalidRequest("Example Adapter 不支持当前协议")
    }
  }

  /**
   * 将本次尝试的 SDK 事件流转换为统一事件。
   * @param raw 带协议标记的原始事件流。
   * @param request 产生该流的原始统一请求。
   * @param context 本轮模型和 Provider 信息。
   * @returns 独立的统一事件流。
   * @throws 协议不匹配、流报告失败或意外中断时抛出。
   */
  mapResponseStream(
    raw: ProtocolResponseStream,
    request: UnifiedModelRequest,
    context: ModelConversionContext,
  ): AsyncIterable<ModelStreamEvent> {
    if (raw.protocol !== context.modelConfig.protocol) {
      throw invalidRequest("Example Adapter 收到了不匹配的协议事件")
    }
    switch (raw.protocol) {
      case "chat_completions":
        return mapChatCompletionsStream(raw.events, request, context.providerName)
      case "responses":
        return mapResponsesStream(raw.events)
      default:
        throw invalidRequest("Example Adapter 不支持当前流协议")
    }
  }
}
```

## 登记到路由表

在 `adapter-router.ts` 导入新 Adapter，将一个 `VendorAdapterEntry` 加入 `MODEL_ADAPTER_REGISTRY.vendors` 的数组。`genericByProtocol` 为三个已有协议提供最终兜底。 [路由表](../runtime/model/src/gateway/adapter-router.ts)

```ts
import { ExampleAdapter } from "./example.ts"

const exampleVendor = {
  name: "Example",
  providerNames: ["Example", "Example Cloud"],
  supportedProtocols: ["chat_completions", "responses"],
  modelRules: [
    { modelPattern: "example-*", protocol: "chat_completions" },
    { modelPattern: "example-pro", protocol: "responses" },
  ],
  adapter: new ExampleAdapter(),
} satisfies VendorAdapterEntry

// 将 exampleVendor 加入现有注册表的 vendors 数组。
// 当前数组为空时，写成 vendors: Object.freeze([exampleVendor])。
```

| 注册字段 | 含义 |
| --- | --- |
| `name` | 用于冲突和不支持协议诊断的条目名称。路由按 `providerNames` 匹配 Provider 名称。 |
| `providerNames` | Provider 数据库里的名称及别名。两侧都会去首尾空白并转小写，随后精确比较。 |
| `supportedProtocols` | 请求构造与响应流转换均支持的协议。各条 `modelRules` 的 `protocol` 应包含在这个列表中。 |
| `modelRules` | Provider 名称未命中时使用的 `modelPattern + protocol` 规则。模式比较的是大小写敏感的 API 模型名 `model.name`，支持精确匹配和末尾 `*` 前缀匹配。 |
| `adapter` | 进程内复用的 `ModelConverter` 实例。 |

路由按下列顺序执行。

1. **按 Provider 名称匹配。** 多个条目命中时报错。唯一条目命中后校验选定协议，协议不支持时直接报错。
2. **按 API 模型名和协议匹配。** 只有 Provider 名称未命中才进入这一层。同一个转换器命中多条规则仍算一个结果，多个不同转换器同时命中时报错。注册顺序、精确匹配和前缀长度都不会消解冲突。
3. **回退到通用 Adapter。** 前两层都未命中时，按所选协议取 `genericByProtocol` 中的转换器。

例如，自定义 Provider 名为「我的中转站」，模型为 `example-chat`，协议为 `chat_completions`，会通过模型规则命中 `ExampleAdapter`，请求仍发往该中转站。如果 Provider 名为 `Example Cloud`，却选择 `anthropic_messages`，则在第一层报错。兼容供应商目录用于提供建档资料，运行时厂商转换要在网关注册表中显式登记。 [兼容供应商目录](../src/main/compatible-providers.ts) · [Provider 配置与持久化](configuration-and-storage.md#providerssqlite)

## 实现约束

- **保持协议和连接一致。** `buildRequest()` 返回的协议必须等于 `context.modelConfig.protocol`，`mapResponseStream()` 按原始流的协议解析。地址、API Key 和额外请求头由本轮选中的 Provider 配置传给 SDK。
- **区分请求校验和流执行错误。** `buildRequest()` 在 `runModelStream()` 之前执行，预期的请求校验失败应抛出 `invalidRequest()` 生成的统一错误。网关会原样传递请求构造方法抛出的错误。SDK 请求和响应流转换中的错误由共享流处理，包括归一化、取消以及满足条件时的重试。SDK 超时由共享流传入对应请求函数。
- **转换状态只属于一次尝试。** 把块索引、工具参数缓冲、Usage 和终止状态放在 `mapResponseStream()` 生成的流内。Adapter 实例跨 Turn 复用。首个 `block_delta` 之前发生可重试错误时，共享流可能重新发起请求并重新转换响应流，此前缓冲的事件会被丢弃。
- **遵守统一事件契约。** 块的 `index` 从 0 开始分配，同一块的 `block_start`、`block_delta` 和 `block_end` 使用相同索引及对应类型。`block_end` 给出完整内容。工具调用需保留稳定的调用 ID，供后续工具结果关联。流按协议结束时，在全部块结束后输出一个 `stream_end`，交付统一完成状态，以及可用的 Usage 和原始结束原因。流失败、意外中断或取消时走错误路径。
- **按实际字段语义映射。** 厂商专用字段及同名字段差异由厂商 Adapter 处理。推理配置可以复用 `reasoningRequestFragment()`，它仅在 `supportsReasoning` 为 true 时校验档位并生成配置字段。Usage 应沿用现有计数口径，缺失的可选计数桶保持缺失。
- **成对实现原生回放。** 由 Adapter 决定哪些模型、Provider 和请求上下文启用回放。若需要保留厂商签名或加密思考，在完整内容块上保存带来源的 `replay`，构造历史请求时校验来源并回传。检查摘要、标题等独立请求的行为。

[流事件与回放契约](../runtime/model/src/types.ts) · [共享流与推理配置](../runtime/model/src/shared.ts) · [Usage 转换](../runtime/model/src/usage.ts)

## 验证新增 Adapter

1. 构造独立注册表，核对名称、别名、模型加协议、同一转换器多条规则去重、重叠报错、协议不支持报错与通用兜底。 [路由测试](../runtime/model/test/adapter-router.test.ts)
2. 用协议事件样本验证请求字段和响应事件顺序，覆盖普通对话、工具调用前后、Usage、结束原因与异常流。涉及思考回放时，验证流转换收取的原生数据能在下一次请求中正确回传。
3. 复用本地假 Provider 走真实 SDK，验证路由选中的转换器、实际请求地址和字段，以及取消和重试。代码实现完成后运行定向测试、`npm run typecheck` 和 `npm run build`。 [本地假 Provider](../runtime/model/test/helpers.ts) · [开发与验证指南](development.md#按模块选择测试)
