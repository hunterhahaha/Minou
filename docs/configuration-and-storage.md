# NiCode 配置与持久化

本文依据 2026-10-30 当前配置类型、校验器、SQL 建表语句和读写实现整理。数据库字段以对应源码为核对入口；本文不是修改格式或新增迁移的授权。

## 用户目录与启动初始化

桌面入口调用 [initializeConfigFilesSnapshot](../src/main/config-files.ts)，默认要求 `USERPROFILE` 是绝对路径。CLI 传入 `USERPROFILE`，未设置时回退到 Node 用户主目录。所有数据集中在其下的 `.nicode`。

```text
.nicode/
├─ config.json                    全局普通配置 V2
├─ providers.sqlite               Provider、Model、API Key 与默认模型
├─ workspace.sqlite               Project/default 分组、关联目录、对话索引
├─ meta.sqlite                    桌面对话 Meta
├─ events.sqlite                  桌面对话共享事件日志
├─ skills/
│  ├─ registry.json               Global Skill 登记
│  └─ <skill-name>/SKILL.md
├─ sessions/
│  └─ <project-id 或 default>/
│     ├─ workspace/               分组内置工作目录
│     ├─ memory.md                首次有效写入时创建
│     ├─ skills/                  Project 来源；default 使用 Global
│     │  ├─ registry.json
│     │  └─ <skill-name>/SKILL.md
│     └─ <session-id>/
│        ├─ contextstate.json
│        ├─ agents_md.snapshot
│        └─ tool_output/
└─ logs/
   └─ cli/<session-id>/
      ├─ events.sqlite            单次 CLI Run 的独立日志
      └─ tool_output/
```

这是各功能实际使用位置的汇总，不表示首次启动会生成所有文件。启动补齐根目录、默认 workspace、空配置和数据库；已登记 Project 的 Skill 来源也会初始化并扫描。会话派生文件、项目记忆和 CLI 运行目录由对应功能按需生成。CLI 隔离 Skill 时通过 `skipSkills` 跳过来源初始化、扫描和同步。

既有 `config.json` 必须是普通文件并通过 V2 校验，失败时保留原文件并报告路径。当前启动不迁移旧全局 JSON、旧 Provider 库、`credentials.json` 或 `workspace.json`。各存储对已有数据的检查与修复范围并不相同，不能假定所有数据库都会在启动时完整校验。

## config.json V2

默认内容：

```json
{
  "version": 2,
  "mcpServers": [],
  "runtime": { "userMessageMode": "queue" }
}
```

当前顶层只允许 `version`、`mcpServers`、`runtime`。`runtime` 只允许 `userMessageMode`，校验器接受 `insert` 或 `queue`；桌面对话目前实际使用运行中消息队列，不能从该枚举推断 Insert 流程已完成。模型、API Key、默认模型和对话 Sandbox Mode 不存放在这里。

### MCP 条目

| 字段 | 类型与边界 |
| --- | --- |
| `name` | 必填非空字符串 |
| `transport` | `stdio` 或 `streamable-http` |
| `enabled` | 必填布尔值 |
| `startup_timeout_sec` | 可选有限正数，换算毫秒后不得超过计时器范围；Manager 默认 10 秒 |
| `tool_timeout_sec` | 同上；Manager 默认 60 秒 |
| STDIO 的 `command` | 必填非空字符串 |
| STDIO 的 `args`、`env`、`cwd` | 可选字符串数组、字符串字典、非空字符串 |
| HTTP 的 `url` | 必填绝对 HTTP(S) URL |
| HTTP 的 `http_headers` | 可选字符串字典；不接受旧 `headers` 字段 |
| HTTP 的 `bearer_token_env_var` | 可选环境变量名；不能同时在 headers 中配置任何大小写的 Authorization |

STDIO 环境使用 SDK 默认环境加显式 `env`。HTTP Bearer 在连接时从宿主环境读取，变量缺失或为空会使该服务连接失败。MCPManager 对同名输入以后项为准；设置 IPC 在创建、改名时另行要求名称唯一。设置保存串行执行，先原子替换配置，再同步同一个 Manager；连接失败不撤销已保存配置。刷新重读配置后重建连接，可能中断正在运行的调用。

