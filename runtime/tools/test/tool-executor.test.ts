/**
 * 统一工具调用入口的离线测试。
 *
 * 使用登记的假 read 工具覆盖查表、参数检查、取消、异常归一化和结果整理回退。运行：
 *   node --experimental-strip-types runtime/tools/test/tool-executor.test.ts
 */

import assert from "node:assert/strict"

import { createAbortError } from "../../error/src/abort.ts"
import type { AppError } from "../../error/src/types.ts"
import {
  createExecuteToolCall,
  INVALID_TOOL_ARGUMENTS,
  TOOL_EXECUTION_FAILED,
  TOOL_NOT_FOUND,
  TOOL_RENDER_FAILED,
  TOOL_RENDER_NOT_FOUND,
  TOOL_VALIDATION_FAILED,
} from "../src/tool-executor.ts"
import {
  isPlainRecord,
  registerTool,
  RenderRegistry,
  ToolRegistry,
  type ToolArgumentValidation,
  type ToolRegistration,
} from "../src/tool-registry.ts"
import type {
  ExecuteToolCall,
  ToolCallContext,
  ToolExecutionContext,
  ToolResult,
} from "../src/types.ts"

/**
 * 假 read 工具接受的业务参数。
 */
interface ReadArguments {
  /** 假 read 工具用于观察数据流的路径参数。 */
  path: string
}

/**
 * 假 read 工具返回的原始文本输出。
 */
interface ReadOutput {
  /** 纯文本内容。 */
  text: string
}

/**
 * 收集校验、执行和结果整理各阶段输入的可变测试观察状态。
 */
interface HarnessState {
  /** 按调用顺序记录的参数检查输入。 */
  validationInputs: unknown[]
  /** 业务执行收到的参数与上下文。 */
  executions: {
    input: ReadArguments
    context: ToolExecutionContext<ReadArguments>
  }[]
  /** 结果整理器收到的业务结果或错误。 */
  renderInputs: (ReadOutput | AppError)[]
}

/**
 * 覆盖假 read 工具各阶段实现的故障注入入口。
 */
interface RegistrationOverrides {
  validateArguments?(input: unknown): ToolArgumentValidation<ReadArguments>
  execute?(
    input: ReadArguments,
    context: ToolExecutionContext<ReadArguments>,
  ): Promise<ReadOutput | AppError>
  /**
   * 将业务结果格式化为文本，统一错误交给公共错误整理器。
   * @param result 业务输出、统一错误或已整理的工具结果。
   * @returns 当前场景全部断言及异步操作完成后解析。
   */
  render?(result: ReadOutput | AppError): ToolResult
}

/**
 * 创建可观察每个阶段输入的假 read 工具。
 * @param state 记录参数校验、执行及整理器输入的可变观察状态。
 * @param overrides 用于注入校验、执行或整理异常的可选实现。
 * @returns 携带观察记录及可选覆盖实现的假 read 工具登记。
 */
function createReadRegistration(
  state: HarnessState,
  overrides: RegistrationOverrides = {},
): ToolRegistration<ReadArguments, ReadOutput> {
  return {
    kind: "builtin",
    definition: {
      name: "read",
      description: "fake read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    validateArguments: (input) => {
      state.validationInputs.push(input)
      if (overrides.validateArguments !== undefined) {
        return overrides.validateArguments(input)
      }
      if (!isPlainRecord(input) || typeof input.path !== "string") {
        return {
          success: false,
          error: { source: "tool", code: "BAD_ARGUMENTS", message: "path 必须是字符串" },
        }
      }
      return { success: true, data: { path: input.path } }
    },
    execute: async (input, context) => {
      state.executions.push({ input, context })
      if (overrides.execute !== undefined) return overrides.execute(input, context)
      return { text: `content:${input.path}` }
    },
    render: (result) => {
      state.renderInputs.push(result)
      if (overrides.render !== undefined) return overrides.render(result)
      return renderRead(result)
    },
  }
}

/**
 * 创建空的观察状态。
 * @returns 全新且互不共享数组的观察状态。
 */
function createState(): HarnessState {
  return { validationInputs: [], executions: [], renderInputs: [] }
}

/**
 * 创建完成成对登记的假执行入口。
 * @param overrides 用于注入校验、执行或整理异常的可选实现。
 * @returns 已成对登记的假执行入口与观察状态。
 */
