# NiCode

NiCode V1 是一个本地运行的 Coding Agent Runtime：浏览器 UI 与本机 Runtime 协作，内部统一管理模型、上下文、工具、错误、Usage 与 Session，厂商协议细节只存在于 Protocol Adapter 层。

## 事实源与规则

| 文件 | 作用 |
| --- | --- |
| `.git/技术文档/开发备忘录1.0.17.md` | 架构事实源 |
| `.git/技术文档/开发TODOList.md` | 实施顺序与阶段范围（当前覆盖「三个 Adapter + AgentLoop」） |
| `.git/技术文档/NiCode_Usage统一设计.md` | **Usage 部分以此为准**，取代备忘录第 27.1、35.2 节的相应内容 |
| `AGENTS.md` | 开发规则与工作流程 |

## 当前状态

**阶段 0（工程骨架）**已完成：工程配置与目录占位。

**启动配置文件初始化**已完成：`src/main/config-files.ts` 导出
`initializeConfigFiles(userProfile?)`，按备忘录第 2–4 节初始化 `.nicode`、
`config.json`、`skills/`、`sessions/`、`logs/` 与 `sessions/default`，并创建共享的
`events.sqlite`、独立的 `workspace.sqlite` 和 `providers.sqlite` 数据库。
新建 `config.json` 使用 V2 空配置；Provider 数据库首次创建时为空，工作区数据库只在
default 分组不存在时补入空记录。已有全局配置按 V2 检查；旧 V1 文件不迁移、
不改写，失败时保留原文件并抛出带路径的错误。旧 `credentials.json` 不再创建或读取。
旧 `workspace.json` 不迁移、不读取或删除。真实 Electron 入口只保留返回的固定路径，
不保留 Provider 配置或凭据快照。每个 Provider（包括暂时没有模型的 Provider）必须
恰好配置一个协议。每个 Turn 只读打开 `providers.sqlite`，在同一数据库快照中取得
所选模型、协议参数和 API Key；读取不会创建缺失数据库，也不读取 workspace。

**Electron 可执行入口和 `startElectronApp` 参数装配**已完成：package 的 `main` 指向
`src/main/electron-main.ts` 的编译产物。该入口直接导入真实 Electron `app`、`ipcMain` 和
`BrowserWindow`，依次初始化并首次校验配置文件、初始化全局 Network Dispatcher、空 Tool / Render
Registry 的统一执行入口和 Project Context resolver，随后逐字段调用：

```ts
await startElectronApp({
  app,
  ipcMain,
  windows,
  configPaths: paths,
  sessionRuntime: {
    systemPrompt: "You are an AI agent powered by NiCode.",
    resolveProjectContext,
    estimateSkillTokens: estimateLocalTokens,
    createTurnModelAdapter: (model) =>
      createTurnModelAdapter(paths, model),
    executeTool,
  },
  onSessionCompletionFailure,
})
```

没有 `BuildInput` 或 options builder 公共层，启动时也不创建任何 Provider SDK Client 或 Adapter。
初始配置结构和 Provider 数据库在 IPC 注册、Electron ready 和窗口创建前完成检查；空配置和缺少
凭据仍允许应用启动，真正选中对应模型的 Turn 才会明确失败。
`src/main/index.ts` 的 `startElectronApp(options)` 只消费这些完成的依赖，注册 Session IPC、等待 ready、
管理 activate / window-all-closed，并在每次创建 Runtime 时按 `projectId` 使用
`sessions/<project-id>/<session-id>`。

**Project 固定上下文解析**已接入：`src/main/project-context.ts` 同步读取并检查
`.nicode/workspace.sqlite` 中对应项目的记录，生成包含关联目录、cwd、内置 workspace 和 allowedRoots 的
Workspace Info；每个 Turn 的 baseline 异步读取当前 cwd 下的 `AGENTS.md`，并合并 Global / Project
Skills。每个 `skills/` 直接子目录中的 `SKILL.md` 以 YAML frontmatter 的 `name` 为唯一身份，目录名可以
不同；`registry.json` 的 name 引用 YAML name 并提供 scope / enabled，Project 同名项覆盖 Global，
包括 disabled Project 项屏蔽同名 Global Skill。YAML `description` 进入固定 Skill Context；Token 粗估
暂按 `Math.ceil(text.length / 4)`。MCP Runtime 尚未实现，因此 baseline 的 MCP 列表仍明确为空。