源码：[config-schema.ts](../src/main/config-schema.ts)、[config-files.ts](../src/main/config-files.ts)、[mcp-ipc.ts](../src/main/mcp-ipc.ts)、[MCPManager](../runtime/mcp/src/manager.ts)。

## providers.sqlite

由 [provider-store.ts](../src/main/provider-store.ts) 使用 `node:sqlite` 管理，当前 `PRAGMA user_version = 3`，表使用 STRICT。

| 表 | 当前列 |
| --- | --- |
| `providers` | `id`、`position`、`name`、`type`、`protocol`、`base_url`、`default_headers_json` |
| `models` | `id`、`name`、`provider_id`、`position`、`context_window`、`max_output_tokens`、`supports_reasoning`、`reasoning_levels_json`、`reasoning_field_json` |
| `provider_credentials` | `provider_id`、`api_key` |
| `provider_settings` | 固定单行 `id = 1`、`default_provider_id`、`default_model_id` |

每个 Provider 恰好一个协议，`type` 必须为 `compatible` 或 `custom`。Model 通过外键属于 Provider，协议不单独存 Model。模型稳定 ID 与 API 请求使用的 `name` 分离；默认模型通过 Provider + Model ID 定位，未设置时按 Provider / Model 顺序回退。

模型窗口与最大输出必须为正整数。模型必须显式声明 `supportsReasoning` 布尔能力，数据库以 `supports_reasoning` 的 0/1 非空列保存。创建输入与内置模板中的推理配置可选；无论能力开关是否开启，写库前都会补齐非空推理等级和安全字段路径。省略、null、空等级数组与 `{ "path": [] }` 使用默认配置；非空非法配置仍被拒绝。更新补丁省略字段保持原值，显式空值恢复默认。

默认等级为 `low`、`medium`、`high`，Anthropic 默认路径为 `output_config.effort`，Chat Completions 为 `reasoning_effort`，Responses 为 `reasoning.effort`。模板或显式输入可以使用自己的等级和路径。手动新建默认关闭思考能力，当前内置模型均显式开启。关闭能力仅停止发送推理字段，保留已保存配置；首页、会话模型菜单及设置表单也依据该能力控制推理配置显示。V3 不执行旧版本数据库迁移或自动删除，版本不匹配时报告错误。

`provider_credentials.api_key` 与普通 Provider 列表接口分开读取。它仍然是本地数据库中的明文字符串，不应将此文件公开。每个 Turn 的 [model-adapters.ts](../src/main/model-adapters.ts) 在同一数据库读取快照中取得 Provider、Model 和 API Key，在支持思考时再校验当前推理等级；不会因为查询缺失数据库而自动创建它。

兼容供应商目录只是创建资料，由 [compatible-providers.ts](../src/main/compatible-providers.ts) 按供应商名称索引，每个名称对应一个协议资料数组，数组条目包含 `protocol`、`url` 和 `models`。各供应商资料放在 `src/main/compatible-providers/` 下的独立文件中，当前 DeepSeek 资料见 [deepseek.ts](../src/main/compatible-providers/deepseek.ts)。列表按字典键生成名称并去重协议，创建时先按名称取数组，再匹配单个协议；现有数据不会被模板自动覆盖。

## workspace.sqlite

[workspace-store.ts](../src/main/workspace-store.ts) 持有三个 STRICT 表：

| 表 | 当前列与用途 |
| --- | --- |
| `workspace_groups` | `group_id` 主键、`version`、`name`、`updated_at` |
| `workspace_directories` | `group_id`、`position`、`directory`；保存有序关联目录 |
| `workspace_sessions` | `group_id`、`position`、`session_id`、`name`、`created_at`、`updated_at`；保存对话索引 |

后两张表以 `(group_id, position)` 为主键，外键指向分组并级联删除。`default` 是固定分组身份，其余 Project 身份为 UUID。初始化创建缺失表，并仅在缺少 default 行时补入空分组，不回填既有 Project 内容；读取缺失 Project 报错，不回退到旧 JSON。

