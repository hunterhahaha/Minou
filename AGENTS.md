# NiCode 开发规则

`.git/技术文档/开发备忘录1.0.17.md` 是当前项目的架构事实源。
`config.json` 的当前持久化结构见 `.git/技术文档/配置文件结构V2.md`；
Provider、Model、协议参数和 API Key 的原始结构见 `.git/技术文档/Provider数据库结构V1.md`；
本文件下述 Provider 数据库 V2 增量为当前实现依据，V1 文档未同步修改。
`.git/技术文档/配置与凭据文件结构V1.md` 只记录旧格式，不作为当前写入依据。
`workspace.sqlite` 的已确认持久化结构见
`.git/技术文档/工作区配置文件结构V1.md`；该数据库的结构以此文档为准。
Global 与 Project Skill 的 `registry.json` 结构见
`.git/技术文档/Skill管理文件结构V1.md`；该文件的结构以此文档为准。

## 技术栈

全栈使用 TypeScript。

桌面外壳使用 Electron：主进程承载 Runtime（架构文档第 30 节的 `runtime/` 模块边界），渲染进程承载 UI。

开发备忘录第 1 节只规定「浏览器 UI 与本机 Runtime 协作」，未规定进程划分与具体技术选型；上述映射是实现约定，如需调整先与项目负责人确认。

前端使用 React，Renderer 使用 Vite 构建；测试框架尚未确定，不要自行引入。

新增依赖仍需明确授权。

## 前端设计规范与 UI 改造边界

今后所有前端开发任务（包括页面、组件、样式、文案、交互、响应式与前端重构），
开始前必须先阅读 [docs/design-system.md](docs/design-system.md) 和
[docs/ui-roadmap.md](docs/ui-roadmap.md)，再核对相关架构章节与当前代码。

- `docs/design-system.md` 记录 NiCode 的设计 Token、排版、间距、组件、交互、动效、响应式和验证规则，以及 open-claude-ui 的位置与具体参考路径。
- `docs/ui-roadmap.md` 记录可独立完成的改造任务、影响范围、验收标准和完成状态；每次只选择当前明确要求的小任务，完成后据实更新状态与验证记录。
- 设计文档是展示层规范，不取代架构事实源；参考仓库不具有高于 NiCode 规则的效力。发生冲突时先说明，不自行调整架构或业务契约。
- **禁止 UI 改造破坏现有业务逻辑。** 普通视觉任务不得修改后端、Runtime、主进程、preload、IPC、事件处理、业务状态或持久化；不得改变路由身份、发送、停止、队列、审批、模型保存、权限、焦点、输入法、滚动与窗口控制的现有行为。
- 优先修改 CSS。确需修改 TSX 时仅调整必要的展示类和静态结构，保持回调、条件分支、稳定 key、组件身份和状态生命周期，并验证布局没有间接破坏交互。
- 任何必须改变上述逻辑或架构的体验优化，都应另列独立任务说明范围，并等待明确授权；不能作为视觉优化顺带实施。
- 保留已有改动；不直接复制 open-claude-ui 的组件、模拟业务状态或新增依赖，不为了统一视觉引入额外架构层。

## 已落地的启动配置初始化

`src/main/config-files.ts` 是当前唯一的启动配置初始化入口，导出
`initializeConfigFiles(userProfile?)`。它默认使用 `USERPROFILE`，也允许测试传入绝对用户目录。

该函数按开发备忘录第 2–4 节创建 `.nicode`、`skills/`、`sessions/`、`logs/`、
`sessions/default/` 和 `sessions/default/workspace/`，并初始化或检查：

- `.nicode/config.json`
- `.nicode/providers.sqlite`（Provider / Model / API Key）
- `.nicode/workspace.sqlite`（Project / default 工作区配置）

缺失的 `config.json` 按 V2 空配置创建；Provider 数据库首次创建时为空；
工作区数据库缺失时创建，并仅在 default 分组记录不存在时补入空配置。
已有 `config.json` 必须是普通文件，且通过 V2 版本与字段检查；失败时抛出
带路径的错误并保留原文件。校验逻辑在 `src/main/config-schema.ts`。
旧 V1 配置不迁移、不改写；旧 `credentials.json` 不创建、不读取、不删除。
工作区配置只按 Project ID 检查数据库记录是否存在；缺失时报项目损坏，
不再读取或检查旧 `workspace.json`。
Provider、Protocol、Models、凭据与 Skill 管理文件的结构已在上述当前文档中确定；
当前初始化入口会补齐 Global 与已登记 Project 的 `skills/registry.json`，随后扫描实际目录同步；非法 registry 按实际目录整体重建，新条目默认启用。存在检查阶段不校验内容。

Project / default 的 `workspace.sqlite` 保存分组配置与 `sessions` 对话索引；
每个 Project 保存由写入方提供的 `updatedAt` 更新时间；
每个对话索引项保存 `id`、`name`、`createdAt`、`updatedAt`。
工作区数据库不保存 Skill 信息；Global 与 Project 的各自 `skills/` 目录中
分别由 `registry.json` 记录当前目录 Skill 的 `name`、绝对目录 `path`、`scope`、`enabled`。
文件夹名是 Skill 名称，YAML 仅提供 description。对话载入记录按 scope + path 区分，允许同名来源并存；只有新增来源记录产生 Skill 增量通知，已有记录状态变化静默保存。每条 name + description 本地估算最多 500 tokens，总量不限。
全局目录条目的 `scope` 为 `global`，Project 目录条目的 `scope` 为 `project`。

