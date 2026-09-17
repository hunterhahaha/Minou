/**
 * AgentLoop：一个 Turn 内的 Step 循环（第 13.3 节）。
 *
 * 一次正常模型请求的数据流（TODOList 阶段 6.1）：
 *
 *   content（调用方构建一次）+ tools + 本 Turn 固定 ModelRef + AbortSignal
 *     → Adapter.stream()
 *     → ModelStreamEvent
 *     → Session 事件：step/start、assistant/block_start | block_delta | block_end、
 *       assistant/message、step/end
 *     → appendEvent（SessionEventLog 补 eventId / sessionId / seq / createdAt）
 *
 * Tool Call 小轮（阶段 6.4）：
 *
 *   本 Step 有已结束的 tool_call 块
 *     → 逐个调用注入的 `executeTool`（第 16.4 节的统一 execute）
 *     → 逐个写 tool/result（关联 block_end 的 eventId / toolCallId / blockId）
 *     → 工具结果追加到 content
 *     → 因为工具结果必须交还模型，本 Step 结束后一定进入下一 Step
 *
 * 工具本体与 ToolScheduler 的调度规则不在本阶段：`executeTool` 由调用方注入，
 * 当前按顺序逐个执行，见 `runToolRound`。
 *
 * 不做的事（属后续子阶段，见 TODOList 6.2、6.3、6.5、6.6）：压缩检查、Usage 记账、
 * Insert / Queue、Turn 收尾。因此本函数的边界是：
 *   - `turn/start + user/message` 由 SessionRuntime 在进入 Loop 前写入（第 13.1、13.2 节）；
 *   - `turn/end` 与 `app/error` 由调用方在 Loop 退出后写入（第 13.5 节）。
 *
 * 四处文档未规定处的实现决定：
 *   1. Adapter 由调用方创建（`createModelAdapter(config, options)`）后注入。模型配置 → Adapter
 *      的映射留在 model 模块，AgentLoop 只依赖 `ModelAdapter`，不接触凭据与 Provider 配置。
 *   2. `blockId` 由 `(turn, step, index)` 决定而不随机生成：第 8.4 节只要求同一个块的
 *      Start / Delta / End 使用同一个 `blockId`，而 `index` 在同一 Step 内唯一；确定性 ID
 *      让 Block 修复（第 10.3 节）不需要额外维护映射。
 *   3. 工具的执行入口由调用方注入（`ExecuteToolCall`），AgentLoop 只负责调用与事件关联。
 *      真正的 ToolExecutor / ToolScheduler 在 runtime/tools/ 下尚未实现。
 *   4. Turn 边界事件不在本函数内（见上）。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 6 节（模型协议层）、第 8.2 / 8.4 / 8.5 / 8.6 / 8.9 节、
 *          第 11.1 / 11.4 节（content 与请求构建）、第 13.3 节（AgentLoop 与 Step）、
 *          第 14 节（用户停止 Agent）、第 16.4 / 16.5 节（统一 execute 与事件关联）
 * 实施阶段：.git/技术文档/开发TODOList.md 阶段 6.1、6.4
 */

import { randomUUID } from "node:crypto"

import { isAbortError } from "../../error/src/abort.ts"
import type {
  AssistantContentBlock,
  ModelAdapter,
  ModelCompletion,
  ModelMessage,
  ModelRef,
  ModelTextBlock,
  UnifiedModelRequest,
  UnifiedToolDefinition,
  Usage,
} from "../../model/src/types.ts"
import type { AppendSessionEvent } from "../../session/src/events.ts"
import type { ToolResult } from "../../tools/src/types.ts"

/**
 * 本 Step 已结束的 tool_call 块及其事件身份。
 *
 * 工具小轮要用它把 `tool/result` 关联回原调用（第 8.6、16.5 节）。
 */
