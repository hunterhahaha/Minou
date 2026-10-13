/**
 * Tool 模块入口。
 *
 * 模块职责：Tool Runtime 核心组件 —— ToolRegistry（工具定义、参数 Schema、执行函数与来源元数据）、
 * RenderRegistry、文件工具与专属 render、
 * ToolExecutor（统一校验、权限、执行与 render）、ToolScheduler（共享只读与独占执行调度、
 * 审批屏障）、ToolOutputStore（超过 64 KB 的工具输出落盘）。
 *
 * 文件划分：
 *   types.ts            统一 ToolResult 与内容块（第 16.2 节）
 *   tool-registry.ts    ToolRegistry、RenderRegistry 与成对登记入口（第 16、16.3 节）
 *   tool-executor.ts    查表、参数检查、业务执行与 render 的统一调用入口（第 16.4 节）
 *   tool-scheduler.ts   ToolScheduler：一次工具小轮的串并行调度（第 17 节）
 *
 * 本目录同时收纳与工具有关的全部代码，子目录职责：
 *   render/      工具结果渲染器
 *   present/     present 工具
 *   file/        文件工具本体 glob / grep / read / write / edit
 *   filesystem/  文件工具共享基础设施 RipgrepManager / FileSystem / PathValidator
 *   shell/       shell 工具（含 ShellRouter）
 *   terminal/    PTY 工具 terminal_open / terminal_input / terminal_close / terminal_list 与 TerminalState
 *   mcp/         MCP 工具接入 mcp_list_tools / mcp_load_tools / tool_search
 *   skill/       skill_load 工具（Skill Runtime 本体在 runtime/skill/）
 *   memory/      memory_list / memory_read / memory_write 工具（Memory Runtime 本体在 runtime/memory/）
 *   security/    SandboxPolicy / ApprovalManager 工具权限与审批屏障
 *
 * 当前已实现的部分：统一 ToolResult、ToolRegistry / RenderRegistry、统一 ToolExecutor 调用入口、
 * ToolScheduler 的串并行调度、六个文件工具及其路径权限检查与专属 render，
 * 以及 Project Memory 三件套工具与专属 render。
 * 文件工具审批等待由 SessionRuntime 提供，Renderer 审批接线尚未实现；
 * AgentLoop 继续通过注入的执行入口调用工具（见 runtime/agent/src/loop.ts）。
 *
 * 位置说明：与工具有关的代码统一收在本目录下，因此 runtime/ 顶层没有独立的
 * filesystem/ 与 security/；文档第 30 节的目录树只是参考。
 *
 * 架构依据：.git/技术文档/开发备忘录1.0.17.md 第 16 节（Tool Runtime）、第 17 节（Tool Scheduler）、
 * 第 19–24 节、第 26 节
 * 实施阶段：阶段 6.4 的调度接线、第 16 节通用注册与执行入口及第 18 节文件工具
 */
export * from "./types.ts"
export * from "./tool-registry.ts"
export * from "./tool-executor.ts"
export * from "./tool-scheduler.ts"
export * from "./file/index.ts"
export * from "./filesystem/index.ts"
export * from "./memory/index.ts"