真实 BrowserWindow 使用编译后的 preload 与无框架静态 `src/renderer/index.html`；构建脚本把 HTML
复制到 `dist`。Renderer 保持 `contextIsolation=true`、`nodeIntegration=false`。由于 preload 目前是
未经打包的多文件 CommonJS 输出，窗口暂时显式使用 `sandbox=false`。

**阶段 1（统一模型格式）**已完成类型定义：`runtime/model/src/types.ts` 与 `runtime/error/src/types.ts`。

**阶段 2（网络层与模型错误归一化）**已完成：`runtime/network/src/`（Dispatcher 与重试）与
`runtime/error/src/normalizer.ts`、`abort.ts`。

**阶段 3–5（三个 Protocol Adapter）**已完成：`runtime/model/src/` 下三个协议各自的
Adapter 与 Usage 转换，含流式调用、双向转换、取消与错误归一化接入。

**阶段 6.1（AgentLoop 最小循环）+ 6.4（Tool Call 小轮接线）**已完成：`runtime/agent/src/loop.ts` 的
`runAgentLoop` 跑完「正常模型请求 + 工具调用小轮」这条数据流（Step 生命周期、模型流事件落盘、
`assistant/message`、`tool/result` 关联、工具结果回填 content），`runtime/tools/src/tool-scheduler.ts`
负责工具小轮的串并行调度，配套 `runtime/session/src/events.ts` 提供事件结构与事件出口契约、
`runtime/tools/src/types.ts` 提供统一 `ToolResult` 结构。ToolRegistry、RenderRegistry 与统一
ToolExecutor 调用入口已经实现；真实工具、ToolExposureManager、审批屏障、压缩、Usage 记账、
Insert、文件变更汇总与最终 Surface 仍未实现，见下文。

**SessionRuntime 的活动实例与具体绑定**已提供：`SessionRuntimeBindings` 为单个 Session 绑定目录、
同一写队列中的 Event Log / SessionState、Turn 首批事件原子追加、AGENTS.md / Skill 增量、Event Log
上下文回放以及每 Turn Adapter 工厂 / 执行器；固定基线由 Electron 入口接入的 Project Context resolver 提供，Tool Definition
构建在 ToolExposureManager 落地前返回空数组。`SessionRuntimePorts` 维护运行期 FIFO 用户消息队列和
已持久化事件流。新 Session 保持 Event Log 先于派生文件的提交顺序；显式 Continue 先把请求模型
原子写入 `meta.json`，Queue 则不保存或覆盖模型。两条路径都会在 Turn 真正开始时重新打开
`meta.json`，随后只读打开 `providers.sqlite`，创建只供该 Turn 全部 Step 共用的
新 Adapter。Adapter、CredentialStore、数据库读取结果和 SDK Client 都不跨 Turn 缓存。每个 Turn 会写入最小 `turn/end`，文件变更汇总、
Insert 与最终 Surface 仍未实现。

**Renderer 的四个 Session 命令**已通过 preload 暴露为
`window.nicode.startNewSession(projectId, input)`、
`window.nicode.continueSession(projectId, sessionId, input)` 与
`window.nicode.enqueueSessionMessage(projectId, sessionId, input)`、
`window.nicode.stopSession(projectId, sessionId)`。主进程按 `sessionId` 管理活动实例；
`projectId` 是对应 `sessions/<project-id>` 分组目录的数字身份；前两个入口在
首批事件提交后返回 `{ sessionId, turn }`，追加入口返回 `{ sessionId, content }`，
其中 start 与 continue 输入都包含 `{ content, model }`，enqueue 只包含 `{ content }`。Stop 入口幂等返回
`{ sessionId }`。每个活动 `SessionRuntimePorts` 中的所有 Turn / Loop 共享同一取消信号；
取消后不再消费后续内存 Queue。主进程后台消费
Session 事件流，并预留了 Renderer 事件筛选与发送边界；具体筛选名单和 Renderer wire shape 尚未确定。

尚未开始的模块仍以 `index.ts` 占位；各自文件中注明待实现的职责。

### 三个 Adapter 的内容划分