Provider 数据库中每个 Provider 恰好保存一个协议，模型通过 `provider_id` 归属
Provider，不单独保存协议。默认模型记录保存模型 `id`；未设置时选 Provider 与模型
顺序中的第一个模型。API Key 在独立凭据表中按 Provider 保存，不进入普通列表接口。
当前 Provider 数据库版本为 2，不迁移旧库。Provider 的 `type` 必填且仅为 `compatible` 或
`custom`，无默认值。Model 的 `reasoning_levels_json` 与 `reasoning_field_json` 均非空；
Runtime 中分别是非空字符串数组和 `{ path: string[] }`。创建模型时可省略两项，主进程按协议
补入 `low`、`medium`、`high` 和请求路径：Anthropic Messages 为 `output_config.effort`，
Chat Completions 为 `reasoning_effort`，Responses 为 `reasoning.effort`。会话的
`session_meta.current_model_json` 中的模型引用包含必填 `reasoningLevel`；每个 Turn 启动时读取，
并验证该值仍属于模型可选等级。已兼容供应商目录目前为空，目录资料只参与创建。
已兼容供应商按名称与协议联合匹配；列表 IPC `listCompatibleProviders()` 返回
`{ name: string, protocol: Protocol[] }[]`，每个名称只返回一项，协议数组非空且去重；
页面仅展示所选名称兼容的协议。
Sandbox Mode 以对话为作用域，不属于全局 `config.json`。同一 Provider 配置多种协议时的
模型绑定规则尚未确定，不得自行选取协议。

`src/main/electron-main.ts` 在 Electron 启动时显式调用该入口并处理错误。
对应测试位于 `test/main/config-files.test.ts`，运行命令见本文件的「验证方式」。

## 基本原则

不要一次性实现整个系统。

开发必须按照“小模块、小改动、可验证”的方式推进，使项目负责人始终能够理解并掌握当前代码。

除非明确要求，否则：

- 不修改既定架构。
- 不增加新的架构层。
- 不替换已经确定的技术方案。
- 不进行任务范围外的重构。
- 不新增第三方依赖。
- 不提前实现未来可能需要的功能。
- 不为了“更优雅”引入额外抽象。
- 不生成大量暂时不会使用的代码。

如果架构存在无法实现、存在明显冲突或必须进行决策的地方，先指出问题，不要自行选择新的架构方案。

## 每个任务的工作流程

开始修改代码之前：

1. 阅读相关架构章节。
2. 定位现有相关代码。
3. 说明这次要实现什么。
4. 列出预计修改或新增的文件。
5. 简单说明这些文件之间的数据流和调用关系。

然后再开始实现。

单次任务只实现一个明确的子模块或一条明确的数据流。

优先保持修改范围较小；如果一次任务明显需要跨越大量模块，应先拆分任务。

## 修改代码时

优先使用现有接口和模块。

不要顺手修改无关代码。

如果发现其它问题，可以指出，但不要顺便修复。

不要隐藏重要逻辑在复杂工具函数、框架魔法或过度抽象中。

核心流程应该能够直接从代码结构中阅读出来。

对于尚未实现的部分，允许保留清晰的 TODO，而不是为了让代码“看起来完整”而提前实现。

## 注释规范与仅注释任务

TypeScript 代码中的规范注释统一使用 TSDoc 风格的 `/** ... */` 块注释，注释必须描述当前代码的真实行为，不能根据未来计划或推测补充尚未实现的职责。

函数、方法和函数类型至少应说明：

- 函数的功能、处理边界及重要副作用。
- 每个参数的作用；使用 `@param 参数名` 描述参数含义。
- 有返回值时使用 `@returns` 说明返回内容及其状态含义。
- 可能抛出异常时使用 `@throws` 说明异常条件和调用方需要承担的处理责任。

接口、类型别名、类及其公开字段或方法也应补充职责说明；对会影响调用方理解的内部数据结构和校验函数，同样应补充简明注释。注释应优先解释数据流、生命周期、错误边界、持久化关联和参数约束，避免重复显而易见的语法。已有架构章节、接口契约或 TODO 的引用应与当前实现保持一致。

如果任务明确只涉及注释工作（包括新增、修订或规范化 TSDoc/JSDoc）：

- 只允许修改注释内容；不得修改任何代码内容，包括实现、表达式、类型、接口字段、导入导出、字符串、空白格式或文件结构。
- 开始和完成时都必须检查差异，确认代码区域没有变化；发现代码变化时应先还原无关代码变化，再继续交付。
- 在确认差异仅包含注释后，不需要运行测试、构建或类型检查；完成说明中应明确注明本次未执行测试的原因。
- 如果实现注释需要修改代码才能准确表达，必须先将任务视为代码修改任务，说明范围并遵循正常验证要求，不得在“仅注释任务”中顺手修改代码。

## 完成任务以后

必须说明：

1. 修改了哪些文件。
2. 每个文件承担什么职责。
3. 这次实现的完整调用流程。
4. 哪些地方属于关键逻辑。
5. 新增了哪些接口或数据结构。
6. 是否增加了依赖。
7. 是否存在尚未完成的部分。
8. 如何验证本次实现。

代码任务完成后，必须附上本次测试范围，列明已验证的模块与行为、执行方式及结果，以及未覆盖的范围和原因。应区分自动化测试、手工验证、类型检查和构建；未执行的检查不得表述为已通过。

如果进行了架构文档中没有明确规定的设计决策，必须单独列出。

不要只告诉项目负责人“已经完成”。

## 测试原则

每完成一个独立模块，就完成该模块最基本的测试或验证。

重点测试：

- 正常路径
- 明确的错误路径
- 边界条件
- 涉及状态或持久化时的恢复行为

测试用于确认当前模块行为，不为了追求覆盖率大量生成低价值测试。

## 架构变更

实现过程中如果发现架构需要调整：

停止扩大修改范围。

明确说明：

- 当前架构是什么。
- 遇到了什么问题。
- 为什么现有设计无法满足。
- 有哪些可选方案。
- 每种方案会影响哪些模块。

等待项目负责人决定后再修改架构。

## 开发参考与验证

以下内容从原 README 迁入，集中保留实现记录、源码组织、工程约定与验证命令。
实现状态记录可能落后于代码；发生冲突时，以本文件前述规则、当前架构事实源与当前代码为准。
面向使用者的项目介绍与启动说明见 [English README](README.md) 和 [中文 README](README.zh-CN.md)。

## 事实源与规则

