/** Team 工具参数、角色暴露和结果整理。 */
import type { AppError } from "../../../error/src/types.ts"
import type { UnifiedToolDefinition } from "../../../model/src/types.ts"
import { isPlainRecord, registerTool } from "../tool-registry.ts"
import type { RenderRegistry, ToolArgumentValidation, ToolRegistry } from "../tool-registry.ts"
import type { ToolResult } from "../types.ts"
import type { BlackboardInput, CommunicationInput, TeamToolOutput } from "./types.ts"

const ROUTER_EVENTS = ["create_session", "close_session", "send_message"] as const
const MEMBER_EVENTS = ["report_completion", "request_authorization"] as const
const STRING = { type: "string", minLength: 1 }
const BOARD_DEFINITION: UnifiedToolDefinition & { name: "blackboard" } = {
  name: "blackboard",
  description: "Workspace blackboard for Team Sessions. publish(name, description, mentions, body) stores a post and returns its ID. unread() lists others' unread summaries, mentions first, and advances your cursor. read(post_id) returns the body of a post at or before your cursor.",
  inputSchema: {
    type: "object",
    properties: { mode: { enum: ["publish", "unread", "read"] }, name: STRING, description: STRING,
      mentions: { type: "array", items: STRING }, body: STRING, post_id: { type: "string", pattern: "^#[1-9][0-9]*$" } },
    required: ["mode"], additionalProperties: false,
    oneOf: [
      { properties: { mode: { const: "publish" } }, required: ["name", "description", "mentions", "body"] },
      { properties: { mode: { const: "read" } }, required: ["post_id"] },
      { properties: { mode: { const: "unread" } } },
    ],
  },
}

/**
 * 生成当前角色可见的通信参数与行为说明。
 * @param role 当前模型角色。
 * @returns 与统一通信执行入口同名的角色定义。
 */
export function communicationDefinition(role: "router" | "member"): UnifiedToolDefinition & { name: "communication" } {
  const router = role === "router"
  return {
    name: "communication",
    description: router
      ? "Manage Team Sessions in your Workspace. create_session(session_info?) returns a new session_id and queues optional initial instructions. close_session(session_id) permanently closes it. send_message(session_id, message) queues a user message and resumes a waiting or finished session."
      : "Communicate with your Router. report_completion(message) queues your result to the Router and marks this task finished. request_authorization(message) queues the reason and decision needed, and puts this session in waiting until the Router sends instructions.",
    inputSchema: {
      type: "object",
      properties: {
        event: { enum: router ? [...ROUTER_EVENTS] : [...MEMBER_EVENTS] },
        ...(router && { session_id: STRING, session_info: STRING }),
        message: STRING,
      },
      required: router ? ["event"] : ["event", "message"], additionalProperties: false,
      ...(router && { oneOf: [
        { properties: { event: { const: "create_session" } } },
        { properties: { event: { const: "close_session" } }, required: ["session_id"] },
        { properties: { event: { const: "send_message" } }, required: ["session_id", "message"] },
      ] }),
    },
  }
}

/**
 * 判断工具在当前角色的请求及执行中是否可用。
 * @param name 工具名。
 * @param role 缺省为普通会话。
 * @returns 角色是否可以使用该工具。
 */
export function teamAllowsTool(name: string, role?: "router" | "member"): boolean {
  if (name === "communication") return role !== undefined
  if (name === "blackboard") return role === "member"
  if (role === "router") return name !== "shell" && name !== "tool_search" &&
    !name.startsWith("terminal_") && !name.startsWith("mcp_")
  return role !== "member" || !name.startsWith("memory_")
}

/**
 * 登记桌面 Team 的两个工具及其结果整理器。
 * @param tools 全局执行注册表。
 * @param renders 全局结果注册表。
 * @throws Error 同名登记冲突时抛出。
 */