| 文件 | 职责 |
| --- | --- |
| `runtime/model/src/shared.ts` | 跨协议公共部分：请求校验、文本拼接、tool_call 参数序列化、`runModelStream`（重试 + 错误归一化） |
| `runtime/model/src/usage.ts` | 三个协议的厂商 Usage 字段 → 统一 Usage（第 27 节 / Usage 设计文档） |
| `runtime/model/src/anthropic.ts` | Anthropic Messages：`system` + `messages`（`tool_use` / `tool_result`） |
| `runtime/model/src/chat-completions.ts` | Chat Completions：`messages`（`tool_calls` / `role: "tool"`） |
| `runtime/model/src/responses.ts` | Responses：`instructions` + `input`（`function_call` / `function_call_output`） |
| `runtime/model/src/adapter.ts` | `createModelAdapter(config, options)`：按 `ModelConfig.protocol` 选择实现 |

数据流：AgentLoop → `UnifiedModelRequest` + `AbortSignal` → Adapter（请求转换）→ 官方 SDK
→ 协议流 → Adapter（事件转换）→ `ModelStreamEvent` → AgentLoop。重试与错误归一化统一在
`runModelStream` 内完成，因此 Adapter 抛出的一定是 `AppError`（`source = "model"`）。

三个 Adapter 是**每个 Turn 一个实例**：请求里的 `ModelRef` 会与实例绑定的 `ModelConfig` 校验，
不一致直接以 `INVALID_MODEL_REQUEST`（`source = "runtime"`）失败，不发网络请求。
同一 Turn 的多个 AgentLoop Step 共用该实例；下一个 Turn 即使选择相同 ModelRef 也会重读磁盘并创建
新实例。凭据由该 Turn 新建的 `CredentialStore` 按 providerId 提供后经 `ProtocolClientOptions` 传入。
`CredentialStore` 只提供单项查找，不暴露凭据枚举、修改或持久化入口。

### AgentLoop（阶段 6.1 循环骨架 + 6.4 工具调用接线）

`runAgentLoop(options)` 在一个 Turn 内运行 Step 循环，每个 Step 一次正常模型请求：

```text
content + tools + 本 Turn 固定 ModelRef + AbortSignal
→ adapter.stream()
→ ModelStreamEvent
→ step/start
→ assistant/block_start / block_delta / block_end（同一个块共用一个 blockId）
→ assistant/message（只收录已有 block_end 的块，按 index 排序，携带权威 Usage 与 finishReason）
→ content 原地追加该 assistant 消息
→ 有已结束的 tool_call 块时进入工具小轮：
     把本 Step 的调用按接收顺序组成数组，整批交给 runToolCalls（ToolScheduler 最小形态）
     → 调度器按第 17 节切轮：连续的一段共享只读调用并发跑完，独占工具单独一轮
     → 一轮之内每完成一个就 yield 一个结果
     → 立即写 tool/result（关联 block_end 的 eventId / toolCallId / blockId）
     → 立即把工具结果作为 tool 消息追加到 content
→ step/end
→ 有 Tool Call 则一定进入下一 Step（工具结果必须交还模型），否则结束 Loop
```

- 工具由调用方通过 `executeTool` 注入；具体入口可由 `createExecuteToolCall(toolRegistry, renderRegistry)`
  创建。切轮与串并行调度在 `runtime/tools/src/tool-scheduler.ts`；AgentLoop 不直接读取注册表，
  也不逐个 await。
- `runToolCalls` 是**异步迭代器**，一轮之内交出顺序 = 完成顺序：先结束的调用先落盘、先进入 content，
  不必等最慢的那个（第 16.5 节「完成后即可记录」）。写入顺序与 tool_call 顺序无关，
  配对靠 `toolCallId` 保证（第 8.6 / 11.3 节）。
- 工具自身的失败（含被取消）必须以 `status = "error"` 的 ToolResult 返回，不用抛异常表达 ——
  第 16.4 节要求调度器中尚未启动便被取消的调用同样产出 `AppError(CANCELLED)` 并形成 ToolResult；
  从 `executeTool` 抛出的异常会被当成 Turn 级失败。