export interface AgentLoopToolCall {
  turn: number
  step: number
  /** 该 tool_call 块的 `blockId`，与块事件一致（第 8.4 节）。 */
  blockId: string
  /** 该 tool_call 块的 `assistant/block_end` 事件 ID，写 `tool/result` 时作为 `toolCallEventId`。 */
  toolCallEventId: string
  block: Extract<AssistantContentBlock, { type: "tool_call" }>
}

/** 一次工具调用的 Runtime 上下文（第 16.4 节 `ToolExecutionContext` 在 AgentLoop 侧的最小形态）。 */
export interface ToolCallContext {
  turn: number
  step: number
  blockId: string
  toolCallId: string
  /** 本 Agent Loop 的取消信号：已开始的工具应据此尝试取消（第 14、17 节）。 */
  signal: AbortSignal
}

/**
 * 执行一次工具调用的边界（第 16.4 节「统一 execute」在 AgentLoop 侧的形态）。
 *
 * 真正的 ToolExecutor / ToolScheduler 尚未实现（见 runtime/tools/src/index.ts），
 * 本阶段只约定「工具名 + 参数 + 调用身份 → 统一 ToolResult」。
 *
 * 工具自身的失败（含被取消）也必须以 `status = "error"` 的 ToolResult 返回，不能用抛异常表达 ——
 * 第 16.4 节要求调度器中尚未启动便被取消的调用同样产出 `AppError(CANCELLED)` 并形成 ToolResult；
 * 从本函数抛出的异常会被当作 Turn 级失败处理。
 */
export type ExecuteToolCall = (
  toolName: string,
  toolArguments: unknown,
  context: ToolCallContext,
) => Promise<ToolResult>

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
  /** 工具执行入口；模型产生 Tool Call 时由 Loop 调用（第 16.4 节）。 */
  executeTool: ExecuteToolCall
  /** 当前 Agent Loop 的取消信号（第 14 节）；用户 Stop 后 Adapter 会以取消错误结束流。 */
  signal: AbortSignal
  /** 事件出口，由 SessionEventLog 提供。 */
  appendEvent: AppendSessionEvent
}

/**
 * 运行一个 Turn 的 Step 循环。
 *
 * 正常返回表示 Loop 自己结束（无待执行的 Tool Call，或被用户取消）；
 * Adapter 或工具执行抛出非取消错误时，写完 `step/end(error)` 后原样抛出，`turn/end(error)` 与
 * `app/error` 由调用方负责（第 13.5 节）。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { turn, model, adapter, content, tools, executeTool, signal, appendEvent } = options

  const result: AgentLoopResult = { stopped: false, steps: 0 }

  while (true) {
    const step = result.steps + 1
    result.steps = step

    await appendEvent({ type: "step/start", turn, step })

    let outcome: ModelStepOutcome
    try {
      outcome = await runModelStep({ turn, step, model, adapter, content, tools, signal, appendEvent })

      // 第 13.3 节「有 Tool Call」：工具小轮完成后才写 step/end，
      // 且因为工具结果必须交还模型，本 Step 一定会进入下一轮。
      if (outcome.toolCalls.length > 0) {
        await runToolRound({ turn, step, toolCalls: outcome.toolCalls, executeTool, content, signal, appendEvent })
      }
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

    // 用户在工具小轮期间停止：Step 以 stopped 关闭，不进入下一轮（第 14 节）。
    // 尚未启动的调用由 executeTool 自己按取消信号产出 CANCELLED 结果，Loop 不再发起新的模型请求。
    if (signal.aborted) {
      await appendEvent({ type: "step/end", turn, step, reason: "stopped" })
      result.stopped = true
      return result
    }

    await appendEvent({ type: "step/end", turn, step, reason: "completed" })

    // 没有待执行的 Tool Call 时 Loop 结束；有 Tool Call 时上面已完成小轮，进入下一 Step。
    if (outcome.toolCalls.length === 0) break
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
  /**
   * 已结束的块，key 为统一流的 `index`；未结束的块不在这里，也不进 `assistant/message`。
   * 连同 `block_end` 事件的 eventId 一起记录：工具小轮要用它关联 `tool/result`（第 8.6 节）。
   */
  const endedBlocks = new Map<number, { block: AssistantContentBlock; eventId: string }>()

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

      case "block_end": {
        const persisted = await appendEvent({
          type: "assistant/block_end",
          turn,
          step,
          blockId: blockIdFor(turn, step, event.index),
          index: event.index,
          block: event.block,
        })
        endedBlocks.set(event.index, { block: event.block, eventId: persisted.eventId })
        break
      }

      case "stream_end":
        completion = event.completion
        usage = event.usage
        finishReason = event.finishReason
        break
    }
  }

  // 第 8.5 节：只收录已有 block_end 的块，并按 index 排序。
  const ordered = [...endedBlocks.entries()].sort(([a], [b]) => a - b)
  const blockList = ordered.map(([, ended]) => ended.block)

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

  // 只有已结束的完整 tool_call 才是待执行的调用（第 8.5 节）。
  const toolCalls: AgentLoopToolCall[] = []
  for (const [index, ended] of ordered) {
    if (ended.block.type !== "tool_call") continue
    toolCalls.push({
      turn,
      step,
      blockId: blockIdFor(turn, step, index),
      toolCallEventId: ended.eventId,
      block: ended.block,
    })
  }

  return { completion, usage, finishReason, toolCalls }
}

