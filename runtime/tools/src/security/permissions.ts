import { relative } from "node:path"
import { canonicalPath, isWithinRoot } from "../filesystem/index.ts"
import { isPlainRecord } from "../tool-registry.ts"
import type { ToolExecutionContext } from "../types.ts"
import type { SandboxMode } from "../../../session/src/session-state.ts"
import type { ApprovalDecision } from "../../../session/src/events.ts"

/** 会话路径规则。更具体的路径覆盖祖先路径。 */
export interface PathPermission {
  /** 经真实路径解析的绝对路径。 */
  path: string
  /** 此路径及其子树的默认权限。WRITE 同时允许读取和写入。 */
  access: "READ" | "WRITE" | "DENY"
}

/** 已授权的会话权限，或单次启动时合并后的权限。 */
export interface ToolPermissions {
  /** 显式路径规则。 */
  paths: PathPermission[]
  /** 是否开放 MXC 进程的网络访问。 */
  network: boolean
}

/** 模型提交的申请批次。 */
export interface PermissionRequest {
  /** 逐项申请的绝对路径。 */
  path: { read: string[]; write: string[] }
  /** 是否申请网络。 */
  network: boolean
}

/** 一项独立审批使用的权限类型及目标。 */
export type PermissionItem = { type: "read" | "write"; path: string } | { type: "network" }
/** 供审核分流及审批浮层显示的授权范围。 */
export type ApprovalScope = "persistent" | "temporary" | "unrestricted"
/** 工具的本次执行权限模式。 */
export type ExecutionPermission = { mode: "default" | "unrestricted" } | { mode: "temporary"; permissions: PermissionRequest }

/** SessionRuntime 注入的权限保存与审批端口。 */
export interface ToolPermissionRuntime {
  /**
   * 合并并保存已批准项。
   * @param items 本次已有明确批准的权限。
   * @returns 持久化完成后解析。
   * @throws Error 会话状态不可读取或保存失败。
   */
  grant(items: readonly PermissionItem[]): Promise<void>
  /**
   * 审核一项权限或一次完全访问操作。
   * @param name 模型看到的工具名。
   * @param scope 授权生效范围。
   * @param details 审批者看到的当前项或完整命令。
   * @param context 权威工具调用身份及取消信号。
   * @returns 明确决定，或工具被取消。
   * @throws Error 审批事件无法提交。
   */
  approve(name: string, scope: ApprovalScope, details: object, context: ToolExecutionContext<object>): Promise<ApprovalDecision>
}

/** 权限申请工具和临时执行共用的参数契约。 */
export const permissionRequestSchema = {
  type: "object", additionalProperties: false, required: ["path", "network"],
  properties: {
    path: {
      type: "object", additionalProperties: false, required: ["read", "write"],
      properties: {
        read: { type: "array", items: { type: "string" }, description: "Absolute paths for which read access is sufficient." },
        write: { type: "array", items: { type: "string" }, description: "Absolute paths that need write access. A write grant includes read access to the same path." },
      },
    },
    network: { type: "boolean" },
  },
} as const

/** 工具定义公开的执行模式参数。 */
export const executionPermissionProperties = {
  mode: {
    type: "string", enum: ["default", "temporary", "unrestricted"], default: "default",
    description: "Default uses current permissions. Temporary requests extra permissions for this operation. Unrestricted asks the user to approve the complete operation once; a newly created terminal keeps that access for its lifetime.",
  },
  permissions: {
    ...permissionRequestSchema,
    description: "Required only in temporary mode. Each path and the network request are reviewed independently.",
  },
} as const

/**
 * 检查申请结构；真实路径在提交审批前解析。
 * @param value 模型传入的参数。
 * @returns 参数是否为完整的权限请求。
 */
export function isPermissionRequest(value: unknown): value is PermissionRequest {
  if (!isPlainRecord(value) || Object.keys(value).length !== 2 || typeof value.network !== "boolean" ||
    !isPlainRecord(value.path) || Object.keys(value.path).length !== 2) return false
  return [value.path.read, value.path.write].every((paths) => Array.isArray(paths) && paths.every((path) => typeof path === "string"))
}

/**
 * 检查执行模式和临时申请参数的组合。
 * @param value 包含可选执行参数的工具输入。
 * @returns 校验后的执行模式；组合无效时返回 undefined。
 */
export function readExecutionPermission(value: Record<string, unknown>): ExecutionPermission | undefined {
  if (value.mode === "temporary") return isPermissionRequest(value.permissions) ? { mode: "temporary", permissions: value.permissions } : undefined
  if (value.permissions !== undefined) return undefined
  if (value.mode === "unrestricted") return { mode: "unrestricted" }
  if (value.mode === undefined || value.mode === "default") return { mode: "default" }
}

/**
 * 从 Meta 读取权限；损坏的规则会使依赖该配置的调用失败。
 * @param value 会话保存的权限字段。
 * @returns 显式规则及网络权限；新会话初始为空。
 * @throws Error 权限结构无效。
 */
export function readToolPermissions(value: unknown): ToolPermissions {
  if (value === undefined) return { paths: [], network: false }
  if (!isPlainRecord(value) || typeof value.network !== "boolean" || !Array.isArray(value.paths) ||
      !value.paths.every((entry) => isPlainRecord(entry) && typeof entry.path === "string" &&
        (entry.access === "READ" || entry.access === "WRITE" || entry.access === "DENY"))) {
    throw new Error("会话工具权限无效")
  }
  return { paths: value.paths, network: value.network }
}