- ToolScheduler 目前只实现切轮与调度分组；审批屏障、取消时由调度器直接产出 `CANCELLED` 结果、
  Session 级调度状态都还没实现（见 `runtime/tools/src/tool-scheduler.ts` 文件头）。
- `appendEvent` 返回**已落盘**事件，因为 `tool/result.toolCallEventId` 要指向工具调用块的
  `block_end.eventId`；`seq` 只能由 Event Log 分配，调用方不自行推算。
- SessionRuntime 入口在进入 Loop 前成批提交 `turn/start + user/message`；Loop 退出后提交最小
  `turn/end(completed|stopped|error)`。`turn/file_changes`、`app/error` 与最终 Surface 属于后续收尾实现。
- `blockId` 由 `(turn, step, index)` 决定，不随机生成，便于 Block 修复按同一规则重建。
- Adapter 由调用方用 `createModelAdapter(config, options)` 创建后注入；AgentLoop 不接触凭据与
  Provider 配置，只依赖 `ModelAdapter` 接口。
- 取消：模型流未结束时 Adapter 抛出取消类错误（`CANCELLED`），Loop 写 `step/end(stopped)` 后正常返回；
  工具小轮期间取消时，小轮仍为已产生的每个调用写 `tool/result`，再以 `step/end(stopped)` 关闭 Step
  且不再发起下一次模型请求；其它错误写 `step/end(error)` 后原样抛出，由调用方以 error 终止 Turn。
- Queue 已由单 Session 活动实例按 FIFO 串行处理；Usage 记账（6.3）、Insert（6.5）、压缩（6.2）
  及完整 Turn 收尾（6.6）仍未实现。

### ToolRegistry / ToolExecutor（第 16 节）

`runtime/tools/src/tool-registry.ts` 提供 ToolRegistry、RenderRegistry 和 `registerTool` 成对登记入口；
登记项包含基础模型定义、`builtin | mcp` 来源、参数检查器、业务执行函数与对应结果整理器。
ToolRegistry 拒绝未知内置名称、无实际名称的 `mcp_` 项和重复登记，并按登记顺序提供定义副本。

`runtime/tools/src/tool-executor.ts` 的 `createExecuteToolCall` 创建 AgentLoop 所需的具体执行函数：

```text
工具名 + 未检查参数 + 调用身份
→ 同时查找工具与结果整理器
→ 分离 callDescription
→ 工具自己的参数检查器
→ 取消检查
→ 工具业务函数
→ 工具自己的结果整理器
→ ToolResult
```

- 参数检查失败、工具返回的 AppError、工具执行异常和取消都进入同名结果整理器；不以抛异常表示
  普通工具失败。业务函数只收到业务参数，完整的已检查参数保存在执行上下文中供未来审批使用。
- 未登记工具、缺失结果整理器及结果整理器自身失败使用公共错误结果；模型可见文本只包含稳定错误码
  与说明，不包含堆栈。
- 当前没有登记任何真实工具，`buildTools()` 仍返回空数组；ToolExposureManager、路径和权限检查、
  审批、MCP Dispatcher 及各工具专属实现都不在本阶段。

### ToolScheduler（阶段 6.4，第 17 节）

调度模型是**按模型给出的顺序切轮，逐轮执行**：

```text
从索引 0 开始取调用：
  取到的第一个工具是独占工具 → 它单独一轮，本轮不再取别的
  取到的是共享只读工具       → 继续往后取，直到取完全部或遇到独占工具
一轮内的调用并发执行；一轮全部结束后才开始下一轮
```

因此第 17 节的三条规则都由这两句话推出：连续的一段共享只读调用彼此并发；独占工具永远独占一轮，
所以既不会被前面的共享调用抢先，也不会和后面的共享调用重叠。未登记的工具名（含动态载入的
MCP Tool）按独占处理，默认保守。

共享只读组名单（照第 17 节抄写）：glob / grep / read / terminal_list / skill_load / memory_list /
memory_read / mcp_list_tools。

- `planToolRounds(calls)` 只做切轮，是纯函数；`runToolCalls(calls, execute)` 逐轮驱动执行。
- `runToolCalls` 是**异步迭代器**：一轮之内谁先完成谁先交出 `{ call, result }`，调用方（AgentLoop）
  收到一个就写一条 `tool/result`，先完成的先落盘（第 16.5 节「完成后即可记录」）。交出顺序因此是
  完成顺序，与 tool_call 顺序不同；配对靠 `toolCallId` 保证（第 8.6 / 11.3 节）。