function createHarness(overrides: RegistrationOverrides = {}): {
  state: HarnessState
  executeTool: ExecuteToolCall
} {
  const state = createState()
  const tools = new ToolRegistry()
  const renders = new RenderRegistry()
  registerTool(tools, renders, createReadRegistration(state, overrides))
  return { state, executeTool: createExecuteToolCall(tools, renders) }
}

/**
 * 假 read 工具的专属结果整理器。
 * @param result 业务输出、统一错误或已整理的工具结果。
 * @returns 成功文本或公共错误形状的 ToolResult。
 */
function renderRead(result: ReadOutput | AppError): ToolResult {
  if (isAppError(result)) {
    return {
      status: "error",
      content: [{ type: "text", text: `${result.code}: ${result.message}` }],
      error: result,
    }
  }
  return { status: "success", content: [{ type: "text", text: result.text }] }
}

/**
 * 判断假 read 的联合结果是否为 AppError。
 * @param value 待检查的结果值。
 * @returns 值是否带有 source、code 和 message 字段。
 */
function isAppError(value: ReadOutput | AppError): value is AppError {
  return "source" in value && "code" in value && "message" in value
}

/**
 * 创建带固定身份和指定信号的调用上下文。
 * @param signal 要写入调用上下文的取消信号。
 * @returns 带固定 Turn、Step、块及调用 ID 的上下文。
 */
function context(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return {
    turn: 3,
    step: 2,
    blockId: "b-3-2-1",
    toolCallId: "call-7",
    signal,
  }
}

/**
 * 读取错误 ToolResult 的错误码。
 * @param result 业务输出、统一错误或已整理的工具结果。
 * @returns 错误分支的错误码；成功分支返回 undefined。
 */
function errorCode(result: ToolResult): string | undefined {
  return result.status === "error" ? result.error.code : undefined
}

/**
 * 读取 ToolResult 的第一个文本块。
 * @param result 业务输出、统一错误或已整理的工具结果。
 * @returns 首个文本块内容；没有文本块时返回空字符串。
 */
function resultText(result: ToolResult): string {
  const first = result.content[0]
  return first?.type === "text" ? first.text : ""
}

