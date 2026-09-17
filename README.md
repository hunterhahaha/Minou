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

**阶段 1（统一模型格式）**已完成类型定义：`runtime/model/src/types.ts` 与 `runtime/error/src/types.ts`。

**阶段 2（网络层与模型错误归一化）**已完成：`runtime/network/src/`（Dispatcher 与重试）与
`runtime/error/src/normalizer.ts`、`abort.ts`。

**阶段 3–5（三个 Protocol Adapter）**已完成：`runtime/model/src/` 下三个协议各自的
Adapter 与 Usage 转换，含流式调用、双向转换、取消与错误归一化接入。

其余 `index.ts` 仍是占位文件，只含模块职责与对应章节的说明，不导出实现。尚未实现的模块在各自 `index.ts` 里以「尚未实现」列出。

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

## 目录结构

`runtime/` 是架构文档第 30 节「模块边界」的落地位置，每个模块内部再分 `src/` 与 `test/`：

```text
src/                                 Electron 外壳
├─ main/index.ts                     主进程入口（占位）
└─ renderer/index.ts                 渲染进程入口，UI（前端框架未定）

runtime/                             Runtime 模块，各自含 src/ 与 test/
├─ agent/
│  ├─ src/                           AgentLoop / SessionRuntime / UserMessageScheduler
│  └─ test/
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
├─ session/                          SessionEvent / SessionEventLog / SessionState / TurnFileChangeTracker
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
   │  ├─ index.ts                    ToolRegistry / RenderRegistry / ExposureManager / Executor / Scheduler / OutputStore
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
   └─ test/                          与 src/ 子目录一一对应
```

未开始实现的 `test/` 只有 `.gitkeep` 占位。

两条位置约定：

- 与工具有关的代码统一放在 `runtime/tools/` 下；架构文档第 30 节的目录树只作参考，因此 `runtime/` 顶层没有独立的 `filesystem/` 与 `security/`。
- `skill/` 与 `memory/` 同时出现在两处：`runtime/` 下是 Runtime 本体（Skill / Memory 的存放、状态与治理规则），`runtime/tools/` 下是暴露给模型的那几个工具。二者不合并。

## 源码与测试

每个模块内部按 `src/` 与 `test/` 分开，同一模块的源码与测试放在一起：

```text
runtime/model/src/types.ts   →   runtime/model/test/types.test.ts
```

- 源码只在 `src/`，测试只在 `test/`，不混放。
- `test/` 镜像 `src/` 的子目录结构，测试文件名与被测文件同名，加 `.test.ts` 后缀。
- 每个模块的类型定义放在该模块的 `src/types.ts`，模块 `src/index.ts` 用 `export * from "./types"` 转出。

## 工程配置

- 全栈 TypeScript，`tsconfig.json` 覆盖 `src/` 与 `runtime/*/src/`，产出到 `dist/`。
- `tsconfig.test.json` 继承前者，额外纳入各模块 `test/` 并关闭产出，供 `npm run typecheck` 使用。
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
```

三个 Adapter 的测试分两层：**离线转换**（构造协议侧载荷 → 比对统一事件，不碰网络）与
**端到端**（`test/helpers.ts` 起一个本机 SSE 假服务器，真实走一遍官方 SDK）。
端到端覆盖正常流、Usage 转换、取消、可重试/不可重试错误四类路径，日志与网络都不出本机。

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
4. `config.json` 的 Provider / Protocol / Models 配置结构（TODOList 缺口 3）—— 重试次数与退避
   目前是 `runtime/network/src/retry.ts` 里的常量，待该结构确定后再考虑是否做成可配置。