export function registerTeamTools(tools: ToolRegistry, renders: RenderRegistry): void {
  registerTool(tools, renders, {
    kind: "builtin", definition: communicationDefinition("router"),
    validateArguments: validateCommunication,
    execute: async (input, context) => {
      const port = context.teamRuntime
      const allowed: readonly string[] = port?.role === "router" ? ROUTER_EVENTS : MEMBER_EVENTS
      return port && allowed.includes(input.event) ? port.communicate(input, context.signal) : denied()
    },
    render,
  })
  registerTool(tools, renders, {
    kind: "builtin", definition: BOARD_DEFINITION,
    validateArguments: validateBlackboard,
    execute: async (input, context) => context.teamRuntime?.role === "member" ? context.teamRuntime.blackboard(input) : denied(),
    render,
  })
}

/** 检查各事件的允许字段及必需字符串。 */
function validateCommunication(input: unknown): ToolArgumentValidation<CommunicationInput> {
  if (isPlainRecord(input)) {
    switch (input.event) {
      case "create_session":
        if (keys(input, ["event", "session_info"]) && (input.session_info === undefined || nonempty(input.session_info))) {
          return { success: true, data: { event: input.event, session_info: input.session_info } }
        }
        break
      case "close_session":
        if (keys(input, ["event", "session_id"]) && nonempty(input.session_id)) {
          return { success: true, data: { event: input.event, session_id: input.session_id } }
        }
        break
      case "send_message":
        if (keys(input, ["event", "session_id", "message"]) && nonempty(input.session_id) && nonempty(input.message)) {
          return { success: true, data: { event: input.event, session_id: input.session_id, message: input.message } }
        }
        break
      case "report_completion":
      case "request_authorization":
        if (keys(input, ["event", "message"]) && nonempty(input.message)) {
          return { success: true, data: { event: input.event, message: input.message } }
        }
    }
  }
  return invalid("communication 参数与 event 不匹配")
}

/** 校验帖子字段、Mention 数组和安全的数字编号。 */
function validateBlackboard(input: unknown): ToolArgumentValidation<BlackboardInput> {
  if (isPlainRecord(input)) {
    if (input.mode === "unread" && keys(input, ["mode"])) return { success: true, data: { mode: "unread" } }
    if (input.mode === "read" && keys(input, ["mode", "post_id"]) && typeof input.post_id === "string" &&
      /^#[1-9]\d*$/.test(input.post_id)) {
      const postId = Number(input.post_id.slice(1))
      if (Number.isSafeInteger(postId)) return { success: true, data: { mode: "read", postId } }
    }
    if (input.mode === "publish" && keys(input, ["mode", "name", "description", "mentions", "body"]) &&
      nonempty(input.name) && nonempty(input.description) && nonempty(input.body) &&
      Array.isArray(input.mentions) && input.mentions.every(nonempty)) {
      return { success: true, data: { mode: "publish", post: {
        name: input.name, description: input.description, mentions: input.mentions, body: input.body,
      } } }
    }
  }
  return invalid("blackboard 参数与 mode 不匹配")
}

/** 将成功数据或失败原因整理为模型可读文本。 */
function render(output: TeamToolOutput | AppError): ToolResult {
  if ("code" in output) return { status: "error", error: output, content: [{ type: "text", text: output.message }] }
  const text = "data" in output ? JSON.stringify(output.data) : [
    "Posts mentioning you:", ...output.summaries.mentioned.map((post) => JSON.stringify(post)),
    "Unread posts:", ...output.summaries.unread.map((post) => JSON.stringify(post)),
  ].join("\n")
  return { status: "success", content: [{ type: "text", text }] }
}

/** 判断参数是否只使用当前事件允许的字段。 */
function keys(input: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(input).every((name) => allowed.includes(name))
}

/** 判断业务文本是否含有有效内容。 */
function nonempty(input: unknown): input is string { return typeof input === "string" && input.trim() !== "" }

/** 生成不包含模型输入的参数错误。 */
function invalid(message: string): { success: false; error: AppError } {
  return { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message } }
}

/** 生成角色权限错误。 */
function denied(): AppError { return { source: "tool", code: "TEAM_TOOL_FORBIDDEN", message: "当前会话角色不能执行此 Team 操作" } }