- 调度器只决定谁和谁一轮，实际执行仍由调用方注入的 `execute` 完成（第 17 节要求所有执行走统一
  execute）。若某次调用抛出，本轮其它调用照常跑完，异常在本轮结束时抛出；之前已交出的结果照常生效。
- 审批屏障、取消时由调度器直接为未启动调用产出 `CANCELLED` 结果、Session 级调度状态尚未实现。

## 目录结构

`runtime/` 是架构文档第 30 节「模块边界」的落地位置，每个模块内部再分 `src/` 与 `test/`：

```text
src/                                 Electron 外壳
├─ main/
│  ├─ electron-main.ts               真实 Electron 可执行入口，直接构造 startElectronApp 参数
│  ├─ electron-windows.ts            BrowserWindow 创建、静态页面加载与窗口存活检查
│  ├─ index.ts                       startElectronApp、Project SessionRuntime 工厂与生命周期端口
│  ├─ model-adapters.ts              每 Turn 从 Provider 数据库读取并创建单个模型 Adapter
│  ├─ project-context.ts             workspace、AGENTS.md 与 YAML Skill baseline 解析
│  ├─ token-estimator.ts             Skill / MCP 元信息的本地 Token 粗估
│  ├─ config-files.ts                .nicode 初始化与 V2 全局配置读取
│  ├─ config-schema.ts               全局配置的 V2 字段检查
│  ├─ provider-store.ts              Provider、模型、协议、API Key 与默认模型 SQLite 读写
│  ├─ workspace-store.ts              Project/default 工作区配置的 SQLite 读写
│  └─ session-ipc.ts                 SessionRuntime 的四个 IPC handler
├─ preload/
│  ├─ index.ts                       contextBridge 安装入口
│  ├─ session-api.ts                 window.nicode Session API 与 IPC 契约
│  └─ global.d.ts                    Renderer 的 window.nicode 类型
└─ renderer/index.html               当前无框架的最小静态桌面页面

scripts/
└─ copy-static-assets.mjs            把静态 Renderer HTML 复制到 dist

test/
├─ main/                              配置初始化与 Session IPC 测试
└─ preload/session-api.test.ts        preload Session API 测试

runtime/                             Runtime 模块，各自含 src/ 与 test/
├─ agent/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ loop.ts                     AgentLoop 的 Step 循环与工具小轮（阶段 6.1 / 6.4）
│  │  └─ session-runtime.ts          Session 具体绑定、活动实例与新建/继续 Turn 入口
│  └─ test/                          loop.test.ts / session-runtime.test.ts
├─ context/                          ContextBuilder / WindowManager / Compressor / Recovery / Projector / SurfaceBuilder
├─ model/
│  ├─ src/
│  │  ├─ index.ts                    模块入口（转出以下全部文件）
│  │  ├─ types.ts                    统一模型格式（阶段 1）
│  │  ├─ usage.ts                    厂商 Usage → 统一 Usage
│  │  ├─ shared.ts                   跨协议公共：校验、序列化、重试与错误归一化
│  │  ├─ anthropic.ts                Anthropic Messages Adapter（阶段 3）
│  │  ├─ chat-completions.ts         Chat Completions Adapter（阶段 4）
│  │  ├─ responses.ts                Responses Adapter（阶段 5）
│  │  └─ adapter.ts                  按 protocol 创建 Adapter
│  └─ test/
│     ├─ types.test.ts               阶段 1 验收测试
│     ├─ usage.test.ts               三个协议的 Usage 映射
│     ├─ shared.test.ts              公共层：校验、序列化、重试边界、错误归一化
│     ├─ anthropic.test.ts           / chat-completions.test.ts  / responses.test.ts
│     │                                 每个协议：请求转换、流映射、工具调用、取消、端到端
│     └─ helpers.ts                  三个协议测试共用的假 Provider 服务器
├─ session/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ events.ts                   事件结构与事件出口契约（阶段 6.1 / 6.4：只含 AgentLoop 写出的事件）
│  │  ├─ event-log.ts                共享 events.sqlite 中的对话事件读取与追加
│  │  └─ session-state.ts             对话级 Session 派生文件初始化与恢复
│  └─ test/                          event-log.test.ts / session-state.test.ts
├─ project/                          Project / ProjectManager / ProjectRules
├─ credential/                       只读 CredentialStore 与测试
├─ skill/                            Skill Runtime 本体：SkillManager / SkillContextManager
├─ memory/                           Memory Runtime 本体：MemoryManager
├─ error/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ types.ts                    AppError 与 AppErrorSource（阶段 1）
│  │  ├─ abort.ts                    取消错误识别与构造
│  │  └─ normalizer.ts               底层异常 → AppError
│  └─ test/normalizer.test.ts
├─ network/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ dispatcher.ts               进程级 HTTP Dispatcher（undici Agent + Keep-Alive）
│  │  └─ retry.ts                    自动重试、退避与流式重试边界
│  └─ test/retry.test.ts
└─ tools/                            与工具有关的全部代码
   ├─ src/
   │  ├─ index.ts                    模块入口
   │  ├─ types.ts                    统一 ToolResult、调用上下文与执行函数契约
   │  ├─ tool-registry.ts            ToolRegistry / RenderRegistry 与成对登记
   │  ├─ tool-executor.ts            统一查表、参数检查、执行与结果整理入口
   │  ├─ tool-scheduler.ts           ToolScheduler：工具小轮的串并行调度（阶段 6.4）
   │  ├─ render/                     工具结果渲染器
   │  ├─ present/                    present 工具
   │  ├─ file/                       文件工具本体 glob / grep / read / write / edit
   │  ├─ filesystem/                 RipgrepManager / FileSystem / PathValidator（文件工具共享基础设施）
   │  ├─ shell/                      shell 工具
   │  ├─ terminal/                   PTY 工具与 TerminalState
   │  ├─ mcp/                        MCP 工具接入 mcp_list_tools / mcp_load_tools / tool_search
   │  ├─ skill/                      skill_load 工具
   │  ├─ memory/                     memory_list / memory_read / memory_write 工具
   │  └─ security/                   SandboxPolicy / ApprovalManager（工具权限与审批屏障）
   └─ test/                          注册表、执行入口与调度器的离线测试
```

