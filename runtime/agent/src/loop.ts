/**
 * 一个 Turn 内的 Step 循环、模型流转事件与工具结果回填。
 *
 * 宿主注入本 Turn 固定的模型、Adapter、初始上下文、工具执行入口和事件出口。
 * 每个 Step 可先通过 beforeStep 检查并压缩上下文，再消费 Adapter 的统一事件流，
 * 写入块事件和完整 assistant/message。已结束的工具调用交给 runToolCalls 调度，
 * 每个结果完成后立即写 tool/result 并追加工具消息，然后进入下一 Step。
 *
 * 块身份由 Turn、Step 和响应索引确定，工具结果同时携带原调用的块身份与事件身份。
 * 取消时保留已提交的文本增量和完整工具调用，关闭已创建的 Step；
 * 非取消错误在 Step 收尾后传播给宿主，持久化失败也不在 Loop 内重试。
 *
 * Turn 首批事件、Turn 收尾、审批与 Usage 派生状态由宿主负责。
 * Loop 仅依赖注入的 Adapter 和工具执行入口，不读取 Provider 凭据或装配工具注册表。
 */

import { randomUUID } from "node:crypto"

import { createAbortError, isAbortError } from "../../error/src/abort.ts"
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
import { runToolCalls } from "../../tools/src/tool-scheduler.ts"
import type {
  ExecuteToolCall as ToolRuntimeExecuteToolCall,
  ToolCallContext as ToolRuntimeCallContext,
  ToolResult,
} from "../../tools/src/types.ts"

/**
 * 本 Step 已结束的 tool_call 块及其事件身份。
 *
 * 工具小轮要用它把 `tool/result` 关联回原调用。
 */
export interface AgentLoopToolCall {
  /** 产生此工具调用的 Turn 编号。 */
  turn: number
  /** 产生此工具调用的 Step 编号。 */
  step: number
  /** 该 tool_call 块的 `blockId`，与块事件一致。 */
  blockId: string
  /** 该 tool_call 块的 `assistant/block_end` 事件 ID，写 `tool/result` 时作为 `toolCallEventId`。 */
  toolCallEventId: string
  /** 模型已完整返回的工具名称、参数与调用 ID。 */
  block: Extract<AssistantContentBlock, { type: "tool_call" }>
}

/** tools 模块定义的 Turn、Step、Block、工具调用身份与取消信号。 */
export type ToolCallContext = ToolRuntimeCallContext

/**
 * 执行一次工具调用的统一入口。
 *
 * 具体实现由 `createExecuteToolCall` 基于 ToolRegistry / RenderRegistry 创建，AgentLoop 仍只依赖
 * 「工具名 + 参数 + 调用身份 → 统一 ToolResult」这一边界。
 *
 * 工具自身的失败（含被取消）也必须以 `status = "error"` 的 ToolResult 返回，不能用抛异常表达 ——
 * 尚未启动便被取消的调用同样应产出 `AppError(CANCELLED)` 并形成 ToolResult；
 * 从本函数抛出的异常会被当作 Turn 级失败处理。
 *
 * @param toolName 模型请求执行的工具名称。
 * @param toolArguments 模型为工具提供的、尚未由 AgentLoop 解释的参数值。
 * @param context 当前 Turn、Step、Block 和取消信号等执行上下文。
 * @returns 工具执行结果；工具自身失败也应通过 `status = "error"` 返回。
 * @throws 工具执行入口发生 Turn 级异常时抛出；工具业务失败不应使用异常表示。
 */
export type ExecuteToolCall = ToolRuntimeExecuteToolCall

/** `runAgentLoop` 的结果。Turn 的终态由调用方据此写成 `turn/end`。 */
export interface AgentLoopResult {
  /** 是否因用户取消而停止；已创建的最后一步以 stopped 收尾，Step 前取消不产生 Step 事件。 */
  stopped: boolean
  /** 实际执行的 Step 数；Turn 内 Step 从 1 起。 */
  steps: number
  /** 最后一个 Step 的统一完成状态。 */
  completion?: ModelCompletion
  /** 最后一个 Step 的权威 Usage；未报告时省略。 */
  usage?: Usage
  /** 最后一个 Step 的协议结束原因；未报告时省略。 */
  finishReason?: string
}