/** 一次 Tool Call 小轮的输入。 */
interface ToolRoundParams {
  turn: number
  step: number
  toolCalls: AgentLoopToolCall[]
  executeTool: ExecuteToolCall
  content: ModelMessage[]
  signal: AbortSignal
  appendEvent: AppendSessionEvent
}

/**
 * 执行本 Step 产生的全部 Tool Call：执行 → 写 `tool/result` → 把工具结果追加到 content。
 *
 * 每个调用单独写事件、单独追加内容，不等待整个小轮结束（第 16.5 节）。
 * 工具失败不在这里加工：ToolExecutor 已把失败渲染成 `status = "error"` 的 ToolResult，
 * 因此不为同一次失败额外写 `app/error`（第 8.6 节）。
 *
 * 当前按顺序逐个执行。第 17 节的 ToolScheduler（共享只读并发、独占串行、审批屏障）尚未实现，
 * 将来由它接管调度与本函数的调用点。
 */
async function runToolRound(params: ToolRoundParams): Promise<void> {
  const { turn, step, toolCalls, executeTool, content, signal, appendEvent } = params

  for (const toolCall of toolCalls) {
    const { block, blockId, toolCallEventId } = toolCall

    const result = await executeTool(block.name, block.arguments, {
      turn,
      step,
      blockId,
      toolCallId: block.toolCallId,
      signal,
    })

    // 关联原调用身份（第 8.6、16.5 节）：日志身份由 Agent Loop 写入事件。
    await appendEvent({
      type: "tool/result",
      turn,
      step,
      toolCallEventId,
      toolCallId: block.toolCallId,
      blockId,
      result,
    })

    content.push(toToolMessage(block.toolCallId, result))
  }
}

/**
 * 统一 ToolResult → 回放与后续请求使用的 tool 消息（第 11.3、16.2 节）。
 *
 * 三个协议当前只消费 `type = "text"` 的内容：这里保留 text 块及其顺序，其余类型不进入模型上下文。
 * `isError` 取 ToolResult 的 `status`（第 16.2 节）。
 */
function toToolMessage(toolCallId: string, result: ToolResult): ModelMessage {
  const content: ModelTextBlock[] = []
  for (const block of result.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
  }
  return { role: "tool", toolCallId, content, isError: result.status === "error" }
}

/**
 * 块的 ID 由 `(turn, step, index)` 决定，见文件头第 2 条决定。
 */
function blockIdFor(turn: number, step: number, index: number): string {
  return `b-${turn}-${step}-${index}`
}