/**
 * 用路径身份更新规则，保持工作区切换或同次临时授权影响的范围可查。
 * @param rules 需要原地更新的规则表。
 * @param rule 新的精确路径规则。
 */
export function setPathPermission(rules: PathPermission[], rule: PathPermission): void {
  const index = rules.findIndex(({ path }) => relative(path, rule.path) === "")
  if (index === -1) rules.push(rule)
  else rules[index] = rule
}

/**
 * 找到覆盖目标的最具体规则。
 * @param rules 同一权限快照中的路径规则。
 * @param target 已规范化的目标路径。
 * @returns 匹配的访问等级；无授权时返回 DENY。
 */
export function pathPermission(rules: readonly PathPermission[], target: string): PathPermission["access"] {
  let matched: PathPermission | undefined
  for (const rule of rules) {
    if (isWithinRoot(target, rule.path) && (!matched || isWithinRoot(rule.path, matched.path))) matched = rule
  }
  return matched?.access ?? "DENY"
}

/**
 * 合并当前关联目录与会话已保存的显式规则。
 * @param mode 用户选择的会话模式。
 * @param roots 当前工作区关联目录。
 * @param stored 已保存的长期授权。
 * @returns 本次工具执行的基础规则。
 * @throws Error 工作区路径不可规范化。
 */
export async function workspacePermissions(mode: SandboxMode, roots: readonly string[], stored: ToolPermissions): Promise<ToolPermissions> {
  const paths: PathPermission[] = []
  const access = mode === "sandbox-read-only" ? "READ" : "WRITE"
  for (const path of await Promise.all(roots.map(canonicalPath))) setPathPermission(paths, { path, access })
  for (const rule of stored.paths) setPathPermission(paths, rule)
  return { paths, network: stored.network }
}

/**
 * 核对显式完全访问请求。
 * @param name 当前工具名。
 * @param details 审批时显示的准确命令或路径。
 * @param context 工具调用与审批端口。
 * @throws Error 拒绝、取消或审批端口缺失。
 */
export async function authorizeUnrestricted(name: string, details: object, context: ToolExecutionContext<object>): Promise<void> {
  if (!context.toolPermissions) throw new Error("当前会话缺少工具权限上下文")
  const decision = await context.toolPermissions.approve(name, "unrestricted", details, context)
  if (decision === "cancelled" || context.signal.aborted) throw permissionError("CANCELLED", "工具调用已取消")
  if (decision !== "approved") throw permissionError("APPROVAL_DENIED", "完全访问未获批准")
}

/**
 * 在独立快照中加入明确批准的权限。已有写权限不会被读取申请降级。
 * @param base 合并前的权限。
 * @param items 已批准的各项。
 * @returns 合并后可独立使用的权限表。
 */
export function grantPermissions(base: ToolPermissions, items: readonly PermissionItem[]): ToolPermissions {
  const next = { paths: [...base.paths], network: base.network }
  for (const item of items) {
    if (item.type === "network") next.network = true
    else if (item.type === "write" || pathPermission(next.paths, item.path) !== "WRITE") {
      setPathPermission(next.paths, { path: item.path, access: item.type === "write" ? "WRITE" : "READ" })
    }
  }
  return next
}

/**
 * 在任何审批开始前解析路径，随后逐项等待决定。
 * @param name 发起申请的工具。
 * @param request 模型提交的权限请求。
 * @param scope 权限生效范围。
 * @param context 当前调用身份及会话审批端口。
 * @param operation 临时申请会影响的本次命令或文件操作。
 * @returns 明确批准和拒绝的原子项。
 * @throws Error 路径无效或变化、上下文缺失、审批失败或调用取消。
 */
export async function reviewPermissions(name: string, request: PermissionRequest, scope: "persistent" | "temporary", context: ToolExecutionContext<object>, operation?: object) {
  const runtime = context.toolPermissions
  if (!runtime) throw new Error("当前会话缺少工具权限上下文")
  const targets = [
    ...request.path.read.map((path) => ({ type: "read" as const, path })),
    ...request.path.write.map((path) => ({ type: "write" as const, path })),
  ]
  const items: PermissionItem[] = await Promise.all(targets.map(async ({ type, path }) => ({ type, path: await canonicalPath(path) })))
  if (request.network) items.push({ type: "network" })
  const approved: PermissionItem[] = []
  const rejected: PermissionItem[] = []
  for (const [index, item] of items.entries()) {
    const decision = await runtime.approve(name, scope, operation ? { ...item, operation } : item, context)
    if (decision === "cancelled" || context.signal.aborted) throw permissionError("CANCELLED", "工具调用已取消")
    if (decision === "denied") { rejected.push(item); continue }
    if (item.type !== "network" && (await canonicalPath(targets[index].path) !== item.path)) {
      throw permissionError("PATH_CHANGED", "审批期间授权路径发生变化")
    }
    if (context.signal.aborted) throw permissionError("CANCELLED", "工具调用已取消")
    if (scope === "persistent") await runtime.grant([item])
    approved.push(item)
  }
  return { approved, rejected }
}

/**
 * 构造工具执行边界可识别的权限错误。
 * @param code 稳定的工具错误码。
 * @param message 返回给模型的错误说明。
 * @returns 带错误码的异常。
 */
export function permissionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
