/**
 * AgentLoop：一个 Turn 内的 Step 循环（第 13.3 节）。
 *
 * 本阶段只实现「正常模型请求」这一条数据流（TODOList 阶段 6.1）：
 *
 *   content（调用方构建一次）+ tools + 本 Turn 固定 ModelRef + AbortSignal
 *     → Adapter.stream()
 *     → ModelStreamEvent
 *     → Session 事件：step/start、assistant/block_start | block_delta | block_end、
 *       assistant/message、step/end
 *     → appendEvent（SessionEventLog 补 eventId / sessionId / seq / createdAt）
 *
 * 循环结构按第 13.3 节保留：每个 Step 一次正常模型请求，Step 结束后由 `needsNextStep()`
 * 决定是否进入下一 Step（当前只有 Tool Call 会要求继续，见该函数的 TODO）。
 *
 * 不做的事（属后续子阶段，见 TODOList 6.2–6.6）：压缩检查、Usage 记账、工具小轮、
 * Insert / Queue、Turn 收尾。因此本函数的边界是：
 *   - `turn/start + user/message` 由 SessionRuntime 在进入 Loop 前写入（第 13.1、13.2 节）；
 *   - `turn/end` 与 `app/error` 由调用方在 Loop 退出后写入（第 13.5 节）；
 *   - Loop 只写 Step 范围的事件，并把待执行的 tool_call 通过 `AgentLoopResult.toolCalls` 交出去。
 *
 * 三处文档未规定处的实现决定：
 *   1. Adapter 由调用方创建（`createModelAdapter(config, options)`）后注入。模型配置 → Adapter
 *      的映射留在 model 模块，AgentLoop 只依赖 `ModelAdapter`，不接触凭据与 Provider 配置。
 *   2. `blockId` 由 `(turn, step, index)` 决定而不随机生成：第 8.4 节只要求同一个块的
 *      Start / Delta / End 使用同一个 `blockId`，而 `index` 在同一 Step 内唯一；确定性 ID
 *      让 Block 修复（第 10.3 节）不需要额外维护映射。
 *   3. Turn 边界事件不在本函数内（见上）。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 6 节（模型协议层）、第 8.2 / 8.4 / 8.5 / 8.9 节、
 *          第 11.1 / 11.4 节（content 与请求构建）、第 13.3 节（AgentLoop 与 Step）、
 *          第 14 节（用户停止 Agent）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.1
 */

import { randomUUID } from "node:crypto"

import { isAbortError } from "../../error/src/abort.ts"
import type {
  AssistantContentBlock,
  ModelAdapter,
  ModelCompletion,
  ModelMessage,
  ModelRef,
  UnifiedModelRequest,
  UnifiedToolDefinition,
  Usage,
} from "../../model/src/types.ts"
import type { AppendSessionEvent } from "../../session/src/events.ts"

/**
 * 本 Turn 结束时仍未执行工具小轮的 tool_call 块。
 *
 * 工具小轮属后续子阶段（TODOList 6.4），AgentLoop 现在只把模型的调用意图交出去，
 * 不执行工具、不写 `tool/result`。
 */
export interface AgentLoopToolCall {
  turn: number
  step: number
  /** 该 tool_call 块的 `blockId`，与块事件的 blockId 一致（第 8.4 节）。 */
  blockId: string
  block: Extract<AssistantContentBlock, { type: "tool_call" }>
}

/** `runAgentLoop` 的结果。Turn 的终态由调用方据此写成 `turn/end`（第 13.5、14 节）。 */
export interface AgentLoopResult {
  /** 是否因用户取消而停止；此时最后一步的 `step/end` 为 `stopped`（第 14 节）。 */
  stopped: boolean
  /** 实际执行的 Step 数；Turn 内 Step 从 1 起（第 8.2 节）。 */
  steps: number
  /** 最后一个 Step 的统一完成状态（第 8.5 节）。 */
  completion?: ModelCompletion
  /** 最后一个 Step 的权威 Usage 与厂商结束原因（第 8.5 节）。 */
  usage?: Usage
  finishReason?: string
  /** 本 Turn 全部已结束的 tool_call 块，按 Step、index 顺序。 */
  toolCalls: AgentLoopToolCall[]
}

/** 运行一个 Turn 的 AgentLoop 所需输入。 */
export interface AgentLoopOptions {
  /** 本 Turn 编号，由 SessionRuntime 分配（第 8.2 节）。 */
  turn: number
  /** 本 Turn 固定的模型引用（第 11.4 节）；Adapter 会校验它与自身绑定的模型一致。 */
  model: ModelRef
  /** 由 `createModelAdapter(modelConfig, clientOptions)` 创建、对应当前模型的 Adapter（第 6 节）。 */
  adapter: ModelAdapter
  /**
   * ContextBuilder 在进入 Loop 前构建一次的 content（第 11.1 节）；
   * Loop 内直接原地维护，不重新构建（第 13.3 节）。
   */
  content: ModelMessage[]
  /** 当前 Tool Exposure State 构建的工具定义（第 11.4 节）；Loop 只透传，不解释。 */
  tools: UnifiedToolDefinition[]
  /** 当前 Agent Loop 的取消信号（第 14 节）；用户 Stop 后 Adapter 会以取消错误结束流。 */
  signal: AbortSignal
  /** 事件出口，由 SessionEventLog 提供。 */
  appendEvent: AppendSessionEvent
}