| 文件 | 作用 |
| --- | --- |
| `.git/技术文档/开发备忘录1.0.17.md` | 架构事实源 |
| `.git/技术文档/开发TODOList.md` | 实施顺序与阶段范围（当前覆盖「三个 Adapter + AgentLoop」） |
| `.git/技术文档/NiCode_Usage统一设计.md` | **Usage 部分以此为准**，取代备忘录第 27.1、35.2 节的相应内容 |
| `AGENTS.md` | 开发规则与工作流程 |

## 当前状态

### 通用 CLI：Headless Agent Execution Protocol V1

CLI 使用独立 Node 启动入口，直接装配现有配置、模型 Adapter、工具注册、MCP、Skill、Memory 和
EventLog，调用同一个 `runAgentLoop`。每次执行创建一个全新 Run，不接入桌面 IPC、Project 绑定、
历史恢复或消息队列；不改变桌面入口。没有新增依赖。

先构建 CLI，再调用编译入口；包清单的 `bin.nicode` 也指向这个入口：

```powershell
npm run build:cli
node dist/src/cli/main.js run --prompt-file ./task.txt --workspace . --output ./result.json
node dist/src/cli/main.js run --request ./request.json --output ./result.json --format jsonl
node dist/src/cli/main.js run --help
```

安装或链接本地包后可以使用 `nicode run ...`。`npm run cli -- run ...` 也可用于手动调用；
程序需要严格解析 stdout 时直接执行 `nicode` 或 `node`，避免 npm 自己的脚本提示混入输出。
`build:cli` 只运行现有 TypeScript 编译器，不启动 Electron 或 Vite。

两种输入互斥；`--output` 必填，输出父目录必须存在。`--format` 默认 `json`（stdout 一份最终 JSON），
`jsonl` 则输出连续公共事件；两种格式都会原子写入最终结果文件。日志和 Node 诊断使用 stderr。
简单输入中的路径相对启动目录，Request 中的路径相对 Request 文件目录；未指定 workspace 时均使用启动目录。
未知参数、重复参数、未知 JSON 字段、非法版本和显式 null 字段会被拒绝。

Request 示例（MCP 配置路径可省略）：

```json
{
  "version": 1,
  "run_id": "external-task-151",
  "prompt": "检查当前工作区并完成任务",
  "model": "configured-model-id",
  "reasoning_level": "medium",
  "workspace": ".",
  "isolated": { "skill": false, "memory": false, "mcp": false },
  "permissions": {
    "sandbox_mode": "sandbox-full-access",
    "auto_approve": { "groups": ["mcp"], "tools": ["write"] }
  },
  "limits": { "max_steps": 100, "timeout_seconds": 1800 }
}
```

`model` 使用数据库中的稳定 `modelId`，省略时使用有效默认模型；不按展示名匹配。
推理等级省略时取该模型的第一个等级，显式等级必须仍受模型支持。请求不会保存默认模型。
默认最多 100 个 AgentLoop Step、1800 秒；一次 Step 算一步，工具调用不额外计步。
超时覆盖初始化和执行；取消后资源清理宽限为 5 秒。CLI 不额外接入 Session 级上下文压缩。

简单参数对应 `--run-id`、`--model`、`--reasoning-level`、`--workspace`、`--max-steps`、`--timeout`、
`--mcp-config`、`--isolate`、`--sandbox-mode`、`--auto-approve-groups`、`--auto-approve-tools`。
列表使用逗号分隔，例如 `--isolate skill,memory --auto-approve-groups shell,mcp`。

隔离字段 true 表示禁用模块，省略或 false 表示沿用现有配置：

- Skill 禁用时跳过 Global/Project registry 启动扫描，不创建 SkillManager、不注册工具、不加载描述。
- Memory 禁用时不注册记忆工具、不访问记忆文件；启用时复用 default 分组，按工具调用访问正文。
- MCP 禁用时不创建 Manager、不连接服务、不注册发现或远端工具。
- 启用的 Skill 使用 Global 来源；workspace 的 `AGENTS.md` 单独进入固定上下文。

可选 `mcp_config` 指向 `{ "mcpServers": [...] }` JSON 文件，条目使用当前 NiCode MCP 配置结构；
它只替换本次连接配置，不写回全局配置。与 `isolated.mcp=true` 同用时报错，不支持 TOML。
MCP 继续使用现有发现、载入预算和 Catalog 校验；不会启动就向模型暴露全部远端 Schema。
单个 MCP 服务连接失败沿用现有处理：stderr 诊断，其余服务和任务仍可继续。

权限仍使用 `full-access`、`sandbox-full-access`、`sandbox-read-only`，默认 `sandbox-full-access`。
文件允许根为 workspace 和本次 `tool_output`；Shell/Terminal 的初始 cwd 为 workspace。
自动批准**只在现有规则触发审批后生效**：命中组或精确工具名立即批准，未命中立即拒绝，取消后为 cancelled。
它不隐藏工具，也不阻止原本无需审批的调用。工具组为 `file`、`shell`、`terminal`、`mcp`、`skill`、`memory`；
远端 MCP 身份依注册元数据判断，不用名称前缀。`full-access` 不触发的审批也不会被名单额外拦截。
现有 Shell/Terminal 使用 PowerShell 7，需要本机 `pwsh`；没有增加 Bash 后端或操作系统沙箱。

每次 Run 使用内部 UUID，在 `.nicode/logs/cli/<session_id>/` 保存独立 `events.sqlite` 和工具输出。
外部 `run_id` 仅关联结果，不作为目录，也不创建桌面对话索引。内部日志可以包含模型思考与完整工具内容，
仅供本地诊断；公共事件采用白名单，排除 thinking、工具参数/结果正文、SDK 错误载荷和凭据配置。
`answer` 是模型生成的公开文本，不能保证它不会复述输入或工具内容中的敏感信息。

公共 JSONL 信封为：

```json
{"version":1,"seq":1,"type":"run.started","run_id":"external-task-151","session_id":"uuid","data":{}}
```