/** 运行一个 Turn 的 AgentLoop 所需输入。 */
export interface AgentLoopOptions {
  /** 本 Turn 编号，由 SessionRuntime 分配。 */
  turn: number
  /** 本 Turn 固定的模型引用；Adapter 会校验它与自身绑定的模型一致。 */
  model: ModelRef
  /** 由 `createModelAdapter(modelConfig, clientOptions)` 创建、对应当前模型的 Adapter。 */
  adapter: ModelAdapter
  /**
   * 宿主提供的初始模型上下文；Loop 原地追加 Assistant 和工具消息。
   * beforeStep 可在压缩成功后原地替换内容，后续请求使用更新后的同一数组。
   */
  content: ModelMessage[]
  /** 当前工具快照，或每次模型请求前解析 Session Tool Exposure State 的提供函数；Loop 不解释工具内容。 */
  tools: UnifiedToolDefinition[] | (() => Promise<UnifiedToolDefinition[]>)
  /** 工具执行入口；模型产生 Tool Call 时由 Loop 调用。 */
  executeTool: ExecuteToolCall
  /** 当前 Agent Loop 的取消信号；用户 Stop 后 Adapter 会以取消错误结束流。 */
  signal: AbortSignal
  /** 事件出口，由 SessionEventLog 提供。 */
  appendEvent: AppendSessionEvent
  /**
   * Step 创建前的异步检查；可原地替换 content，不得创建 Step 或执行工具。
   * @param input 即将执行的 Step、当前完整消息与本次实际工具快照。
   * @returns 检查及必要压缩提交完成后解析。
   * @throws Error 检查失败时终止 Turn；取消时 Loop 返回 stopped，不补写 Step 事件。
   */
  beforeStep?(input: { step: number; content: ModelMessage[]; tools: UnifiedToolDefinition[] }): Promise<void>
}

/**
 * 运行一个 Turn 的 Step 循环。
 *
 * 正常返回表示 Loop 自己结束（无待执行的 Tool Call，或被用户取消）；
 * Step 开始前检查失败直接抛出；Adapter 或工具执行抛出非取消错误时，写完 `step/end(error)` 后原样抛出，`turn/end(error)` 与
 * `app/error` 由调用方负责。
 *
 * @param options AgentLoop 的模型、上下文、工具执行入口、取消信号和事件出口。
 * @returns 本 Turn 的停止状态、Step 数量以及最后一次模型请求的完成信息。
 * @throws 非取消的检查、模型或工具错误；仅已创建的 Step 会补写 `step/end(error)`。
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { turn, model, adapter, content, tools, executeTool, signal, appendEvent } = options

  const result: AgentLoopResult = { stopped: false, steps: 0 }

  while (true) {
    const step = result.steps + 1
    let currentTools: UnifiedToolDefinition[] | undefined
    if (options.beforeStep !== undefined) {
      try {
        currentTools = typeof tools === "function" ? await tools() : tools
        await options.beforeStep({ step, content, tools: currentTools })
        if (signal.aborted) throw createAbortError()
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          result.stopped = true
          return result
        }
        throw error
      }
    }
    result.steps = step

    await appendEvent({ type: "step/start", turn, step })

    let outcome: ModelStepOutcome
    try {
      currentTools ??= typeof tools === "function" ? await tools() : tools
      outcome = await runModelStep({ turn, step, model, adapter, content, tools: currentTools, executeTool, signal, appendEvent })

      /**
       * 工具小轮完成后才写 step/end，
       * 且因为工具结果必须交还模型，本 Step 一定会进入下一轮。
       */
      if (outcome.toolCalls.length > 0) {
        await runToolRound({ turn, step, toolCalls: outcome.toolCalls, executeTool, content, signal, appendEvent })
      }
    } catch (error) {
      /**
       * 已开始的 Step 必须有 step/end。取消是正常路径，
       * 其余错误交给调用方终止 Turn。
       */
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

    /**
     * 用户在工具小轮期间停止：Step 以 stopped 关闭，不进入下一轮。
     * 尚未启动的调用由 executeTool 自己按取消信号产出 CANCELLED 结果，Loop 不再发起新的模型请求。
     */
    if (signal.aborted) {
      await appendEvent({ type: "step/end", turn, step, reason: "stopped" })
      result.stopped = true
      return result
    }

    await appendEvent({ type: "step/end", turn, step, reason: "completed" })

    /**
     * 没有待执行的 Tool Call 时 Loop 结束；有 Tool Call 时上面已完成小轮，进入下一 Step。
     */
    if (outcome.toolCalls.length === 0) break
  }

  return result
}

/** 一次正常模型请求的输入。 */
interface ModelStepParams {
  /** 当前 Turn 编号。 */
  turn: number
  /** 当前 Step 编号。 */
  step: number
  /** 本 Turn 固定的模型引用。 */
  model: ModelRef
  /** 负责发起统一模型流请求的 Adapter。 */
  adapter: ModelAdapter
  /** 当前请求使用并由后续 Step 原地追加的会话上下文。 */
  content: ModelMessage[]
  /** 当前请求向模型暴露的工具定义。 */
  tools: UnifiedToolDefinition[]
  /** 已结束的工具调用在模型流取消时通过此入口形成取消结果。 */
  executeTool: ExecuteToolCall
  /** 当前 AgentLoop 的取消信号。 */
  signal: AbortSignal
  /** 将模型流事件写入 Session Event Log 的事件出口。 */
  appendEvent: AppendSessionEvent
}

