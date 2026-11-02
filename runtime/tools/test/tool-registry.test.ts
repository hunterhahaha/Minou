/**
 * ToolRegistry / RenderRegistry 的离线测试。
 *
 * 不实现真实工具，只验证名称约束、定义读取、成对登记与失败时不产生半登记状态。运行：
 *   node --experimental-strip-types runtime/tools/test/tool-registry.test.ts
 */

import assert from "node:assert/strict"

import type { AppError } from "../../error/src/types.ts"
import {
  RenderRegistry,
  ToolRegistry,
  registerTool,
  type ToolRegistration,
} from "../src/tool-registry.ts"
import type { ToolResult } from "../src/types.ts"

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
 * 创建一个只用于注册表断言的假工具登记。
 * @param name 当前工具名称。
 * @returns 用于注册表断言的假工具定义、校验器、执行函数及整理器。
 */
function readRegistration(
  name: "read" | "grep" | "write" = "read",
): ToolRegistration<ReadArguments, ReadOutput> {
  return {
    kind: "builtin",
    definition: {
      name,
      description: `fake ${name}`,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    validateArguments: () => ({ success: true, data: { path: "/tmp/a.ts" } }),
    execute: async (input) => ({ text: input.path }),
    render: renderRead,
  }
}

/**
 * 把假工具输出或错误转换为统一文本结果。
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
 * 判断假结果是否为统一错误。
 * @param value 待检查的结果值。
 * @returns 值是否带有 source、code 和 message 字段。
 */
function isAppError(value: ReadOutput | AppError): value is AppError {
  return "source" in value && "code" in value && "message" in value
}

/**
 * 验证工具与整理器成对登记，模型定义副本不会反向修改注册表。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
function testPairedRegistrationAndDefinitions(): void {
  const tools = new ToolRegistry()
  const renders = new RenderRegistry()
  registerTool(tools, renders, readRegistration())

  assert.equal(tools.has("read"), true)
  assert.equal(renders.has("read"), true)
  assert.equal(tools.get("read")?.kind, "builtin")
  assert.deepEqual(tools.listDefinitions(), [{
    name: "read",
    description: "fake read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  }])

  /** 暴露层可以修改自己的定义副本，不能反向改变注册表。 */
  const returned = tools.listDefinitions()
  returned[0].inputSchema.type = "changed"
  assert.equal(tools.listDefinitions()[0].inputSchema.type, "object")
}

/**
 * 验证重复登记在写入前被拒绝，两张注册表不留下半登记状态。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
function testDuplicatePreflightLeavesBothRegistriesConsistent(): void {
  const tools = new ToolRegistry()
  const renders = new RenderRegistry()
  registerTool(tools, renders, readRegistration())

  assert.throws(
    () => registerTool(tools, renders, readRegistration()),
    /工具已经登记：read/,
  )
  assert.equal(tools.listDefinitions().length, 1)

  /** 结果整理器一侧冲突时，工具一侧仍不能提前写入。 */
  renders.register("grep", renderRead)
  assert.throws(
    () => registerTool(tools, renders, readRegistration("grep")),
    /工具结果整理器已经登记：grep/,
  )
  assert.equal(tools.has("grep"), false)

  /** 工具一侧冲突时，结果整理器一侧也不能提前写入。 */
  tools.register(readRegistration("write"))
  assert.throws(
    () => registerTool(tools, renders, readRegistration("write")),
    /工具已经登记：write/,
  )
  assert.equal(renders.has("write"), false)
}

/**
 * 验证内置及动态 MCP 工具名称与来源元数据约束。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
function testNameAndSourceValidation(): void {
  const tools = new ToolRegistry()

  const unknownBuiltin = readRegistration()
  unknownBuiltin.definition.name = "not_builtin" as "read"
  assert.throws(() => tools.register(unknownBuiltin), /未知的内置工具名称/)

  const wrongMcpName = readRegistration()
  wrongMcpName.kind = "mcp"
  assert.throws(() => tools.register(wrongMcpName), /MCP 工具名称必须使用 mcp_ 前缀/)

  const emptyMcpName = readRegistration()
  emptyMcpName.kind = "mcp"
  emptyMcpName.definition.name = "mcp_"
  assert.throws(() => tools.register(emptyMcpName), /并包含实际名称/)

  const validMcp = readRegistration()
  validMcp.kind = "mcp"
  validMcp.definition.name = "mcp_server_read"
  tools.register(validMcp)
  assert.equal(tools.has("mcp_server_read"), true)
}

/**
 * 按顺序执行当前文件的断言和已有资源清理流程。
 * @throws Error 断言或场景执行失败时传播，由测试入口报告失败。
 */
function main(): void {
  testPairedRegistrationAndDefinitions()
  testDuplicatePreflightLeavesBothRegistriesConsistent()
  testNameAndSourceValidation()
  console.log("tool-registry.test.ts: 注册表断言通过")
}

main()