事件包括 `run.started`、`step.started`、`message.delta`、`message.completed`、`tool.started`、
`tool.completed`、`approval.resolved`、`step.completed`、`run.finished`。
`tool.started` 表示调度到执行入口（包含参数/权限检查阶段），不表示已经发起业务副作用。
公共 seq 独立连续递增；`run.finished.data.result` 与结果文件相同。
stdout 写入会等待回调以处理背压；写入失败或 5 秒内无法处理将停止运行，不无限缓存事件。

Result 包含 `version`、`run_id`、`session_id`、`status`、`stop_reason`、`model`、`answer`、
`answer_complete`、`record_directory`、`metrics` 和可选的稳定 `error`。
回答取最后一条 Assistant Message 的文本；停止时保留已有文本，但 `answer_complete=false`。
工具失败/拒绝仍通过既有 ToolResult 返回模型，不直接让 Run 失败。

指标依据已提交事件汇总：`steps` 为已开始 Step 数，`tool_calls` 包括被拒绝或失败的完整工具调用。
`metrics.usage` 使用 snake_case 的统一桶（`input_tokens` 是未缓存输入），可选字段未报告时不补零。
`usage_complete` 表示是否所有已开始 Step 都报告了权威 Usage；`usage_reported_steps` 给出报告数量，
`usage_scope=reported_agent_requests` 表明不覆盖不可观测的失败重试账单用量。完全未报告时 usage 为 null。

| 情况 | status / stop_reason | 退出码 |
| --- | --- | ---: |
| 模型正常结束 | completed / finished | 0 |
| 输入或模型选择无效 | failed / invalid_request | 2 |
| Step 耗尽 | stopped / max_steps | 10 |
| 总超时 | stopped / timeout | 124 |
| SIGINT / SIGTERM | stopped / interrupted | 130 |
| 模型未完成或完成状态未知 | stopped / model_incomplete | 1 |
| 初始化、运行、输出异常 | failed / error | 1 |

结果先写同目录独占临时文件再重命名，失败保留已有文件并返回 1。
SIGINT/SIGTERM 通过现有取消信号和资源释放处理；Windows 外部强制终止或不可捕获的终止无法保证结果写入。

CLI 验证命令 `npm run test:cli` 会先编译，再运行协议测试和真实 Node 子进程集成测试；
测试使用临时用户目录、本机假模型和 MCP 服务，不访问用户配置或真实模型网络。
集成验证覆盖权限、隔离、MCP、输出、超时以及真实 PowerShell / PTY，需允许创建本机进程。

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
Provider 数据库当前为 V2，旧版本启动时拒绝且保留原文件。Provider 必填 `type`，值为
`compatible` 或 `custom`；模型必填推理等级列表与 `{ path: string[] }` 请求字段路径。
创建模型可省略这两项，默认等级是 `low`、`medium`、`high`，Anthropic Messages 默认路径为
`output_config.effort`，Chat Completions 为 `reasoning_effort`，Responses 为 `reasoning.effort`。
供应商创建 IPC 分为已兼容和自定义两种；已兼容目录本次为空，可在
`src/main/compatible-providers.ts` 中加入经过确认的资料。`listCompatibleProviders()` 返回
`{ name: string, protocol: Protocol[] }[]`，每个名称一项，同名资料的协议合并为去重数组；
创建时仍按名称与选中的单个协议联合匹配。页面按名称展示供应商，
协议选项仅包含该名称兼容的协议，切换供应商时清除不受支持的旧协议。
自定义模型创建和编辑采用逗号分隔等级、点分字段路径与 JSON 预览，不引入 YAML 或 CEL。

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
Skills。每个 `skills/` 直接子目录的文件夹名是 Skill 名称，`SKILL.md` 的 YAML
frontmatter 提供 description。来源目录内的 `registry.json` 保存 name、绝对目录 path、scope、enabled；
启动先补齐目录与空文件，再扫描同步，非法配置整体重建。每个 Turn 前也同步当前来源。
Project 的同名条目覆盖 Global，包括以 disabled 状态屏蔽 Global。每条 `name + description`
按 `Math.ceil(text.length / 4)` 粗估最多 500 tokens，名称完整、只截断描述，总量不限。
对话 Meta 按 scope + path 保存载入过的来源，允许同名记录并存；只有新增来源记录才写 Skill
增量通知，禁用、删除、重新启用和切回已有来源只静默更新状态。普通 Turn 使用已保存固定基线加
已提交增量。`SessionRuntime.reloadSkills()` 可完整重载；Summary 的 `summary/end` 保存完整 AGENTS.md / Skills 基线，并据此恢复派生文件。
`skill_load` 每次按实时来源配置检查权限，再返回完整 SKILL.md（含 frontmatter），不截断正文。
default 分组仅使用 Global Skill。Project baseline 不读取 Session 的 MCP 载入状态；MCP 定义由 SessionRuntime 在每次模型请求前从 Meta 和全局 Catalog 组合。

设置弹窗的「技能」页面按来源管理 Global 与各 Project 自己的全部技能，包括禁用项。
列表展示文件夹名、完整 description、绝对路径和启停开关；单条 SKILL.md 或描述无效时只显示该条错误，仍可禁用。
Workspace 持有以 `global` / `project:<UUID>` 为键的 React 字典，首次查看才通过 `listSkills(target)` 请求，
关闭设置与工作区路由切换保留缓存，空列表也缓存；刷新或失败重试仅请求当前来源，不轮询、不预取。
`setSkillEnabled(target, name, enabled)` 在共享 SkillManager 的来源串行队列内读取最新 registry 并原子保存，
后端确认后才更新前端开关。保存失败保留原状态；后端不另存技能内存字典，default 不设独立技能来源。
两个 IPC 分别为 `nicode:skill:list` 与 `nicode:skill:set-enabled`；Project 请求必须对应数据库已登记且目录存在的项目。