/** 一次正常模型请求的结果。 */
interface ModelStepOutcome {
  /** 模型本次请求的统一完成状态。 */
  completion: ModelCompletion
  /** 模型返回的 Usage；模型未提供时省略。 */
  usage?: Usage
  /** 模型协议返回的结束原因；未提供时省略。 */
  finishReason?: string
  /** 本次响应中已完成且需要执行的工具调用。 */
  toolCalls: AgentLoopToolCall[]
}

/**
 * 执行一次正常模型请求：消费 Adapter 的统一事件流，逐个写 Block 事件，
 * 最后写本 Step 的 `assistant/message`。
 * 模型流取消时先按已提交 Delta 收尾文本/思考块、消息及已结束工具调用，再传播取消错误，
 * 使调用方能在这些事件之后关闭 Step。未结束的工具调用不补猜参数。
 *
 * @param params 当前 Step 的模型请求参数和事件出口。
 * @returns 模型完成状态、Usage、结束原因以及已完成的工具调用。
 * @throws Adapter 流或事件持久化失败时向调用方传播原始错误。
 */
async function runModelStep(params: ModelStepParams): Promise<ModelStepOutcome> {
  const { turn, step, model, adapter, content, tools, executeTool, signal, appendEvent } = params

  const request: UnifiedModelRequest = { context: { messages: content }, tools, model }
  /**
   * 已结束的块，key 为统一流的 `index`；未结束的块不在这里，也不进 `assistant/message`。
   * 连同 `block_end` 事件的 eventId 一起记录：工具小轮要用它关联 `tool/result`。
   */
  const endedBlocks = new Map<number, { block: AssistantContentBlock; eventId: string }>()
  /** 只累计已成功提交的文本 Delta；收到 BlockEnd 后移出，避免停止时重复收尾。 */
  const openTextBlocks = new Map<number, Extract<AssistantContentBlock, { type: "text" | "thinking" }>>()
  /** 事件处理失败不属于模型流取消，不能以收尾重试掩盖持久化失败。 */
  let handlingEvent = false

  /**
   * Adapter 在块结束后提供 stream_end；未收到完成状态时保留 unknown。
   */
  let completion: ModelCompletion = "unknown"
  let usage: Usage | undefined
  let finishReason: string | undefined

  try {
    for await (const event of adapter.stream(request, signal)) {
      handlingEvent = true
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
          if (event.blockType === "text" || event.blockType === "thinking") {
            openTextBlocks.set(event.index, { type: event.blockType, text: "" })
          }
          break

        case "block_delta":
          await appendEvent({
            type: "assistant/block_delta",
            turn,
            step,
            blockId: blockIdFor(turn, step, event.index),
            delta: event.delta,
          })
          if (event.delta.type !== "tool_call") {
            const block = openTextBlocks.get(event.index)
            if (block?.type === event.delta.type) block.text += event.delta.text
          }
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
          openTextBlocks.delete(event.index)
          break
        }

        case "stream_end":
          completion = event.completion
          usage = event.usage
          finishReason = event.finishReason
          break
      }
      handlingEvent = false
    }
    if (signal.aborted) throw createAbortError()
  } catch (error) {
    if (handlingEvent || !(signal.aborted || isAbortError(error))) throw error

    for (const [index, block] of openTextBlocks) {
      const persisted = await appendEvent({
        type: "assistant/block_end",
        turn,
        step,
        blockId: blockIdFor(turn, step, index),
        index,
        block,
      })
      endedBlocks.set(index, { block, eventId: persisted.eventId })
    }
    const ordered = [...endedBlocks.entries()].sort(([left], [right]) => left - right)
    if (ordered.length > 0) {
      await appendEvent({
        type: "assistant/message",
        turn,
        step,
        message: { id: randomUUID(), role: "assistant", content: ordered.map(([, ended]) => ended.block) },
        model,
        ...(usage === undefined ? {} : { usage }),
        ...(finishReason === undefined ? {} : { finishReason }),
      })
    }
    const toolCalls: AgentLoopToolCall[] = []
    for (const [index, ended] of ordered) {
      if (ended.block.type !== "tool_call") continue
      toolCalls.push({
        turn, step, blockId: blockIdFor(turn, step, index), toolCallEventId: ended.eventId, block: ended.block,
      })
    }
    if (toolCalls.length > 0) {
      await runToolRound({
        turn, step, toolCalls, executeTool, content,
        signal: signal.aborted ? signal : AbortSignal.abort(), appendEvent,
      })
    }
    throw error
  }

  /**
   * 只收录已有 block_end 的块，并按 index 排序。
   */
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

  /**
   * 正常模型响应直接追加到内存上下文，供下一 Step 使用。
   * 空内容的消息不追加：三个协议生成请求时都无法表达空 content 的 assistant 消息。
   */
  if (blockList.length > 0) {
    content.push({ role: "assistant", content: blockList })
  }

  /**
   * 只有已结束的完整 tool_call 才是待执行的调用。
   */
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
  /** 当前 Turn 编号。 */
  turn: number
  /** 产生这些工具调用的 Step 编号。 */
  step: number
  /** 当前 Step 中按模型响应顺序收集的已完成工具调用。 */
  toolCalls: AgentLoopToolCall[]
  /** 统一的工具执行入口。 */
  executeTool: ExecuteToolCall
  /** 将工具结果追加到的会话上下文。 */
  content: ModelMessage[]
  /** 当前 AgentLoop 的取消信号。 */
  signal: AbortSignal
  /** 将工具结果写入 Session Event Log 的事件出口。 */
  appendEvent: AppendSessionEvent
}

