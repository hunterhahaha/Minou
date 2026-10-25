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
对应测试位于 `test/main/config-files.test.ts`，运行命令见 README 的「验证方式」。

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