未开始实现的 `test/` 只有 `.gitkeep` 占位。

两条位置约定：

- 与工具有关的代码统一放在 `runtime/tools/` 下；架构文档第 30 节的目录树只作参考，因此 `runtime/` 顶层没有独立的 `filesystem/` 与 `security/`。
- `skill/` 与 `memory/` 同时出现在两处：`runtime/` 下是 Runtime 本体（Skill / Memory 的存放、状态与治理规则），`runtime/tools/` 下是暴露给模型的那几个工具。二者不合并。

## 源码与测试

每个 Runtime 模块内部按 `src/` 与 `test/` 分开；Electron 外壳的测试则在根目录 `test/` 下镜像：

```text
runtime/model/src/types.ts   →   runtime/model/test/types.test.ts
src/main/config-files.ts     →   test/main/config-files.test.ts
```

- Runtime 源码只在各模块 `src/`，测试只在各模块 `test/`；Electron 外壳源码在根目录 `src/`，测试在根目录 `test/`。
- 测试目录镜像对应源码目录结构，测试文件名与被测文件同名，加 `.test.ts` 后缀。
- 每个模块的类型定义放在该模块的 `src/types.ts`，模块 `src/index.ts` 用 `export * from "./types"` 转出。

## 工程配置

- 全栈 TypeScript，`tsconfig.json` 覆盖 `src/` 与 `runtime/*/src/`，产出到 `dist/`。
- `tsconfig.test.json` 继承前者，额外纳入 `runtime/**/*.ts` 与根目录 `test/**/*.ts` 并关闭产出，供 `npm run typecheck` 使用。
- **相对导入一律带 `.ts` 后缀**（源码与测试都是），由 `allowImportingTsExtensions` 允许、
  `rewriteRelativeImportExtensions` 在产出时改写成 `.js`。这样同一个源文件既能被 Node 直接运行，
  又能被 `tsc` 正常产出，不需要打包器。
- 主进程与 Runtime 暂用 CommonJS 模块输出（`module: CommonJS`）。
- 因为 `module` 是 CommonJS，**测试里不要写顶层 `await`**，改用 `async function main()`.