/**
 * 执行本 Step 产生的全部 Tool Call：整批交给调度器，再按**完成顺序**逐个写 `tool/result`
 * 与工具结果消息。
 *
 * 工具按完成顺序落盘，不等待整批或 Turn 结束。结果通过 toolCallId、toolCallEventId
 * 和 blockId 关联原调用，并发完成顺序不影响配对。
 *
 * ToolExecutor 用 status = "error" 的 ToolResult 表达工具业务失败，
 * 本函数直接记录该结果，不为同一次失败额外写 app/error。
 *
 * @param params 当前 Step 的工具调用、执行入口、上下文和事件出口。
 * @returns 所有工具调用结果均已写入事件日志并追加到模型上下文后完成。
 * @throws 调度器、工具执行入口或事件持久化发生 Turn 级异常时传播该异常。
 */
async function runToolRound(params: ToolRoundParams): Promise<void> {
  const { turn, step, toolCalls, executeTool, content, signal, appendEvent } = params

  /**
   * 工具名决定调度分组，所以交给调度器的每一项都带上它；
   * 调用身份（turn / step / blockId / toolCallId）留在本文件里，通过闭包喂给执行入口。
   */
  const stream = runToolCalls(
    toolCalls.map((call) => ({ toolName: call.block.name, call })),
    ({ call }) =>
      executeTool(call.block.name, call.block.arguments, {
        turn,
        step,
        blockId: call.blockId,
        toolCallId: call.block.toolCallId,
        toolCallEventId: call.toolCallEventId,
        signal,
      }),
  )

  for await (const { call: scheduled, result } of stream) {
    const call = scheduled.call

    /**
     * 关联原调用身份：日志身份由 Agent Loop 写入事件。
     */
    await appendEvent({
      type: "tool/result",
      turn,
      step,
      toolCallEventId: call.toolCallEventId,
      toolCallId: call.block.toolCallId,
      blockId: call.blockId,
      result,
    })

    content.push(toToolMessage(call.block.toolCallId, result))
  }
}

/**
 * 统一 ToolResult → 回放与后续请求使用的 tool 消息。
 *
 * 三个协议当前只消费 `type = "text"` 的内容：这里保留 text 块及其顺序，其余类型不进入模型上下文。
 * `isError` 取 ToolResult 的 `status`。
 *
 * @param toolCallId 模型生成的工具调用 ID，用于建立工具消息关联。
 * @param result 要转换为模型消息的统一工具结果。
 * @returns 可追加到 ModelMessage 上下文的工具消息。
 */
function toToolMessage(toolCallId: string, result: ToolResult): ModelMessage {
  const content: ModelTextBlock[] = []
  for (const block of result.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text })
  }
  return { role: "tool", toolCallId, content, isError: result.status === "error" }
}

/**
 * 由 Turn、Step 和响应块索引生成块 ID，同一块的各类事件复用该 ID。
 *
 * @param turn 块所属的 Turn 编号。
 * @param step 块所属的 Step 编号。
 * @param index 块在当前模型响应中的零基索引。
 * @returns 可在同一 Block 的 start、delta、end 事件中复用的稳定 ID。
 */
function blockIdFor(turn: number, step: number, index: number): string {
  return `b-${turn}-${step}-${index}`
}