真实 BrowserWindow 使用编译后的 preload 与 Vite 构建的 React `src/renderer/index.html`；
页面启动时通过 `window.nicode` 并行读取 Project、default 对话及 Provider 摘要，显示 default 新聊天首屏。
首屏按 Figma 工作区原型支持侧栏收起与展开、项目和聊天分组折叠、项目索引折叠，以及权限和模型弹层选择。
窗口使用无系统边框模式，由 Renderer 的 42px 顶部栏绘制最小化、最大化 / 还原和关闭按钮。
关闭按钮按产品约定最小化到任务栏，保留窗口和后台任务；窗口控制通过独立的
`window.nicodeWindow` 窄接口完成，不修改既有业务 IPC。主进程只操作请求来源窗口的主 frame，
系统触发的最大化 / 还原也会同步标题栏按钮。
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
Summary 压缩已接通，见下文；Usage 展示扩展、Insert 与最终 Surface 等仍按各自模块推进。

**Project Memory 三件套**已实现：`memory_list` 只返回分类索引，`memory_read` 按二级分类读取，
各分类按创建时间从新到旧排序，`limitPerSection` 独立限制每个分类，省略时返回全部。
`memory_write` 整批追加，自动创建缺少的标题并记录毫秒精度的 UTC ISO 创建时间。
记忆保存于 `.nicode/sessions/<project-id>/memory.md`，default 使用自己的文件；缺失时读取为空，
首次有效写入才创建。同一 Project 的所有 Session 共用启动时创建的 MemoryManager 写入队列，
通过同目录临时文件替换一次提交。格式损坏时报工具错误并保留原文件，不自动修复。
多行正文和闭合的代码围栏可以保存，围栏外的一级/二级标题或记录时间标记会被拒绝。
三件工具的成功数据经专属 render 转为文本；记忆正文不会默认进入 System Message，
也不产生文件变更记录或沙盒文件审批。保存哪些知识由模型侧提示词指导，Runtime 不做语义分类。

**SessionRuntime 的活动实例**按 Session 创建，直接持有目录、Event Log / SessionState、
Turn 首批事件提交、AGENTS.md / Skill 增量、上下文回放、FIFO 用户消息队列和持久化事件流。
启动时创建的同一个 SessionRuntimeGlobal 为所有实例提供 Project Context、每 Turn Adapter、
工具定义和统一工具执行能力。Electron 入口向模型提供六个文件工具及三件记忆工具的定义。
新 Session 保持 Event Log 先于派生状态的提交顺序；所有 Session Meta 保存在
`.nicode/meta.sqlite`，由 Project ID 与 Session ID 联合定位。模型、沙盒模式、Usage、Skills 和额外 Meta
各占独立 JSON 列，名称独立存列，初始为“新对话”。`session_meta.current_model_json` 的模型引用
包含所选 `reasoningLevel`。显式 Continue 只提交内容；它与 Queue 都在 Turn 真正开始时读取 Meta，
并校验当前模型仍支持该等级，随后只读打开 `providers.sqlite`，创建只供该 Turn 全部 Step 共用的
新 Adapter。Adapter、CredentialStore、数据库读取结果和 SDK Client 都不跨 Turn 缓存。每个 Turn 在
`turn/end` 前写入有净变化时的 `turn/file_changes`；Insert 与最终 Surface 仍未实现。

**Renderer 与 SessionRuntime 接线**已完成。Session 命令通过 preload 暴露为
`window.nicode.startNewSession(projectId, input)`、
`window.nicode.continueSession(projectId, sessionId, input)` 与
`window.nicode.enqueueSessionMessage(projectId, sessionId, input)`、
`window.nicode.stopSession(projectId, sessionId)`。主进程按 Project ID 与 Session ID 的组合管理活动实例；
`projectId` 是对应 `sessions/<project-id>` 分组目录的 UUID 字符串，default 分组使用 `"default"`；前两个入口在
首批事件提交后返回 `{ sessionId, turn }`，追加入口返回 `{ sessionId, messageId, content }`；
Queue 提交用户事件时复用该 messageId。start 输入接受可选 sandboxMode，continue 与 enqueue
都只包含 `{ content }`。Stop 入口幂等返回
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

**Shell 与 PTY 工具**已实现：`shell` 使用一次性 PowerShell 7，等待 stdout/stderr 关闭并返回实际退出码，
非零退出码仍是命令结果。`terminal_open`、`terminal_input`、`terminal_close`、`terminal_list`
提供按 Project + Session 隔离、跨 Turn 和 Runtime 活动期复用的真实 Windows ConPTY。
本机需安装 PATH 可找到的 `pwsh` 及其 PSReadLine；没有后端或就绪失败时返回工具错误。
PTY 后端在 PSConsoleHostReadLine 接受命令后发出开始标记，prompt 发出相同执行序号的完成标记。
终端就绪后为 idle，命令开始后为 running，只有对应完成标记才恢复 idle；超时、无输出和
发送 Ctrl+C 均不推断命令已经结束。此实际状态规则采用项目负责人本轮决定，替代备忘录第 23–24 节的默认 unknown。

`terminal_input.input` 原样写入，提交命令需包含回车 `\r`；空字符串仅拉取未读输出。
每次最多收集 3 秒，明确完成标记或进程退出可提前结束。Windows ConPTY 的晚到屏幕文本
仍归下一次收集，不追加到已返回结果；模型可继续用空输入轮询。
Stop 向当前聊天全部活动 PTY 各发送一次 Ctrl+C 并保留终端，后台监听继续更新状态。
正常 Turn 完成、模型失败与 Runtime 关闭不重置终端；显式关闭和应用退出等待实际进程退出。
自然退出的终端从活动列表移除，尚未读取的尾部仍可用空输入取完。

两类工具共用 `ToolOutputStore`：64 KB 按 65,536 原始字节计算，小输出不创建文件；
超限输出完整保存为 Session `tool_output/call_<tool-call-id>.log`，模型只接收 UTF-8 尾部、
总字节数及绝对日志路径。未读 PTY 积压超限时使用内部临时文件，交付时转换为本次调用日志。
日志不覆盖既有结果；已返回内容不重复。完整日志读取仍遵循现有文件工具沙箱规则。
shell 与 PTY 修改工具在两个 Sandbox 模式下都需顺序审批，Full Access 直接执行；
`terminal_list` 无需审批。进程工具不向文件写工具的变更追踪器添加 Shell/PTY 文件改动。

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
- Queue 已由单 Session 活动实例按 FIFO 串行处理；Usage 展示扩展（6.3）、Insert（6.5）
  及完整 Turn 收尾（6.6）仍未实现。