### 依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `undici` | ^8.10.2 | 进程级 HTTP Dispatcher 与 Keep-Alive（第 7 节） |
| `openai` | ^7.15.0 | Chat Completions 与 Responses 两个协议的官方 SDK |
| `@anthropic-ai/sdk` | ^0.126.0 | Anthropic Messages 协议的官方 SDK |
| `yaml` | ^2.9.1 | 解析每个 `SKILL.md` 开头的 YAML frontmatter |
| `electron`（dev） | ^44.4.3 | 桌面主进程、preload 与 BrowserWindow |
| `typescript`（dev） | ^5.9.3 | 类型检查与产出 |
| `@types/node`（dev） | ^24.13.5 | Node 全局类型 |

`npm start` 先构建 TypeScript 和静态页面，再通过 package 的 `main` 启动 Electron。主进程生命周期
与窗口管理仍保留最小同形端口，离线测试无需启动真实 GUI。

未选 TypeScript 7：TS 7 已移除 `moduleResolution: node10`（本项目配置中的 `"Node"` 即该值），
实测报 `TS5108`，需先调整 `moduleResolution` 才能使用。

## 验证方式

以下都通过才算改好：

```bash
npm run typecheck                                        # tsc，覆盖 src/ 与 runtime/ 全部 .ts
npm run build                                            # 产出到 dist/
node --experimental-strip-types runtime/model/test/types.test.ts
node --experimental-strip-types runtime/model/test/usage.test.ts
node --experimental-strip-types runtime/model/test/shared.test.ts
node --experimental-strip-types runtime/model/test/anthropic.test.ts
node --experimental-strip-types runtime/model/test/chat-completions.test.ts
node --experimental-strip-types runtime/model/test/responses.test.ts
node --experimental-strip-types runtime/error/test/normalizer.test.ts
node --experimental-strip-types runtime/network/test/retry.test.ts
node --experimental-strip-types runtime/tools/test/tool-registry.test.ts
node --experimental-strip-types runtime/tools/test/tool-executor.test.ts
node --experimental-strip-types runtime/tools/test/tool-scheduler.test.ts
node --experimental-strip-types runtime/agent/test/loop.test.ts
node --experimental-strip-types runtime/agent/test/session-runtime.test.ts
node --experimental-strip-types runtime/session/test/event-log.test.ts
node --experimental-strip-types runtime/session/test/session-state.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/credential/test/credential-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/config-files.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/provider-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/workspace-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/model-adapters.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/project-context.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/electron-windows.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/index.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-api.test.ts
```

`test/main/config-files.test.ts` 使用临时用户目录验证：V2 配置与空数据库首次创建、
重复调用保留数据、忽略旧 credentials/workspace JSON、旧 V1 配置报错，以及非法用户目录。
`test/main/provider-store.test.ts` 验证 Provider、模型、密钥、默认模型的读写顺序、
重复初始化、关联删除、事务回滚和损坏数据库错误。
`test/main/workspace-store.test.ts` 验证 Project/default 配置顺序、重复初始化、更新和事务回滚。
Project 配置新增 `updatedAt`，已有数据库在启动时为旧 Project 记录补入升级时间；
对话索引沿用现有 `updatedAt` 字段。两者由工作区写入方提供，当前 Session 流程尚未更新对话索引。

`runtime/credential/test/credential-store.test.ts` 验证空 Store、按 Provider 查找、输入复制、
空字段与重复 Provider 拒绝，以及错误信息不泄露 API Key。

`test/main/model-adapters.test.ts` 验证每 Turn 重读后的模型能力、URL、Headers 与 API Key 热更新，
相同 ModelRef 不复用 Adapter，以及 Provider、Model、协议、凭据缺失时的错误均带
数据库路径且不泄露 API Key。

`runtime/session/test/session-state.test.ts` 验证 `currentModel` 原子写入只修改该字段、每次读取都
重新访问磁盘、外部修改立即可见、损坏或缺失 Meta 带路径失败，以及全局 project/session 写入口与
绑定式 SessionState 共用串行状态边界。

