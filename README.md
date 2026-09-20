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
`config.json`、`credentials.json`、`skills/`、`sessions/`、`logs/` 与
`sessions/default`。新建 `config.json` 和 default `workspace.json` 使用 V1 空配置，
`credentials.json` 使用文档允许的 `{}`。已有文件按 V1 检查版本、字段与引用关系，
失败时保留原文件并抛出带路径的错误。Electron 启动
生命周期尚未实现，因此当前只导出入口，未自动调用。

**阶段 1（统一模型格式）**已完成类型定义：`runtime/model/src/types.ts` 与 `runtime/error/src/types.ts`。

**阶段 2（网络层与模型错误归一化）**已完成：`runtime/network/src/`（Dispatcher 与重试）与
`runtime/error/src/normalizer.ts`、`abort.ts`。

**阶段 3–5（三个 Protocol Adapter）**已完成：`runtime/model/src/` 下三个协议各自的
Adapter 与 Usage 转换，含流式调用、双向转换、取消与错误归一化接入。

**阶段 6.1（AgentLoop 最小循环）+ 6.4（Tool Call 小轮接线）**已完成：`runtime/agent/src/loop.ts` 的
`runAgentLoop` 跑完「正常模型请求 + 工具调用小轮」这条数据流（Step 生命周期、模型流事件落盘、
`assistant/message`、`tool/result` 关联、工具结果回填 content），`runtime/tools/src/tool-scheduler.ts`
负责工具小轮的串并行调度，配套 `runtime/session/src/events.ts` 提供事件结构与事件出口契约、
`runtime/tools/src/types.ts` 提供统一 `ToolResult` 结构。工具本体与 ToolExecutor、审批屏障、
压缩、Usage 记账、Insert / Queue、Turn 收尾仍未实现，见下文。

**SessionRuntime 的两个入口框架**已提供：`runtime/agent/src/session-runtime.ts` 导出
`startNewSession` 与 `continueSession`。首次入口先创建目录，再成批提交
`turn/start + user/message`；继续入口先修复 Session、做 Turn 开始增量检查，再提交下一 Turn。
两者随后构建一次 content 并调用现有 `runAgentLoop`。`createRepairSession` 提供第 10 节的
Event Log 校验与确定性补写，可绑定为 `SessionRuntimePorts.repairSession`；
`createFileSessionRepairPorts` 按单个 `sessionId + sessionDirectory` 装配 Event Log I/O 与派生状态修复，
ContextBuilder 及 Loop 运行资源仍由 ports 注入。入口在批次提交成功后返回 `sessionId`、`turn` 和
`completion` Promise。

**Renderer 的两个 Session 命令**已通过 preload 暴露为
`window.nicode.startNewSession(input)` 与 `window.nicode.continueSession(sessionId, input)`。
preload 只允许调用两个固定 IPC channel；主进程校验输入后调用上述 SessionRuntime 入口，立即向
Renderer 返回可序列化的 `{ sessionId, turn }`，并在主进程继续观察后台 `completion`。
Electron 窗口与主进程启动生命周期仍未装配。

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

三个 Adapter 是**每个模型一个实例**：请求里的 `ModelRef` 会与实例绑定的 `ModelConfig` 校验，
不一致直接以 `INVALID_MODEL_REQUEST`（`source = "runtime"`）失败，不发网络请求。
凭据由 `CredentialStore` 按 providerId 提供后经 `ProtocolClientOptions` 传入。

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

- 工具由调用方通过 `executeTool` 注入（第 16.4 节统一 execute 的边界形态），切轮与串并行调度在
  `runtime/tools/src/tool-scheduler.ts`；AgentLoop 自己不做调度判断，也不逐个 await。
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
- SessionRuntime 入口在进入 Loop 前成批提交 `turn/start + user/message`；Loop 退出后的
  `turn/end` 与 `app/error` 属于后续 Turn 收尾实现。
- `blockId` 由 `(turn, step, index)` 决定，不随机生成，便于 Block 修复按同一规则重建。
- Adapter 由调用方用 `createModelAdapter(config, options)` 创建后注入；AgentLoop 不接触凭据与
  Provider 配置，只依赖 `ModelAdapter` 接口。
- 取消：模型流未结束时 Adapter 抛出取消类错误（`CANCELLED`），Loop 写 `step/end(stopped)` 后正常返回；
  工具小轮期间取消时，小轮仍为已产生的每个调用写 `tool/result`，再以 `step/end(stopped)` 关闭 Step
  且不再发起下一次模型请求；其它错误写 `step/end(error)` 后原样抛出，由调用方以 error 终止 Turn。
- Usage 记账（6.3）、Insert / Queue（6.5）、压缩（6.2）、Turn 收尾（6.6）仍未实现。

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
│  ├─ index.ts                       主进程入口，导出启动配置与 IPC 注册函数
│  ├─ config-files.ts                .nicode 目录与文件初始化
│  ├─ config-schema.ts               三份启动配置的 V1 字段检查
│  └─ session-ipc.ts                 SessionRuntime 的两个 IPC handler
├─ preload/
│  ├─ index.ts                       contextBridge 安装入口
│  ├─ session-api.ts                 window.nicode Session API 与 IPC 契约
│  └─ global.d.ts                    Renderer 的 window.nicode 类型
└─ renderer/index.ts                 渲染进程入口，UI（前端框架未定）

test/
├─ main/                              配置初始化与 Session IPC 测试
└─ preload/session-api.test.ts        preload Session API 测试

runtime/                             Runtime 模块，各自含 src/ 与 test/
├─ agent/
│  ├─ src/
│  │  ├─ index.ts                    模块入口
│  │  ├─ loop.ts                     AgentLoop 的 Step 循环与工具小轮（阶段 6.1 / 6.4）
│  │  └─ session-runtime.ts          新建和继续 Session 的 Turn 入口框架
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
│  │  ├─ event-log.ts                对话级 events.jsonl 读取与恢复事件追加
│  │  └─ session-state.ts             对话级 Session 派生文件初始化与恢复
│  └─ test/                          event-log.test.ts / session-state.test.ts
├─ project/                          Project / ProjectManager / ProjectRules
├─ credential/                       CredentialStore
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
   │  ├─ types.ts                    统一 ToolResult 与内容块（阶段 6.4）
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
   └─ test/                          tool-scheduler.test.ts；其余与 src/ 子目录一一对应
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
| `typescript`（dev） | ^5.9.3 | 类型检查与产出 |
| `@types/node`（dev） | ^24.13.5 | Node 全局类型 |

Electron 依赖和窗口启动装配仍未落地；preload 入口只在 Electron 环境中读取其提供的
`contextBridge` / `ipcRenderer`，离线测试使用同形最小接口，不新增依赖。

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
node --experimental-strip-types runtime/tools/test/tool-scheduler.test.ts
node --experimental-strip-types runtime/agent/test/loop.test.ts
node --experimental-strip-types runtime/agent/test/session-runtime.test.ts
node --experimental-strip-types runtime/session/test/event-log.test.ts
node --experimental-strip-types runtime/session/test/session-state.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/config-files.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-api.test.ts
```

`test/main/config-files.test.ts` 使用临时用户目录验证：首次创建、重复调用时保留有效内容、
缺失文件补齐、V1 有效配置、字段与引用错误、损坏文件保留，以及非法用户目录。

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