### Summary 压缩

每一步写入 `step/start` 前检查最近正常模型请求的完整输入 Token（含缓存输入），使用同一 Turn
模型配置快照的 `C = contextWindow`、`O = maxOutputTokens`，阈值为
`min(C * 0.8, C - O - (10000 + O))`。达到阈值时直接调用当前 Adapter，保留最新 AGENTS.md / Skills、
完整消息和工具定义，末尾追加 compact prompt 原文。提示词随代码构建发布，运行时不读取 `.git`。
压缩请求设置 `tool_choice=none`，没有工具执行器；任何返回的工具调用、非正常结束或空正文均视为失败。

压缩先写 `summary/start`，再独立调用模型，成功后写配对的 `summary/end`。两者使用同一 `summaryId`、
`fromEventSeq` 和 `throughEventSeq`；只有 end 携带正文、可选 Usage 和完整 AGENTS.md / Skills 基线。
end 落盘后才更新派生状态和内存上下文。只有 start 的失败或取消尝试在恢复时忽略。首次覆盖起点为首个历史 Step，
没有 Step 时使用首个有效输入消息；再次压缩继承旧起点。终点包含当前输入对应的最新事件，
也包含新 Turn 首步前的本轮用户消息。回放遮蔽终点及以前的全部事件，只插入最新 Summary，
保留终点之后的有效消息。原日志和 UI 历史保留，MCP 载入身份、预算和工具快照不因压缩清空。

固定基线版本使用 `summary/end` 的 eventId，后续普通 Skill 增量只推进比较游标。恢复从最新已完成 Summary
基线及覆盖终点后的增量重建状态，不让旧增量覆盖新基线。压缩 Usage 不参与正常 Agent 统计或下次触发判断。
失败不创建 Step；已提交 Summary 后派生状态更新失败可在下次打开恢复。用户取消按 stopped 收尾。
本模块不增加依赖、旧双事件迁移、分段/递归压缩或额外业务重试。

正常请求的 `assistant/message.usage` 落盘后立即幂等同步 SQLite Meta Usage；每次 `step/end`
落盘后再次同步，确保该 Step 发布结束及下一步阈值检测前 Meta 已更新。没有报告 Usage 的 Step
保留最近已知正常 Usage，压缩 Usage 不参与该统计。同步失败保留权威事件并终止 Turn，下次从日志恢复。

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

- Electron 入口同时登记三件记忆工具与专属 render；它们通过 Runtime 注入的 projectId
  访问当前分组的 memory.md，不接受模型指定的身份或路径，也不使用文件工具审批。

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

## MCP 配置与工具调用

应用启动时使用配置初始化快照中的 `mcpServers`，通过一个全局 `MCPManager` 建立连接、获取完整工具目录、构建 BM25 索引并管理实际调用。没有配置 Server 时目录为空，三个发现工具仍可使用。单个 Server 失败会记录稳定错误，其他 Server 和应用继续启动。

`config.json` 示例（仍使用 V2，不自动迁移旧 MCP 字段）：

```json
{
  "version": 2,
  "mcpServers": [
    {
      "name": "local-tools",
      "transport": "stdio",
      "enabled": true,
      "command": "node",
      "args": ["C:/tools/mcp-server.js"],
      "cwd": "C:/tools",
      "env": { "EXAMPLE_MODE": "development" },
      "startup_timeout_sec": 10,
      "tool_timeout_sec": 60
    },
    {
      "name": "remote-tools",
      "transport": "streamable-http",
      "enabled": true,
      "url": "https://example.com/mcp",
      "bearer_token_env_var": "MCP_TOKEN",
      "http_headers": { "X-Custom-Header": "value" }
    }
  ],
  "runtime": { "userMessageMode": "queue" }
}
```

`name`、`transport`、`enabled` 必填；STDIO 的 `command` 和 HTTP 的 `url` 必填。两个超时可省略，运行时分别使用 10 秒和 60 秒；启动时限包含连接和首次完整工具目录。超时需为计时器可表示的有限正数秒。STDIO 使用 SDK 默认继承环境，再合并显式 `env`，不额外继承全部宿主变量。Bearer 从宿主环境读取；变量不存在或为空仅让该 Server 初始化失败。配置 Bearer 时不能同时在 `http_headers` 中提供任何大小写的 Authorization。HTTP 使用 `http_headers`，旧 `headers` 字段会被拒绝。同名配置以后项为准，禁用项不建立连接。

模型优先使用 `tool_search` 检索并自动载入，搜索不到时使用 `mcp_list_tools` 查看轻量名称，再将返回名称传给 `mcp_load_tools`。检索文档仅含 Server 名称、工具名称和描述，统一通用分词，最多载入八个匹配项。wink 要求至少三个索引文档，因此少于三个工具时加入无词元空占位；占位不会成为搜索结果。

载入状态属于各 Session，保存在共享 `meta.sqlite` 的 `additional_meta_json.loadedMcpTools` 中；不增加表。每次请求依据当前 Catalog 过滤有效定义，并修复 `contextstate.mcp`，从下一 Step 向模型暴露新载入工具。预算使用当前 Turn 同一模型配置快照的 `contextWindow × 5%` 和现有本地 Token 估算；按最久未调用顺序清理，单批自身超过预算仍整批载入。工具定义持有稳定的 `mcp_` 名称和独立的远端身份，不通过解析名称路由。

真正调用继续经过统一执行器、Schema 检查、Session 审批与 SDK 取消信号；只有 Full Access 直接执行。其他模式使用已有审批事件。SDK 原始返回由 MCP render 只保留顶层文本，非文本不进入 ToolResult；业务错误保留远端文本并标为 `MCP_TOOL_CALL_ERROR`。目录变更通知更新全局目录及成对注册；断开连接的工具不再暴露。应用退出释放 MCP 连接和 STDIO 子进程。

