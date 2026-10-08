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
`BrowserWindow`，依次初始化并首次校验配置文件、初始化全局 Network Dispatcher、Tool / Render
Registry，并创建一个进程级 SessionRuntimeGlobal，随后逐字段调用：

```ts
const sessionRuntimeGlobal = new SessionRuntimeGlobal(paths, toolRegistry, renderRegistry)
await startElectronApp({
  app,
  ipcMain,
  windows,
  configPaths: paths,
  sessionRuntime: {
    systemPrompt: "You are an AI agent powered by NiCode.",
    global: sessionRuntimeGlobal,
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
暂按 `Math.ceil(text.length / 4)`。default 分组仅使用 Global Skill。MCP Runtime 尚未实现，因此 baseline 的 MCP 列表仍明确为空。

真实 BrowserWindow 使用编译后的 preload 与 Vite 构建的 React `src/renderer/index.html`；
页面启动时通过 `window.nicode` 并行读取 Project、default 对话及 Provider 摘要，显示 default 新聊天首屏。
首屏按 Figma 工作区原型支持侧栏收起与展开、项目和聊天分组折叠、项目索引折叠，以及权限和模型弹层选择。
窗口使用 40px 标题栏覆盖层，保留系统窗口控制按钮。
模型摘要包含当前有效默认模型标记。Renderer 保持 `contextIsolation=true`、`nodeIntegration=false`。由于 preload 目前是
未经打包的多文件 CommonJS 输出，窗口暂时显式使用 `sandbox=false`。
权限与模型选择目前只影响当前页面展示；首屏尚不发送消息，也不读取历史对话内容。

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
ToolExecutor 调用入口以及 glob、grep、read、write、edit、present 六个文件工具与 render 已实现；
ToolExposureManager、压缩、Usage 记账、Insert 与最终 Surface 仍未实现，见下文。

**SessionRuntime 的活动实例**按 Session 创建，直接持有目录、Event Log / SessionState、
Turn 首批事件提交、AGENTS.md / Skill 增量、上下文回放、FIFO 用户消息队列和持久化事件流。
启动时创建的同一个 SessionRuntimeGlobal 为所有实例提供 Project Context、每 Turn Adapter、
工具定义和统一工具执行能力。Electron 入口向模型提供六个文件工具的定义。
新 Session 保持 Event Log 先于派生状态的提交顺序；所有 Session Meta 保存在
`.nicode/meta.sqlite`，由 Project ID 与 Session ID 联合定位。模型、沙盒模式、Usage、Skills 和额外 Meta
各占独立 JSON 列，名称独立存列，初始为“新对话”。显式 Continue 先把请求模型写入 Meta，Queue 则不保存或覆盖模型。
两条路径都会在 Turn 真正开始时重新读取 Meta，随后只读打开 `providers.sqlite`，创建只供该 Turn 全部 Step 共用的
新 Adapter。Adapter、CredentialStore、数据库读取结果和 SDK Client 都不跨 Turn 缓存。每个 Turn 在
`turn/end` 前写入有净变化时的 `turn/file_changes`；Insert 与最终 Surface 仍未实现。

**Renderer 与 SessionRuntime 接线**已完成。Session 命令通过 preload 暴露为
`window.nicode.startNewSession(projectId, input)`、
`window.nicode.continueSession(projectId, sessionId, input)` 与
`window.nicode.enqueueSessionMessage(projectId, sessionId, input)`、
`window.nicode.stopSession(projectId, sessionId)`。主进程按 Project ID 与 Session ID 的组合管理活动实例；
`projectId` 是对应 `sessions/<project-id>` 分组目录的 UUID 字符串，default 分组使用 `"default"`；前两个入口在
首批事件提交后返回 `{ sessionId, turn }`，追加入口返回 `{ sessionId, messageId, content }`；
Queue 提交用户事件时复用该 messageId。start 输入接受可选 sandboxMode，continue 输入包含
`{ content, model }`，enqueue 只包含 `{ content }`。Stop 入口幂等返回
`{ sessionId }`。每个活动 `SessionRuntime` 中的所有 Turn / Loop 共享同一取消信号；
取消后不再消费后续内存 Queue，并在最终控制状态中保留未发送项供重试。

`getSessionData(projectId, sessionId)` 返回摘要、完整原始事件、latestSeq 与控制快照；
活动实例只读快照，非活动实例先执行现有恢复再读取并关闭临时实例。
`onSessionUpdate(listener)` 订阅 event / state / error 三类更新并返回取消监听函数；
preload 隔离 Electron 事件对象。主进程将已成功提交的原始事件发给存活窗口，单窗发送失败
只交给宿主错误出口，不改变 Runtime 结果。控制状态包含 revision、throughSeq、设置、活动状态、
待处理 Queue 与被丢弃的消息；同一对话的查询、继续和设置短操作串行执行。

工作区持有 `WorkspaceSessionState`，其 `sessionEventsByKey` 使用
`JSON.stringify([projectId, sessionId])` 索引 `SessionEvent[]`。
**聊天路由命中字典键时直接渲染，不调用历史查询 IPC。** 缺键才复用或创建首载请求；
未加载历史的后半段增量暂存，新对话从 seq=1 的推送可直接建缓存。历史与增量按 eventId 去重、
seq 排序，迟到结果合并到自己的对话；状态只在 throughSeq 已取得后按较新 revision 应用。
加载失败可明确重试，缓存的事件缺口会补查；草稿跨路由保留。

`updateSessionSettings` 保存 Session Meta 的模型与权限 patch，不影响当前 Turn 的固定模型，
随后 Turn 启动时重读；工具按既有机制重读权限。
`decideSessionApproval` 接收 approved / denied，结束或重复审批返回 accepted=false；
Stop 通过既有机制持久化 cancelled。页面提供气泡、流式正文、可展开 Thinking / 工具 / 文件变化、
审批按钮、Queue 与停止操作。assistant/message 替换同一 Turn / Step 的流式展示。
原始事件仍是展示来源。前端收到 `turn/end` 后按 Turn 重组展示，历史加载使用相同规则：
用户消息保持独立展示，其余内容收入默认折叠的“执行过程”区域，并保留内部 Thinking / 工具等小折叠区域。
仅 `completed` 将该 Turn 最后一条权威 `assistant/message` 的全部 text 块放入外部 final answer div，
过程 details 与 final answer div 共用一个父 div；无正文时不向前寻找替代回答，也不创建空正文区。
`stopped` / `error` 将全部助手内容收入过程区域，结束状态文字保留在过程内部。
没有 `turn/end` 时保持现有逐事件展示；该投影不改写缓存或事件。完整后端 SurfaceBuilder 尚未实现，Queue 不跨重启保存。
Assistant 的 text 与 thinking 块统一通过 `MarkdownContent({ text })` 渲染，最终回答复用相同组件。
组件使用 `react-markdown` 与 `remark-gfm`，支持标准 Markdown、表格、任务列表和删除线；
正文随流式文本更新重新解析，原始事件内容保持不变，HTML 沿用库默认的转义展示。

Project 管理通过 `window.nicode.selectDirectory()`、`createProject(name, directories?)`、
`addProjectDirectory(projectId, directory)` 与 `removeProjectDirectory(projectId, directory)` 暴露。
目录选择取消时返回 `null`；创建项目返回不含对话的 Project 摘要。目录增删返回
`{ success: true }` 或 `{ success: false, error }`，传入的关联路径必须是现存绝对目录。
工作区数据库时间统一保存为 UTC 的 ISO 8601 字符串。

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
- SessionRuntime 入口在进入 Loop 前成批提交 `turn/start + user/message`；Loop 退出后先提交存在净变化的
  `turn/file_changes`，再提交 `turn/end(completed|stopped|error)`。`app/error` 与最终 Surface 属于后续收尾实现。
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
- Electron 入口登记六个文件工具与专属 render，并把定义交给每 Turn 模型调用；工具执行时重读
  Session Meta 和 Project Workspace 数据库，按沙箱模式检查规范路径。审批请求写入 Event Log 并等待
  决定或 Stop；Renderer 已通过请求事件显示批准/拒绝按钮，并显示已持久化的审批结果。

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
│  ├─ session-runtime-global.ts      进程级 Project、模型与工具能力
│  ├─ token-estimator.ts             Skill / MCP 元信息的本地 Token 粗估
│  ├─ config-files.ts                .nicode 初始化与 V2 全局配置读取
│  ├─ config-schema.ts               全局配置的 V2 字段检查
│  ├─ provider-store.ts              Provider、模型、协议、API Key 与默认模型 SQLite 读写
│  ├─ workspace-store.ts              Project/default 工作区配置的 SQLite 读写
│  └─ session-ipc.ts                 SessionRuntime 命令、历史与更新推送
├─ preload/
│  ├─ index.ts                       contextBridge 安装入口
│  ├─ session-api.ts                 window.nicode Session API 与 IPC 契约
│  └─ global.d.ts                    Renderer 的 window.nicode 类型
└─ renderer/                         React 新聊天首屏、样式与 HTML 入口

vite.config.mts                       Renderer 静态资源构建到 dist/src/renderer
tsconfig.renderer.json                Renderer TSX 类型检查
scripts/dev-electron.mjs              启动 Vite HMR 与 Electron 开发窗口

test/
├─ main/                              配置初始化与 Session IPC 测试
└─ preload/session-api.test.ts        preload Session API 测试

runtime/                             Runtime 模块，各自含 src/ 与 test/
├─ agent/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ loop.ts                     AgentLoop 的 Step 循环与工具小轮（阶段 6.1 / 6.4）
│  │  └─ session-runtime.ts          单 Session 活动实例、新建/继续 Turn 与恢复
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
- `tsconfig.test.json` 继承前者，额外纳入 `runtime/**/*.ts` 与根目录 `test/**/*.ts` 并关闭产出；
  `tsconfig.renderer.json` 单独检查 React TSX。两者都由 `npm run typecheck` 执行。
- **相对导入一律带 `.ts` 后缀**（源码与测试都是），由 `allowImportingTsExtensions` 允许、
  `rewriteRelativeImportExtensions` 在产出时改写成 `.js`。这样同一个源文件既能被 Node 直接运行，
  又能被 `tsc` 正常产出，不需要打包器。
- 主进程与 Runtime 暂用 CommonJS 模块输出（`module: CommonJS`）；Renderer 由 Vite 构建为本地 HTML、JS 与 CSS。
- 因为 `module` 是 CommonJS，**测试里不要写顶层 `await`**，改用 `async function main()`.

### 依赖

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `undici` | ^8.10.2 | 进程级 HTTP Dispatcher 与 Keep-Alive（第 7 节） |
| `openai` | ^7.15.0 | Chat Completions 与 Responses 两个协议的官方 SDK |
| `@anthropic-ai/sdk` | ^0.126.0 | Anthropic Messages 协议的官方 SDK |
| `yaml` | ^2.9.1 | 解析每个 `SKILL.md` 开头的 YAML frontmatter |
| `@vscode/ripgrep` | 1.18.0 | 提供当前平台的 ripgrep 二进制，不查系统 PATH |
| `diff` | 9.0.0 | 计算 Turn 文件变化的三行上下文 diff |
| `electron`（dev） | ^44.4.3 | 桌面主进程、preload 与 BrowserWindow |
| `typescript`（dev） | ^5.9.3 | 类型检查与产出 |
| `@types/node`（dev） | ^24.13.5 | Node 全局类型 |

`npm start` 构建 TypeScript 和静态页面，再通过 package 的 `main` 启动 Electron。
前端开发使用 `npm run dev`：命令先编译 Electron 主进程与 preload，再启动 Vite 开发服务器和 Electron；
开发窗口通过 `loadURL` 载入 Vite 页面，React 与 CSS 修改由 Vite HMR 即时更新。主进程或 preload 修改后需重新运行该命令。
主进程生命周期与窗口管理仍保留最小同形端口，离线测试无需启动真实 GUI。
文件工具只从 `@vscode/ripgrep` 的平台包解析 `rg`。当前工程尚无安装包构建器；以后打包时须将
目标平台可执行文件保留在可直接执行的位置，不能仅放入不可直接执行的 `asar` 内容。

未选 TypeScript 7：TS 7 已移除 `moduleResolution: node10`（本项目配置中的 `"Node"` 即该值），
实测报 `TS5108`，需先调整 `moduleResolution` 才能使用。

## 验证方式

以下都通过才算改好：

```bash
npm run typecheck                                        # 主进程、Runtime、测试与 Renderer TSX
npm run build                                            # tsc 与 Vite 产出到 dist/
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
node --experimental-strip-types runtime/tools/test/file-tools.test.ts
node --experimental-strip-types runtime/agent/test/loop.test.ts
node --experimental-strip-types runtime/agent/test/session-runtime.test.ts
node --experimental-strip-types runtime/agent/test/file-turn.test.ts
node --experimental-strip-types runtime/session/test/event-log.test.ts
node --experimental-strip-types runtime/session/test/session-state.test.ts
node --experimental-strip-types runtime/session/test/file-changes.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/credential/test/credential-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/config-files.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/provider-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/provider-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/workspace-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/project-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/model-adapters.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/project-context.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-runtime-global.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/file-access.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/electron-windows.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/index.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-api.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-updates.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-connection.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/renderer/session-state.test.ts
```

`test/main/config-files.test.ts` 使用临时用户目录验证：V2 配置与空数据库首次创建、
重复调用保留数据、忽略旧 credentials/workspace JSON、旧 V1 配置报错，以及非法用户目录。
`test/main/provider-store.test.ts` 验证 Provider、模型、密钥、默认模型的读写顺序、
重复初始化、模型名称更新、关联删除、事务回滚和损坏数据库错误。
`test/main/provider-ipc.test.ts` 验证 Provider 与模型创建时生成全局唯一模型身份、模型名称规范化、
新增模型的 IPC 返回值、名称更新与无效模型输入。
`test/main/workspace-store.test.ts` 验证 Project/default 配置顺序、重复初始化、更新和事务回滚。
Project 配置新增 `updatedAt`，已有数据库在启动时为旧 Project 记录补入升级时间；
对话索引沿用现有 `updatedAt` 字段。首批事件、用户消息与 Turn 结束后从已提交日志核对索引，
摘要列表返回前也核对中断；名称优先使用有效 Meta，并保留现有名称。索引失败不撤销已提交对话。

`runtime/credential/test/credential-store.test.ts` 验证空 Store、按 Provider 查找、输入复制、
空字段与重复 Provider 拒绝，以及错误信息不泄露 API Key。

`test/main/model-adapters.test.ts` 验证每 Turn 重读后的模型名称与能力、URL、Headers 与 API Key 热更新，
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

`test/main/index.test.ts` 使用假 Electron app、ipcMain 与窗口端口验证：Session channel 注册、
不同 Project 的 SessionRuntime 路径与上下文独立装配、后台错误和事件转发、Project Context 失败时
不创建 Session、ready / activate / window-all-closed 生命周期，以及重复注册错误。

`test/main/session-connection.test.ts` 使用真实临时 SQLite 与 SessionRuntime 验证活动查询不恢复、
运行中设置生效时机、相同文本 Queue 的独立 ID/FIFO、Stop 未发送项、三种审批结果与重复决定、
索引中断修复、重启后读取，以及索引/窗口发送失败不撤销已提交数据。
`test/renderer/session-state.test.ts` 用 Node 断言验证缓存命中不查询、首载复用与增量合并、
历史增量暂存、旧状态不覆盖新版本、缺口补齐、失败重试、独立草稿以及权威正文替换流式块；
同时覆盖 Turn 完成态分组、多段最终正文、停止 / 失败、无最终正文、多轮隔离及历史 / 增量一致性。
`test/preload/session-updates.test.ts` 验证新增传输契约、联合身份、监听隔离与取消监听。

构建后可运行真实 Electron 的隐藏窗口测试（只使用临时数据和本机假模型）：

```powershell
npm run build
$testProcess = Start-Process -FilePath (Join-Path (Get-Location) 'node_modules/electron/dist/electron.exe') -ArgumentList 'test/renderer/electron-session.test.cjs' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput 'dist/electron-session.stdout.log' -RedirectStandardError 'dist/electron-session.stderr.log'
Get-Content dist/electron-session.stdout.log
Get-Content dist/electron-session.stderr.log
$testProcess.ExitCode
```

该测试验证实际 React 页面新建、Queue、流式正文、Turn 完成后的父容器与正文位置、
内外层折叠交互、后续事件保持展开、不同对话的折叠状态隔离、跨路由缓存和草稿保留；
另外通过已有事件推送通道验证停止、失败及无最终正文的页面结构。
Markdown 断言覆盖思考内容、空块、流式语法补齐、标题 / 列表 / 代码 / 表格 / 任务列表、
HTML 转义、URL 默认处理和长代码块滚动，并生成 `dist/electron-markdown-preview.png`。
新建后反复返回缓存路由的历史 IPC 调用计数保持为 0，并将页面截图保存到
`dist/electron-session-preview.png`。窗口推送测试同时验证多窗口广播与单窗失败隔离。

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

1. 测试框架（现有测试不依赖框架）。
2. 同一 Provider 配置多种协议时的模型绑定规则；重试次数与退避目前是
   `runtime/network/src/retry.ts` 里的常量，是否加入配置尚未确定。
