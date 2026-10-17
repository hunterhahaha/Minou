import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js"
import type { AppError } from "../../error/src/types.ts"
import type { UnifiedToolDefinition } from "../../model/src/types.ts"

/** 全局 MCP Server 的身份、开关与以秒计的可选超时。 */
export interface MCPConfigBase {
  /** 用户指定的连接身份，同名配置以后项为准。 */
  name: string
  /** 是否在应用启动时建立连接。 */
  enabled: boolean
  /** 连接和首次完整目录获取的总时限，默认 10 秒。 */
  startup_timeout_sec?: number
  /** 单次远程工具调用时限，默认 60 秒。 */
  tool_timeout_sec?: number
}

/** 由官方 Transport 启动一个本地子进程的配置。 */
export interface MCPStdioConfig extends MCPConfigBase {
  /** 本地进程传输。 */ transport: "stdio"
  /** 启动命令，不经过额外 shell 拼接。 */ command: string
  /** 按顺序传给子进程的参数。 */ args?: string[]
  /** 子进程初始目录；省略时由 SDK 使用宿主工作目录。 */ cwd?: string
  /** 在 SDK 默认环境上添加或覆盖的变量。 */ env?: Record<string, string>
}

/** 通过 Streamable HTTP 访问远端端点的配置。 */
export interface MCPHttpConfig extends MCPConfigBase {
  /** HTTP 传输。 */ transport: "streamable-http"
  /** 绝对 HTTP(S) 端点。 */ url: string
  /** 保存 Bearer Token 的宿主环境变量名。 */ bearer_token_env_var?: string
  /** 静态请求头，不得与 Bearer 配置重复提供 Authorization。 */ http_headers?: Record<string, string>
}

/** config.json.mcpServers 中的已校验配置。 */
export type MCPConfig = MCPStdioConfig | MCPHttpConfig

/** 进程级连接资源与可公开的状态；错误中不保存凭据。 */
export interface MCPConnection {
  /** 已确定的最终配置。 */ config: MCPConfig
  /** 初始化成功创建的 SDK Client。 */ client?: Client
  /** 对应 Client 的唯一传输。 */ transport?: Transport
  /** 连接与目录是否可供使用。 */ status: "connecting" | "connected" | "disconnected" | "error"
  /** 最近一次稳定错误说明。 */ error?: AppError
}

/** 一个具体远端工具在全局目录中的完整定义。 */
export interface MCPCatalogTool {
  /** 稳定且可直接作为模型名称使用的 mcp_ 标识。 */ name: `mcp_${string}`
  /** 所属配置 name。 */ serverId: string
  /** SDK tools/call 所需原始名称。 */ originalToolName: string
  /** 当前模型定义，不含 Runtime 的 callDescription。 */ definition: UnifiedToolDefinition
  /** 从远端 Schema 编译的业务参数检查器。 */ validate: JsonSchemaValidator<Record<string, unknown>>
}

/** 持久化到各 Session Meta 的工具载入与预算记录。 */
export interface SessionLoadedMCPTool {
  /** 对应 Catalog 的模型名称。 */ name: string
  /** 所属配置 name。 */ serverId: string
  /** 远端原始工具名称。 */ originalToolName: string
  /** 当前定义的本地 Token 估算。 */ estimatedTokens: number
  /** 最近真正发起调用的时间戳；从未调用为 0。 */ lastCalledAt: number
}

/** 工具发现只返回可用于指定载入的名称和 Server 身份。 */
export interface MCPToolNameInfo {
  /** 可传给 mcp_load_tools 的名称。 */ name: string
  /** 所属配置 name。 */ serverId: string
}

/** SDK 正常返回对象的专属执行结果，不在执行阶段过滤内容。 */
export interface MCPToolCallResult {
  /** 所属配置 name。 */ serverId: string
  /** 传给 SDK 的原始名称。 */ rawToolName: string
  /** SDK 原样返回的完整对象。 */ result: unknown
}
