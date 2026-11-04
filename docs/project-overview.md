# NiCode 项目概览

本文根据 2026-10-30 仓库中的已实现代码整理。描述当前项目，不代表未来功能承诺；后续变更应同时核对对应源码。面向使用者的启动说明见 [English README](../README.md) 和 [中文 README](../README.zh-CN.md)。

## 项目定位

NiCode 是本地运行的 Coding Agent 应用，提供 Electron 桌面工作区和独立 Node CLI。两种入口复用统一模型协议、AgentLoop 和工具实现。应用状态与日志保存到本机，模型推理通过用户配置的供应商完成。

桌面端面向持续交互：管理项目和对话，查看流式文本、思考和工具过程，发送或排队消息，处理审批，停止执行并恢复历史。CLI 面向脚本调用：每次接收一个任务，启动全新 Run，输出公共事件与最终结果。

## 已实现能力

| 能力 | 当前实现 | 主要代码入口 |
| --- | --- | --- |
| 项目与对话 | default 分组、Project 目录关联、对话索引、历史读取和跨路由缓存 | [project-ipc.ts](../src/main/project-ipc.ts)、[session-state.ts](../src/renderer/session-state.ts) |
| 桌面对话 | 流式回复、Markdown、工具结果、FIFO 消息队列、停止与审批 | [session-page.tsx](../src/renderer/session-page.tsx)、[SessionRuntime](../runtime/agent/src/session-runtime.ts) |
| 模型配置 | Provider、模型、API Key、默认模型、推理等级和请求字段路径 | [provider-ipc.ts](../src/main/provider-ipc.ts)、[provider-store.ts](../src/main/provider-store.ts) |
| 搜索服务配置 | 预置 Tavily、DeepSeek Search、Exa、Bocha 动态参数表单、同名配置、增改删、默认停用及唯一启用管理 | [搜索设置](../src/renderer/web-search-settings.tsx)、[web-search-ipc.ts](../src/main/web-search-ipc.ts) |
| 模型协议 | Anthropic Messages、Chat Completions、Responses 的请求与事件转换 | [adapter.ts](../runtime/model/src/adapter.ts) |
| 文件与进程工具 | glob、grep、read、write、edit、Shell 与 PTY 终端 | [tools 模块入口](../runtime/tools/src/index.ts) |
| 网页搜索 | `web_search` 接收 query，以本地启用配置执行 fetch 请求，通过 JMESPath 统一响应，每条摘要限制 800 粗估 token；桌面与 CLI 共用 | [搜索工具](../runtime/tools/src/web-search/index.ts) |
| 网页抓取 | `web_fetch` 接收 URL，最多五次跳转，共用 30 秒超时；最多读取 5 MiB 解压后正文，超限丢弃；HTML 转 Markdown，最终文本超过 32 KiB 时返回开头、保存全文并在末尾提供路径，桌面与 CLI 共用 | [抓取工具](../runtime/tools/src/web-fetch/index.ts) |
| MCP | STDIO / Streamable HTTP 连接、目录发现、搜索、按需载入、调用和设置管理 | [MCPManager](../runtime/mcp/src/manager.ts)、[mcp-ipc.ts](../src/main/mcp-ipc.ts) |
| Skill | Global / Project 来源同步、启停管理、描述注入及完整正文按需读取 | [SkillManager](../runtime/skill/src/manager.ts)、[skill-ipc.ts](../src/main/skill-ipc.ts) |
| 项目记忆 | 按分类列索引、按需读正文、整批追加；同一 Project 的对话共用 | [MemoryManager](../runtime/memory/src/index.ts) |
| 桌面上下文压缩 | Step 前检查压力，独立请求生成 Summary，按已提交事件恢复 | [summary.ts](../runtime/context/src/summary.ts)、[SessionRuntime](../runtime/agent/src/session-runtime.ts) |
| Headless CLI | prompt 文件 / JSON 请求、JSON / JSONL 输出、限步、超时、模块隔离与自动审批 | [CLI 入口](../src/cli/main.ts)、[协议](../src/cli/protocol.ts) |

兼容供应商目录当前已经包含 DeepSeek 的三种协议创建资料，见 [compatible-providers.ts](../src/main/compatible-providers.ts)。这是仓库内置的创建模板，不代表已验证远端服务当前支持情况；创建后的配置保存在数据库中，不依赖模板持续覆盖。

## 技术组成

- 全栈 TypeScript；Electron 主进程装配本机 Runtime，React Renderer 由 Vite 构建，preload 通过 contextBridge 暴露窄接口。
- 主进程、CLI 与 Runtime 由 TypeScript 输出 CommonJS；Renderer 单独构建为 HTML、JS 和 CSS。
- 模型接入使用 OpenAI 与 Anthropic SDK，公共网络资源由 undici Dispatcher 管理。
- 持久化使用 Node `node:sqlite`、JSON 和 Markdown；文件搜索使用项目依赖内的 ripgrep，PTY 使用 node-pty，进程工具当前使用 PowerShell 7。
- 测试使用 Node 断言、临时目录、本机假模型和真实子进程；尚未引入独立测试框架。

依赖和脚本的准确版本以 [package.json](../package.json) 与 [package-lock.json](../package-lock.json) 为准，本文不重复维护版本表。

## 当前边界

1. 仓库提供源码运行和构建入口，尚无桌面安装包构建脚本；`package.json` 为 `private: true`。
2. 模型配置初始为空，需要用户提供 Provider、模型与凭据；CLI 没有模型配置子命令。
3. CLI 不挂接桌面 IPC、Project 对话索引、历史恢复或消息队列，也未接入桌面的 Session 级 Summary 压缩；启用记忆时使用 default 分组，技能使用 Global 来源。
4. 权限模式由应用内工具检查与审批实现，不是操作系统沙箱。Shell 和 PTY 的初始 cwd 不能视为系统级目录隔离。
5. 普通桌面页面运行中发送消息进入队列；全局配置校验器接受 `insert`，但这不等于已实现可用的 Insert 交互流程。
6. `runtime/project/src/index.ts` 当前仍是目录占位；实际项目管理与上下文解析位于主进程，不能仅依据模块名称推断职责已经实现。
7. preload 当前使用多文件 CommonJS 产物，BrowserWindow 显式配置 `sandbox: false`，同时保持 `contextIsolation: true`、`nodeIntegration: false`。

## 继续阅读

- [架构与执行流程](architecture.md)：进程职责、Turn / Step、工具和恢复流程。
- [配置与持久化](configuration-and-storage.md)：本地数据目录、当前数据库与配置字段。
- [CLI 使用说明](cli-usage.md)：命令、请求格式、结果、事件与退出码。
- [开发与验证指南](development.md)：源码位置与已有验证入口。
- [AGENTS.md](../AGENTS.md)：开发规则、修改范围和验证豁免。
