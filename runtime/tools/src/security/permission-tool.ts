import type { AppError } from "../../../error/src/types.ts"
import { processError } from "../process/access.ts"
import { registerTool, type RenderRegistry, type ToolRegistry } from "../tool-registry.ts"
import { isPermissionRequest, permissionRequestSchema, reviewPermissions, type PermissionItem, type PermissionRequest } from "./permissions.ts"

/** 已完成审批批次的模型结果。 */
interface PermissionRequestResult {
  /** 本次审批项数。 */ total: number
  /** 已批准并写入会话的项数。 */ approved: number
  /** 已明确拒绝的项数。 */ rejected: number
  /** 拒绝项的类型和相关路径。 */ rejectedRequests: PermissionItem[]
}

/**
 * 注册模型主动发起的会话长期授权工具。
 * @param tools 模型工具注册表。
 * @param renders 工具结果注册表。
 * @throws Error 工具已注册或定义无效。
 */
export function registerPermissionTool(tools: ToolRegistry, renders: RenderRegistry): void {
  registerTool<PermissionRequest, PermissionRequestResult | AppError>(tools, renders, {
    kind: "builtin",
    definition: {
      name: "request_permissions",
      description: "Request durable permissions for this conversation. Call this tool when an operation fails due to insufficient permissions, or before running a command if you expect it will need file or network access you do not already have. A write grant includes read access to the same path. Use path.write alone when you need both. Each requested absolute path and the optional network grant is reviewed separately. Approved grants remain active in later calls. Unlisted paths and process networking are denied by default. Request only the access you need.",
      inputSchema: permissionRequestSchema,
    },
    validateArguments: (value) => isPermissionRequest(value) ? { success: true, data: value } :
      { success: false, error: { source: "tool", code: "INVALID_TOOL_ARGUMENTS", message: "需要提供 path.read、path.write 和 network" } },
    execute: async (input, context): Promise<PermissionRequestResult | AppError> => {
      try {
        const { approved, rejected } = await reviewPermissions("request_permissions", input, "persistent", context)
        return { total: approved.length + rejected.length, approved: approved.length, rejected: rejected.length, rejectedRequests: rejected }
      } catch (error) {
        return processError(error, "PERMISSION_REQUEST_FAILED")
      }
    },
    render: (value) => "code" in value
      ? { status: "error", error: value, content: [{ type: "text", text: value.message }] }
      : { status: "success", content: [{ type: "text", text: JSON.stringify(value) }] },
  })
}