Project 的更新时间由写入方提供，列表按更新时间倒序排列；对话索引保存名称、创建和更新时间，不保存 Skill 或会话正文。Session 正文和 Meta 分别在另外两份共享数据库中。

## events.sqlite 与 meta.sqlite

### 已提交事件

[event-log.ts](../runtime/session/src/event-log.ts) 的 `session_events` 列为：

```text
project_group_id, session_id, seq, event_id, type, created_at, event_json
```

主键是 `(project_group_id, session_id, seq)`，同一联合身份下 `event_id` 唯一。写入由日志层分配事件 ID、连续序号和时间，同一进程内同一会话串行写入。Turn 的 `turn/start` 与 `user/message` 在一个事务内提交。

桌面会话共用根目录 `events.sqlite`，会话目录不另存一份正文日志。CLI 则在本次 Run 目录创建相同事件结构的独立数据库。事件类型和载荷见 [events.ts](../runtime/session/src/events.ts)。

### 桌面会话 Meta

[meta-store.ts](../runtime/session/src/meta-store.ts) 创建 STRICT 表 `session_meta`，数据库版本为 1：

```text
project_id, session_id, name, version,
current_model_json, sandbox_mode_json, usage_json, skills_json, additional_meta_json
```

主键为 `(project_id, session_id)`。`current_model_json` 包含 `providerId`、`protocol`、`modelId`、`name`、`reasoningLevel`。`sandbox_mode_json` 保存当前对话的权限模式，默认 `sandbox-full-access`。Usage、Skill 来源历史和其他 Meta 分开序列化；MCP 载入记录保存在 `additional_meta_json.loadedMcpTools`。

Meta 不等同于 Event Log：名称和运行设置有自己的写入入口，Usage 与部分上下文状态由事件派生。单条 Meta 缺失或 JSON 损坏时可交恢复流程补建，数据库结构不合法则报错。详细类型与恢复逻辑见 [session-state.ts](../runtime/session/src/session-state.ts)。

### 会话派生文件

- `contextstate.json` 保存 `agentsmd: { hash, content }`、`skills: { id, content }` 和 `mcp` 定义数组。
- `agents_md.snapshot` 保存参与增量比较的规则快照。
- `tool_output/` 保存工具输出文件；具体输出路径由工具实现创建。

SessionState 基于已校验日志修复派生状态。成功 Summary 的 `summary/end` 带覆盖范围与完整基线，恢复时使用该记录；不要通过手改快照替代合法事件写入。

## Skill registry.json

[SkillManager](../runtime/skill/src/manager.ts) 在 Global 和每个 Project 的 `skills/` 下分别维护：

```json
{
  "version": 1,
  "skills": [
    {
      "name": "example",
      "path": "C:/Users/example/.nicode/skills/example",
      "scope": "global",
      "enabled": true
    }
  ]
}
```

`name` 是直接子文件夹名，`path` 是绝对目录，`scope` 为 `global` 或 `project`。条目按名称排序，来源内名称唯一。同步以实际子目录为准，新增项默认启用，非法 registry 整体重建；初始化存在检查本身不读正文，后续同步会读 registry。

Skill 的 YAML frontmatter 提供 description。模型上下文每条 name + description 本地估算最多 500 tokens，保留名称并截断描述，不设置跨 Skill 总预算。设置页面展示完整 description，单条正文错误独立报告。`skill_load` 根据实时启用来源读取完整 SKILL.md，包含 frontmatter。

## 项目记忆

[MemoryManager](../runtime/memory/src/index.ts) 使用 `sessions/<project-id>/memory.md`，default 有自己的文件。缺失时读取为空，首次有效写入才创建。Markdown 使用一级、二级分类标题与 UTC ISO 毫秒时间记录；工具支持列索引、按二级分类读取和整批追加。

同一分组通过共享 Manager 的写入队列串行提交，同目录临时文件替换完成保存。格式损坏或写入失败保留原文件，不自动修复。记忆不保存在 workspace 数据库，也不默认作为系统消息正文注入。
