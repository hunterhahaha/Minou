/**
 * 统一工具调用入口的离线测试。
 *
 * 使用登记的假 read 工具覆盖查表、参数检查、调用说明分离、取消、异常归一化和结果整理回退。运行：
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

interface ReadArguments {
  path: string
}

interface ReadOutput {
  text: string
}

interface HarnessState {
  validationInputs: unknown[]
  executions: {
    input: ReadArguments
    context: ToolExecutionContext<ReadArguments>
  }[]
  renderInputs: (ReadOutput | AppError)[]
}

interface RegistrationOverrides {
  validateArguments?(input: unknown): ToolArgumentValidation<ReadArguments>
  execute?(
    input: ReadArguments,
    context: ToolExecutionContext<ReadArguments>,
  ): Promise<ReadOutput | AppError>
  render?(result: ReadOutput | AppError): ToolResult
}

/** 创建可观察每个阶段输入的假 read 工具。 */
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

/** 创建空的观察状态。 */
function createState(): HarnessState {
  return { validationInputs: [], executions: [], renderInputs: [] }
}

/** 创建完成成对登记的假执行入口。 */
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

/** 假 read 工具的专属结果整理器。 */
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

/** 判断假 read 的联合结果是否为 AppError。 */
function isAppError(value: ReadOutput | AppError): value is AppError {
  return "source" in value && "code" in value && "message" in value
}

/** 创建带固定身份和指定信号的调用上下文。 */
function context(signal: AbortSignal = new AbortController().signal): ToolCallContext {
  return {
    turn: 3,
    step: 2,
    blockId: "b-3-2-1",
    toolCallId: "call-7",
    signal,
  }
}

/** 读取错误 ToolResult 的错误码。 */
function errorCode(result: ToolResult): string | undefined {
  return result.status === "error" ? result.error.code : undefined
}

/** 读取 ToolResult 的第一个文本块。 */
function resultText(result: ToolResult): string {
  const first = result.content[0]
  return first?.type === "text" ? first.text : ""
}

async function testSuccessfulExecutionAndContext(): Promise<void> {
  const { state, executeTool } = createHarness()
  const callContext = context()
  const result = await executeTool("read", {
    path: "/workspace/a.ts",
    callDescription: "读取实现",
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
    callDescription: "读取实现",
  })
  assert.equal(state.executions[0].context.turn, callContext.turn)
  assert.equal(state.executions[0].context.step, callContext.step)
  assert.equal(state.executions[0].context.blockId, callContext.blockId)
  assert.equal(state.executions[0].context.toolCallId, callContext.toolCallId)
  assert.equal(state.executions[0].context.signal, callContext.signal)
}

async function testEnvelopeAndToolValidationFailures(): Promise<void> {
  const { state, executeTool } = createHarness()

  const arrayResult = await executeTool("read", [], context())
  assert.equal(errorCode(arrayResult), INVALID_TOOL_ARGUMENTS)
  assert.equal(state.validationInputs.length, 0)
  assert.equal(state.executions.length, 0)

  const metaResult = await executeTool("read", {
    path: "/workspace/a.ts",
    callDescription: 7,
  }, context())
  assert.equal(errorCode(metaResult), INVALID_TOOL_ARGUMENTS)
  assert.equal(state.validationInputs.length, 0)
  assert.equal(state.executions.length, 0)

  const toolResult = await executeTool("read", { path: 7 }, context())
  assert.equal(errorCode(toolResult), "BAD_ARGUMENTS")
  assert.equal(state.validationInputs.length, 1)
  assert.equal(state.executions.length, 0)
}

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

// 不用顶层 await：测试运行时被 Node 当作 ESM，但 tsc 按 CommonJS 检查。
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