/**
 * 运行一个 Turn 的 Step 循环。
 *
 * 正常返回表示 Loop 自己结束（无待执行的 Tool Call，或被用户取消）；
 * Adapter 抛出非取消错误时，写完 `step/end(error)` 后原样抛出，`turn/end(error)` 与
 * `app/error` 由调用方负责（第 13.5 节）。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { turn, model, adapter, content, tools, signal, appendEvent } = options

  const result: AgentLoopResult = { stopped: false, steps: 0, toolCalls: [] }

  while (true) {
    const step = result.steps + 1
    result.steps = step

    await appendEvent({ type: "step/start", turn, step })

    let outcome: ModelStepOutcome
    try {
      outcome = await runModelStep({ turn, step, model, adapter, content, tools, signal, appendEvent })
    } catch (error) {
      // 已开始的 Step 必须有 step/end（第 8.9 节）。取消是正常路径（第 14 节），
      // 其余错误交给调用方终止 Turn。
      const stopped = signal.aborted || isAbortError(error)
      await appendEvent({ type: "step/end", turn, step, reason: stopped ? "stopped" : "error" })
      if (stopped) {
        result.stopped = true
        return result
      }
      throw error
    }

    result.completion = outcome.completion
    result.usage = outcome.usage
    result.finishReason = outcome.finishReason
    result.toolCalls.push(...outcome.toolCalls)

    await appendEvent({ type: "step/end", turn, step, reason: "completed" })

    if (!needsNextStep(outcome.completion)) break
  }

  return result
}

/** 一次正常模型请求的输入（第 11.4 节）。 */
interface ModelStepParams {
  turn: number
  step: number
  model: ModelRef
  adapter: ModelAdapter
  content: ModelMessage[]
  tools: UnifiedToolDefinition[]
  signal: AbortSignal
  appendEvent: AppendSessionEvent
}

/** 一次正常模型请求的结果。 */
interface ModelStepOutcome {
  completion: ModelCompletion
  usage?: Usage
  finishReason?: string
  toolCalls: AgentLoopToolCall[]
}

/**
 * 执行一次正常模型请求：消费 Adapter 的统一事件流，逐个写 Block 事件，
 * 最后写本 Step 的 `assistant/message`（第 8.4、8.5、11.4 节）。
 */
async function runModelStep(params: ModelStepParams): Promise<ModelStepOutcome> {
  const { turn, step, model, adapter, content, tools, signal, appendEvent } = params

  const request: UnifiedModelRequest = { context: { messages: content }, tools, model }
  /** 已结束的块，key 为统一流的 `index`；未结束的块不在这里，也不进 `assistant/message`。 */
  const endedBlocks = new Map<number, AssistantContentBlock>()

  // Adapter 契约保证所有 block_end 之后恰好产生一个 stream_end（见 model/src/types.ts），
  // 因此正常路径下 completion 一定会被覆盖；缺失时按第 8.5 节取 unknown。
  let completion: ModelCompletion = "unknown"
  let usage: Usage | undefined
  let finishReason: string | undefined

  for await (const event of adapter.stream(request, signal)) {
    switch (event.type) {
      case "block_start":
        await appendEvent({
          type: "assistant/block_start",
          turn,
          step,
          blockId: blockIdFor(turn, step, event.index),
          index: event.index,
          blockType: event.blockType,
        })
        break

      case "block_delta":
        await appendEvent({
          type: "assistant/block_delta",
          turn,
          step,
          blockId: blockIdFor(turn, step, event.index),
          delta: event.delta,
        })
        break

      case "block_end":
        endedBlocks.set(event.index, event.block)
        await appendEvent({
          type: "assistant/block_end",
          turn,
          step,
          blockId: blockIdFor(turn, step, event.index),
          index: event.index,
          block: event.block,
        })
        break

      case "stream_end":
        completion = event.completion
        usage = event.usage
        finishReason = event.finishReason
        break
    }
  }

  // 第 8.5 节：只收录已有 block_end 的块，并按 index 排序。
  const ordered = [...endedBlocks.entries()].sort(([a], [b]) => a - b)
  const blockList = ordered.map(([, block]) => block)

  await appendEvent({
    type: "assistant/message",
    turn,
    step,
    message: { id: randomUUID(), role: "assistant", content: blockList },
    model,
    ...(usage === undefined ? {} : { usage }),
    ...(finishReason === undefined ? {} : { finishReason }),
  })

  // 第 13.3 节：正常模型响应直接更新内存 content，不重新 Context Build。
  // 空内容的消息不追加：三个协议生成请求时都无法表达空 content 的 assistant 消息。
  if (blockList.length > 0) {
    content.push({ role: "assistant", content: blockList })
  }

  const toolCalls: AgentLoopToolCall[] = []
  for (const [index, block] of ordered) {
    if (block.type !== "tool_call") continue
    toolCalls.push({ turn, step, blockId: blockIdFor(turn, step, index), block })
  }

  return { completion, usage, finishReason, toolCalls }
}

/**
 * 本 Step 结束后是否进入下一 Step（第 13.3 节）。
 *
 * 只有本 Step 产生了待执行的完整 Tool Call 时才需要继续 —— 工具结果必须交还模型。
 * 工具小轮属后续子阶段（TODOList 6.4），因此当前一律返回 false：一个 Turn 只有一个 Step，
 * 待执行的 tool_call 通过 `AgentLoopResult.toolCalls` 交给调用方。
 */
function needsNextStep(_completion: ModelCompletion): boolean {
  return false
}

/**
 * 块的 ID 由 `(turn, step, index)` 决定，见文件头第 2 条决定。
 */
function blockIdFor(turn: number, step: number, index: number): string {
  return `b-${turn}-${step}-${index}`
}