/**
 * 验证成功调用保留业务参数、执行上下文与完整审批参数。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testSuccessfulExecutionAndContext(): Promise<void> {
  const { state, executeTool } = createHarness()
  const callContext = context()
  const result = await executeTool("read", {
    path: "/workspace/a.ts",
  }, callContext)

  assert.deepEqual(result, {
    status: "success",
    content: [{ type: "text", text: "content:/workspace/a.ts" }],
  })
  assert.deepEqual(state.validationInputs, [{ path: "/workspace/a.ts" }])
  assert.equal(state.executions.length, 1)
  assert.deepEqual(state.executions[0].input, { path: "/workspace/a.ts" })
  assert.deepEqual(state.executions[0].context.validatedArguments, {
    path: "/workspace/a.ts",
  })
  assert.equal(state.executions[0].context.turn, callContext.turn)
  assert.equal(state.executions[0].context.step, callContext.step)
  assert.equal(state.executions[0].context.blockId, callContext.blockId)
  assert.equal(state.executions[0].context.toolCallId, callContext.toolCallId)
  assert.equal(state.executions[0].context.signal, callContext.signal)
}

/**
 * 验证参数外壳和业务字段错误先于执行被拒绝，并交给专属整理器。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testEnvelopeAndToolValidationFailures(): Promise<void> {
  const { state, executeTool } = createHarness()

  const arrayResult = await executeTool("read", [], context())
  assert.equal(errorCode(arrayResult), INVALID_TOOL_ARGUMENTS)
  assert.equal(state.validationInputs.length, 0)
  assert.equal(state.executions.length, 0)

  const toolResult = await executeTool("read", { path: 7 }, context())
  assert.equal(errorCode(toolResult), "BAD_ARGUMENTS")
  assert.equal(state.validationInputs.length, 1)
  assert.equal(state.executions.length, 0)
}

/**
 * 验证业务返回的 AppError 经过工具专属结果整理器。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testBusinessAppErrorUsesToolRender(): Promise<void> {
  const businessError: AppError = {
    source: "tool",
    code: "PATH_NOT_FOUND",
    message: "文件不存在",
  }
  const { state, executeTool } = createHarness({
    execute: async () => businessError,
  })

  const result = await executeTool("read", { path: "/missing" }, context())
  assert.equal(errorCode(result), "PATH_NOT_FOUND")
  assert.equal(resultText(result), "PATH_NOT_FOUND: 文件不存在")
  assert.equal(state.renderInputs[0], businessError)
}

/**
 * 验证未知工具与缺失整理器使用公共错误结果。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testRegistryFailuresUseCommonRender(): Promise<void> {
  const emptyTools = new ToolRegistry()
  const emptyRenders = new RenderRegistry()
  const executeEmpty = createExecuteToolCall(emptyTools, emptyRenders)

  const missingTool = await executeEmpty("read", { path: "/a" }, context())
  assert.equal(errorCode(missingTool), TOOL_NOT_FOUND)
  assert.equal(resultText(missingTool), "TOOL_NOT_FOUND: 未找到可用工具：read")

  const state = createState()
  emptyTools.register(createReadRegistration(state))
  const missingRender = await executeEmpty("read", { path: "/a" }, context())
  assert.equal(errorCode(missingRender), TOOL_RENDER_NOT_FOUND)
  assert.equal(state.validationInputs.length, 0)
  assert.equal(state.executions.length, 0)
}

/**
 * 验证参数检查器和业务函数抛错时的归一化结果。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testThrownValidationAndExecutionErrors(): Promise<void> {
  const validationHarness = createHarness({
    validateArguments: () => { throw new Error("validator exploded") },
  })
  const validationResult = await validationHarness.executeTool("read", { path: "/a" }, context())
  assert.equal(errorCode(validationResult), TOOL_VALIDATION_FAILED)
  assert.equal(validationHarness.state.executions.length, 0)

  const executionHarness = createHarness({
    execute: async () => { throw new Error("read exploded") },
  })
  const executionResult = await executionHarness.executeTool("read", { path: "/a" }, context())
  assert.equal(errorCode(executionResult), TOOL_EXECUTION_FAILED)
  assert.equal(resultText(executionResult), "TOOL_EXECUTION_FAILED: read exploded")
}

/**
 * 验证执行前取消不会调用业务函数，执行中取消形成错误结果。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testCancellationBeforeAndDuringExecution(): Promise<void> {
  const beforeController = new AbortController()
  beforeController.abort()
  const beforeHarness = createHarness()
  const beforeResult = await beforeHarness.executeTool(
    "read",
    { path: "/a" },
    context(beforeController.signal),
  )
  assert.equal(errorCode(beforeResult), "CANCELLED")
  assert.equal(beforeHarness.state.validationInputs.length, 1)
  assert.equal(beforeHarness.state.executions.length, 0)

  const duringHarness = createHarness({
    execute: async () => { throw createAbortError("provider details") },
  })
  const duringResult = await duringHarness.executeTool("read", { path: "/a" }, context())
  assert.equal(errorCode(duringResult), "CANCELLED")
  assert.equal(resultText(duringResult), "CANCELLED: 工具调用已取消")
}

/**
 * 验证专属整理器失败后仅使用公共回退，不重复调用失败整理器。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function testRenderFailureUsesSafeCommonResult(): Promise<void> {
  const { executeTool } = createHarness({
    render: () => { throw new Error("sensitive renderer details\ninternal stack") },
  })
  const result = await executeTool("read", { path: "/a" }, context())

  assert.equal(errorCode(result), TOOL_RENDER_FAILED)
  assert.equal(resultText(result), "TOOL_RENDER_FAILED: 工具结果整理失败：read")
  assert.equal(resultText(result).includes("sensitive"), false)
  assert.equal(result.status === "error" && result.error.details === undefined, true)
}

/**
 * 按顺序执行当前文件的断言和已有资源清理流程。
 * @returns 当前场景全部断言及异步操作完成后解析。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
async function main(): Promise<void> {
  await testSuccessfulExecutionAndContext()
  await testEnvelopeAndToolValidationFailures()
  await testBusinessAppErrorUsesToolRender()
  await testRegistryFailuresUseCommonRender()
  await testThrownValidationAndExecutionErrors()
  await testCancellationBeforeAndDuringExecution()
  await testRenderFailureUsesSafeCommonResult()
  console.log("tool-executor.test.ts: 统一工具调用断言通过")
}

/** 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。 */
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