在设置弹窗的 **MCP** 页面可以新增、修改、改名、启用或删除连接。STDIO 提供有序参数、工作目录及多行环境变量，Streamable HTTP 提供 URL、Bearer 环境变量名及多行请求头；可选超时留空时继续使用后端默认值。参数和值中的空白、空字符串按原输入保存；通过页面或 IPC 新建与改名时名称必须唯一。每次显式保存整份配置，主进程先原子写入 `config.json.mcpServers`，再同步启动时创建的同一个 Manager；其他普通配置字段保留。未变化的 Server 继续复用连接，修改项重启，禁用或删除项立即失效并关闭。连接失败仍保留已保存配置，页面展示稳定错误；输入或文件写入失败不会改变当前连接。

**刷新** 会重读并校验配置，关闭现有连接，再连接全部启用项，重建工具目录、搜索索引和注册信息。损坏配置在关闭连接前报告；旧资源清理失败时阻止替代实例启动，已保存配置不会回滚，可修复后再次刷新。变更立即影响正在执行的 MCP 调用，失败调用不会自动重放。旧连接的异步目录结果不会覆盖新连接；下一次模型请求沿用现有 Session 有效工具过滤机制。

preload 增加 `listMcpServers`、`createMcpServer`、`updateMcpServer(originalName, config)`、`deleteMcpServer` 和 `reloadMcpServers` 五个窄接口，使用 `nicode:mcp:*` 固定 channel。主进程串行处理完整配置操作，返回配置、连接状态、工具数量及错误快照，不向页面提供 Client、Transport 或解析后的 Bearer Token。当前没有应用级自动重连。