`runtime/agent/test/session-runtime.test.ts` 验证新 Session、显式 Continue 和 Queue 的不同模型时序，
Adapter 失败的事件提交边界、Queue 不覆盖模型、同一 Turn 多 Step 只创建一个 Adapter，以及连续 Turn
按当时磁盘模型分别创建 Adapter。

`test/main/project-context.test.ts` 验证数据库中的 Project 配置、旧 JSON 忽略、项目或
workspace 目录缺失、AGENTS.md、Skill registry 引用及 Project 覆盖。

`test/main/electron-windows.test.ts` 验证 BrowserWindow 参数、preload / Renderer 绝对路径、页面装载
错误出口，以及窗口创建和存活状态。

`test/main/index.test.ts` 使用假 Electron app、ipcMain 与窗口端口验证：四个 Session channel 注册、
不同 Project 的 SessionRuntime 路径与上下文独立装配、后台错误和事件转发、Project Context 失败时
不创建 Session、ready / activate / window-all-closed 生命周期，以及重复注册错误。

三个 Adapter 的测试分两层：**离线转换**（构造协议侧载荷 → 比对统一事件，不碰网络）与
**端到端**（`test/helpers.ts` 起一个本机 SSE 假服务器，真实走一遍官方 SDK）。
端到端覆盖正常流、Usage 转换、取消、可重试/不可重试错误四类路径，日志与网络都不出本机。

AgentLoop 的测试用「按脚本产出统一流事件的假 Adapter」与「按脚本返回 ToolResult 的假工具入口」
驱动 `runAgentLoop`，不碰网络、不实现任何真实工具，覆盖：正常完成（事件顺序、blockId 一致性、
`assistant/message` 内容与 Usage、content 原地更新）、工具小轮（两个调用一成功一失败的执行顺序与
`tool/result` 关联、工具结果作为 `tool` 消息回填 content、随后进入下一 Step）、整批交给调度器
（两个共享只读调用确实并发，且每个一结束就写下自己的 `tool/result`，不必等慢的那个）、未结束的
tool_call 不进消息也不执行、模型流取消、工具小轮期间取消（仍写 `tool/result`，以 `step/end(stopped)`
关闭且不再发起请求）、Adapter 抛错（`step/end(error)` 后原样抛出）。

ToolScheduler 的测试分两层：切轮规则直接比对 `planToolRounds` 的结果（连续共享只读合成一轮、
独占单独一轮、独占前后断开）；执行行为把执行轨迹（`start` / `end`）与消费轨迹（`got`）写进同一条
数组，于是「谁先完成、谁先被交出、下一轮何时开始」都能直接从轨迹读出，不依赖墙钟时间。覆盖共享
只读并发且完成即交出、独占单独一轮、上一轮没结束下一轮不启动（两个方向都测）、空批次、异常传播、
分组名单（含未登记工具按独占处理）。

ToolRegistry / ToolExecutor 测试使用假工具验证成对登记与冲突回滚、名称来源约束、定义副本、
`callDescription` 分离、参数错误、业务 AppError、取消与异常归一化，以及专属结果整理器失败时的
公共错误回退；不访问文件系统或网络。

**不要用 `node --check <文件>.ts` 作为语法检查**：它并不做类型剥离，对 `interface`、
`const x: number = 1` 这类写法会误报 `SyntaxError`，而对函数参数的类型标注又会通过，
结果既不可靠也没有意义。类型问题一律以 `tsc` 为准。

`--experimental-strip-types` 需要 Node 22.6+（本仓库实测于 Node 24.19）。
`package.json` 未声明 `"type"`，Node 按语法自动识别为 ESM 并给出一条
`MODULE_TYPELESS_PACKAGE_JSON` 警告，可加 `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` 屏蔽。

## 尚未确定的决策

以下均需项目负责人决定，确认前不自行选择（详见 `.git/技术文档/开发TODOList.md` 文末「缺口与待确认事项」）：

1. 渲染进程的前端框架、构建与打包工具（因此渲染进程暂不单独配置 `tsconfig`）。
2. 渲染进程与主进程之间的 IPC 协议（第 30 节未定义）。
3. 测试框架（现有测试不依赖框架）。
4. 同一 Provider 配置多种协议时的模型绑定规则；重试次数与退避目前是
   `runtime/network/src/retry.ts` 里的常量，是否加入配置尚未确定。