新增本地验证命令（HTTP 只监听 127.0.0.1，STDIO 使用仓库测试进程，不需要外部 MCP 服务）：

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/mcp/test/manager.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/session/test/mcp-state.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/agent/test/mcp-turn.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/mcp/test/lifecycle.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/mcp/test/in-flight.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/agent/test/mcp-reconfigure.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/mcp-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/mcp-api.test.ts
```

生命周期测试验证实际连接次数、其他连接复用、改名、禁用、完整重载、旧目录通知和清理失败后的重试；进行中调用测试验证立即中断、不重放及审批/持久化间隙的重新检查。Session 测试验证下一请求的失效工具过滤、新 Schema 与 `contextstate.mcp` 同步。IPC 测试覆盖两种配置、并发写入、重名、可选字段清除、配置损坏、真实文件写入失败与恢复；preload 测试验证固定 channel、参数和非法快照拒绝。

构建后可按下文「验证方式」的隐藏窗口启动方式运行 `test/renderer/electron-mcp-settings.test.cjs`。
它使用临时用户目录和本机测试服务验证真实页面的多值编辑、重开回显、启用、改名、删除、刷新、失败恢复、忙碌保护、窄窗口和模型设置回归，截图保存在 `dist/electron-mcp-settings-preview.png` 与 `dist/electron-mcp-settings-narrow-preview.png`。此测试不连接真实第三方 MCP 服务。

## 目录结构

`runtime/` 是架构文档第 30 节「模块边界」的落地位置，每个模块内部再分 `src/` 与 `test/`：

```text
src/                                 Electron 外壳
├─ main/
│  ├─ electron-main.ts               真实 Electron 可执行入口，直接构造 startElectronApp 参数
│  ├─ electron-windows.ts            BrowserWindow 创建、静态页面加载与窗口存活检查
│  ├─ index.ts                       startElectronApp、Project SessionRuntime 工厂与生命周期端口
│  ├─ model-adapters.ts              每 Turn 从 Provider 数据库读取并创建单个模型 Adapter
│  ├─ project-context.ts             workspace、AGENTS.md 与共享 SkillManager 的 baseline 接线
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
├─ skill/                            Skill Runtime：来源管理、来源身份和单条元信息截断
├─ memory/                           MemoryManager：Markdown 分类、按需读取与整批追加；含存储测试
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
| `node-pty` | 1.1.0 | Windows ConPTY 原生后端，使用包内当前平台预编译模块 |
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
node --experimental-strip-types runtime/context/test/summary.test.ts
node --experimental-strip-types runtime/agent/test/summary-turn.test.ts
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
node --experimental-strip-types runtime/memory/test/memory.test.ts
node --experimental-strip-types runtime/tools/test/memory-tools.test.ts
node --experimental-strip-types runtime/skill/test/skill.test.ts
node --experimental-strip-types runtime/skill/test/management.test.ts
node --experimental-strip-types runtime/tools/test/skill-tools.test.ts
node --experimental-strip-types runtime/agent/test/skill-turn.test.ts
node --experimental-strip-types test/main/skill-startup.test.ts
node --experimental-strip-types runtime/tools/test/process-output.test.ts
node --experimental-strip-types runtime/tools/test/shell-tools.test.ts
node --experimental-strip-types runtime/tools/test/terminal-tools.test.ts
node --experimental-strip-types runtime/tools/test/pty-real.test.ts
node --experimental-strip-types runtime/agent/test/loop.test.ts
node --experimental-strip-types runtime/agent/test/session-runtime.test.ts
node --experimental-strip-types runtime/agent/test/file-turn.test.ts
node --experimental-strip-types runtime/agent/test/memory-turn.test.ts
node --experimental-strip-types runtime/agent/test/process-turn.test.ts
node --experimental-strip-types runtime/session/test/event-log.test.ts
node --experimental-strip-types runtime/session/test/session-state.test.ts
node --experimental-strip-types runtime/session/test/file-changes.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/credential/test/credential-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/config-files.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/provider-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/provider-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/workspace-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/project-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/skill-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/model-adapters.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/project-context.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-runtime-global.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/file-access.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/electron-windows.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/window-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/window-api.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/index.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-ipc.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-api.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/skill-api.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/preload/session-updates.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/session-connection.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/renderer/session-state.test.ts
```

`test/main/config-files.test.ts` 使用临时用户目录验证：V2 配置与空数据库首次创建、
重复调用保留数据、忽略旧 credentials/workspace JSON、旧 V1 配置报错，以及非法用户目录。

`runtime/memory/test/memory.test.ts` 验证分类、正文及代码块读回、跨时区时间排序、独立 limit、
Project 隔离、同分组并发追加、取消、损坏文件及提交失败后的恢复。
`runtime/tools/test/memory-tools.test.ts` 验证模型 Schema、指定提示词原文、参数错误和成功/错误 render；
`runtime/agent/test/memory-turn.test.ts` 使用离线模型和真实存储验证 default/Project 的新对话、Queue、
Continue、工具事件关联和模型结果回填，并检查记忆未默认注入 System Message。

`test/main/provider-store.test.ts` 验证 Provider、模型、密钥、默认模型的读写顺序、
重复初始化、模型名称更新、关联删除、事务回滚和损坏数据库错误。
`test/main/provider-ipc.test.ts` 验证 Provider 与模型创建时生成全局唯一模型身份、模型名称规范化、
新增模型的 IPC 返回值、名称更新与无效模型输入；同时验证默认模型 IPC 的持久化、
非法或不匹配引用拒绝、失败保留原值，以及清空选择后的顺序回退。
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

`runtime/agent/test/session-runtime.test.ts` 验证新 Session、显式 Continue 和 Queue 读取 Meta 的不同时序，
Adapter 失败的事件提交边界、Queue 不覆盖模型、同一 Turn 多 Step 只创建一个 Adapter，以及连续 Turn
按当时磁盘模型分别创建 Adapter。

`test/main/project-context.test.ts` 验证数据库中的 Project 配置、旧 JSON 忽略、项目或
workspace 目录缺失、AGENTS.md、文件夹 Skill 身份、损坏 registry 重建及 Project 覆盖。

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

进程工具新增测试分别验证输出阈值与 UTF-8 尾部、真实 Shell 退出码与取消、可控 PTY 标记及输出归属、
真实 PowerShell PTY 交互与自然退出，以及 Session 的 Queue / Continue / Stop 和模型结果回填。
`test/main/electron-process-tools.test.cjs` 验证当前 Electron 能实际加载 node-pty 并执行上述后端；
构建后用下方相同的隐藏窗口启动方式，将测试参数替换成该文件即可运行。
`test/preload/session-updates.test.ts` 验证新增传输契约、联合身份、监听隔离与取消监听。

构建后可运行真实 Electron 的隐藏窗口测试（只使用临时数据和本机假模型）：

```powershell
npm run build
$testProcess = Start-Process -FilePath (Join-Path (Get-Location) 'node_modules/electron/dist/electron.exe') -ArgumentList 'test/renderer/electron-session.test.cjs' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput 'dist/electron-session.stdout.log' -RedirectStandardError 'dist/electron-session.stderr.log'
Get-Content dist/electron-session.stdout.log
Get-Content dist/electron-session.stderr.log
$testProcess.ExitCode
```

同样的隐藏窗口启动方式可运行 `test/renderer/electron-default-model.test.cjs`。
该测试使用临时数据库与真实 preload / IPC，验证新聊天切换模型后自动保存全局默认值、
保存期间阻止重复切换和按钮 / Enter 发送、失败保留原模型并允许重试、页面重载恢复，
以及首条消息携带成功保存的模型；不访问真实模型网络。

同样的隐藏窗口启动方式可运行 `test/renderer/electron-skill-settings.test.cjs`。
该测试使用临时用户目录、真实 SkillManager 与 IPC，通过请求次数验证按需加载、空列表缓存、
关闭重开及路由切换后缓存保留、仅刷新当前来源，并覆盖描述错误、启停落盘、保存确认前保持原值、
加载/保存失败重试、请求期间的导航与关闭保护、键盘操作和窄窗口无横向溢出。
测试截图写入 `dist/skill-settings-wide.png` 与 `dist/skill-settings-narrow.png` 供视觉检查。

工作台改版的交互验证使用同样的隐藏窗口启动方式运行
`test/renderer/electron-workspace-design.test.cjs`。测试通过真实 preload 与离线 IPC 夹具验证：
摘要搜索与空结果、键盘导航、首次打开才读取历史、缓存命中、草稿保留、Project 入口、
浅色 / 深色主题恢复、设置分区入口与弹窗比例、焦点及窄窗口无横向溢出。
另外验证输入框单行起步、随内容增长、到上限后内部滚动、清空收缩，
并通过真实窗口验证自绘最小化、最大化 / 还原、系统状态同步和关闭仅最小化。
测试使用独立临时用户目录，不读取现有用户数据或访问模型网络，
并生成 `dist/workspace-*.png`，覆盖首页、项目、对话、搜索、模型、MCP、技能和创建项目。

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

Skill 后端验证分工：`runtime/skill/test/skill.test.ts` 覆盖来源同步、原子替换失败、配置损坏、
单条截断与 Global/Project 隔离；`runtime/tools/test/skill-tools.test.ts` 覆盖 Schema、实时禁用、
未找到、取消及完整正文 render；`runtime/agent/test/skill-turn.test.ts` 使用离线模型和真实存储
验证 Queue/Continue、同名来源并存、静默状态、事件先提交后的恢复与完整重载。
`test/main/skill-startup.test.ts` 验证全部已登记 Project 的启动补齐，Project IPC 测试只增加
已有创建入口调用后端初始化后的目录断言。
`runtime/skill/test/management.test.ts` 覆盖单来源管理、描述失败隔离、不截断展示描述、
并发扫描/启停、原子替换失败保留原配置和后续恢复；`test/main/skill-ipc.test.ts` 与
`test/preload/skill-api.test.ts` 验证来源身份、项目登记、参数、返回快照及持久化。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **NiCode** (3110 symbols, 8613 relationships, 274 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/NiCode/context` | Codebase overview, check index freshness |
| `gitnexus://repo/NiCode/clusters` | All functional areas |
| `gitnexus://repo/NiCode/processes` | All execution flows |
| `gitnexus://repo/NiCode/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
