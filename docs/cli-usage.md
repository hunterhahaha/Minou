# NiCode CLI 使用说明

本文对应当前实现的 **Headless Agent Execution Protocol V1**。CLI 提供 `run` 命令：接收一个任务，执行现有 `runAgentLoop`，输出最终结果和可选的实时事件。它可以用于本地脚本、CI 或外部 Benchmark 调用。

每次调用创建新的内部 Session，只执行一个 Turn，不复用历史上下文。CLI 使用独立 Node 入口，不需要启动 Electron 窗口。

## 1. 准备环境

在 NiCode 仓库目录安装项目已有依赖并编译 CLI：

```powershell
Set-Location "G:\code\NiCode"
npm ci
npm run build:cli
```

已有依赖时直接执行 `npm run build:cli` 即可。此命令运行 TypeScript 编译器，产物入口为 `dist/src/cli/main.js`，不启动 Electron 或 Vite。使用完整源码编译产物和项目依赖运行，不能只复制 `main.js` 一个文件。

运行环境需要支持项目使用的 `node:sqlite`；本文命令以 Node.js 24 为例。现有 Shell 和 Terminal 工具使用 PowerShell 7，执行这些工具需要本机可运行 `pwsh`。

CLI 复用当前用户的 NiCode 配置。启动时使用 `USERPROFILE`，未设置时使用 Node 的用户主目录，在其下初始化或检查 `.nicode`。运行任务前，先通过 NiCode 的模型配置功能保存 Provider、模型、协议参数和 API Key。首次创建的 Provider 数据库为空，CLI 不会自动添加模型或凭据，也没有配置模型的子命令。

查看帮助不需要已配置模型：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run --help
```

## 2. 快速开始：从任务文件运行

准备 UTF-8 文本文件，例如 `G:\tasks\task.txt`：

```text
阅读当前工作区，说明项目结构，并检查 README 中的启动命令是否与 package.json 一致。
```

确保任务文件、工作区和输出父目录已经存在，然后运行：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run `
  --prompt-file "G:\tasks\task.txt" `
  --workspace "G:\code\repo" `
  --max-steps 100 `
  --timeout 1800 `
  --output "G:\results\result.json"
```

示例省略 `--model`，使用 NiCode 的有效默认模型。需要指定模型时，增加 `--model "configured-model-id"`；这里必须填写数据库中的稳定 `modelId`，不按展示名或 API 模型名称匹配。

以上为 PowerShell 命令，反引号用于续行，必须位于行末。也可以写成一行：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run --prompt-file "G:\tasks\task.txt" --workspace "G:\code\repo" --output "G:\results\result.json"
```

默认 stdout 输出一份最终 JSON，同时将结果写入 `--output` 指定的文件。诊断信息输出到 stderr。

### 使用 `nicode` 命令

`package.json` 已将 `bin.nicode` 指向同一个编译入口。需要在本机使用短命令时，可以在仓库目录编译后执行：

```powershell
npm link
nicode run --prompt-file "G:\tasks\task.txt" --workspace "G:\code\repo" --output "G:\results\result.json"
```

`npm link` 会为当前环境建立命令链接；直接使用前面的 `node` 绝对路径调用无需这一步。源码更新后，需要重新编译。

仓库内也可以使用 `npm run cli -- run ...` 手动启动。外部程序需要解析 stdout 时，直接执行 `node` 或已链接的 `nicode`，避免 npm 自己的脚本提示混入输出。

## 3. 使用 Request JSON

配置较多或由外部程序生成任务时，使用 Request 文件。

例如保存 `G:\tasks\request.json`：

```json
{
  "version": 1,
  "run_id": "external-task-151",
  "prompt": "阅读当前工作区，检查 README 中的启动命令，并修正不一致的说明。",
  "model": "configured-model-id",
  "reasoning_level": "medium",
  "workspace": "G:/code/repo",
  "isolated": {
    "skill": true,
    "memory": true,
    "mcp": true
  },
  "permissions": {
    "sandbox_mode": "sandbox-full-access",
    "auto_approve": {
      "groups": [],
      "tools": []
    }
  },
  "limits": {
    "max_steps": 100,
    "timeout_seconds": 1800
  }
}
```

将 `model` 替换为已配置的 ID；需要使用默认模型时，删除 `model` 字段。`reasoning_level` 同样可省略，显式值必须属于该模型的可选等级。

调用方式：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run `
  --request "G:\tasks\request.json" `
  --output "G:\results\result.json" `
  --format jsonl
```

`--request` 与所有任务输入参数互斥，不能同时传入 `--prompt-file`、`--model`、`--workspace`、限制或权限参数。Request 模式只接受共用的 `--output` 和 `--format`，没有命令行覆盖 Request 字段的优先级规则。

最小 Request 只需要版本和非空白任务：

```json
{
  "version": 1,
  "prompt": "阅读当前工作区并说明项目结构。"
}
```

## 4. 参数与 Request 字段对照

| 简单模式参数 | Request 字段 | 默认值与说明 |
| --- | --- | --- |
| `--prompt-file <path>` | `prompt` | 必填。简单模式读取 UTF-8 文件；Request 直接保存任务正文，拒绝空白任务。 |
| 无 | `version` | Request 必须为数字 `1`；简单模式自动补齐。 |
| `--run-id <id>` | `run_id` | 省略时生成 UUID，仅用于调用方关联任务。 |
| `--model <modelId>` | `model` | 省略时使用有效默认模型；未设置默认模型时沿用现有模型顺序选择逻辑。 |
| `--reasoning-level <level>` | `reasoning_level` | 省略时使用所选模型配置的第一个等级。 |
| `--workspace <directory>` | `workspace` | 省略时使用 CLI 启动目录，必须为现存目录。 |
| `--mcp-config <path>` | `mcp_config` | 可选 JSON 文件，仅替换本次 MCP 服务配置。 |
| `--isolate <list>` | `isolated.skill`、`isolated.memory`、`isolated.mcp` | 默认全部为 `false`。列表中指定的模块设为 `true`，表示禁用。 |
| `--sandbox-mode <mode>` | `permissions.sandbox_mode` | 默认 `sandbox-full-access`。 |
| `--auto-approve-groups <list>` | `permissions.auto_approve.groups` | 默认空数组，仅处理已经触发的审批。 |
| `--auto-approve-tools <list>` | `permissions.auto_approve.tools` | 默认空数组，精确工具注册名。 |
| `--max-steps <count>` | `limits.max_steps` | 默认 `100`，必须为正的安全整数。 |
| `--timeout <seconds>` | `limits.timeout_seconds` | 默认 `1800`，必须为正整数且不超过 `2147483` 秒。 |
| `--output <path>` | 无 | 两种模式均必填，指定最终结果文件。父目录必须已存在。 |
| `--format <json\|jsonl>` | 无 | 两种模式共用，默认 `json`，控制 stdout 格式。 |
| `--help` | 无 | 使用 `nicode run --help` 或 `nicode --help` 查看帮助。 |

列表参数使用逗号分隔，不使用空格分隔或重复传参：

```powershell
--isolate skill,memory --auto-approve-groups shell,mcp --auto-approve-tools write,edit
```

参数支持 `--name value` 和 `--name=value`。未知参数、重复参数、额外位置参数、未知 JSON 字段、不支持的协议版本及显式 `null` 值均会被拒绝。可选字段不需要时直接省略。

### 路径规则

CLI 入口、任务文件、Request、工作区、MCP 配置文件和结果文件均支持绝对路径。命令行中包含空格的路径用引号包裹。

| 位置 | 相对路径的解析基准 |
| --- | --- |
| 命令行的 `--prompt-file`、`--request`、`--workspace`、`--mcp-config`、`--output` | CLI 启动目录，即调用进程的当前工作目录。 |
| Request 的 `workspace`、`mcp_config` | Request 文件所在目录。 |
| 两种模式省略 `workspace` | CLI 启动目录，不是 Request 文件目录。 |

例如从 `G:\runner` 启动，传入 `--request G:\tasks\request.json --output .\result.json`：Request 中的 `"workspace": "./repo"` 解析为 `G:\tasks\repo`，结果文件写入 `G:\runner\result.json`。

JSON 中建议使用 `G:/code/repo` 这样的正斜杠路径；使用反斜杠时必须写成 `G:\\code\\repo`。命令行中的普通 Windows 路径不需要双写反斜杠。

路径基准规则只处理上述 CLI 和 Request 字段。MCP 服务配置中的 `command`、`args`、`cwd` 沿用现有 MCP SDK 的处理，CLI 不按配置文件目录重新改写。需要固定 MCP 子进程位置时使用绝对路径；其 `cwd` 省略时继承宿主工作目录，也不会自动改为 `--workspace`。

## 5. 上下文、模块与用户配置

初始上下文由现有基础 System Prompt、本次工作区信息、工作区根目录的 `AGENTS.md`、已启用的 Global Skill 描述和任务正文构成。没有 `AGENTS.md` 时继续运行。

`--workspace` 决定本次工具工作目录和文件允许范围，不会绑定同路径的桌面 Project。Shell、Terminal 的初始目录为 workspace；文件工具允许范围包含 workspace 和本次 `tool_output` 目录。

三个隔离开关相互独立：

| 开关 | 为 `true` 时 | 省略或为 `false` 时 |
| --- | --- | --- |
| `isolated.skill` | 跳过启动阶段 Global/Project Skill 来源初始化和 registry 扫描；不创建 SkillManager、不注册 `skill_load`、不注入描述。 | 使用已启用的 Global Skill，按现有配置运行。 |
| `isolated.memory` | 不创建 MemoryManager、不注册 Memory 工具、不访问 default Memory。 | 使用 default 分组；正文由工具按需访问，不主动加入初始上下文。 |
| `isolated.mcp` | 不创建 MCPManager、不连接服务、不注册发现或远端工具。 | 使用本次覆盖文件或用户已有的 MCP 配置。 |

例如只关闭 Skill 和 Memory，保留 MCP：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run --prompt-file "G:\tasks\task.txt" --workspace "G:\code\repo" --isolate skill,memory --output "G:\results\result.json"
```

这些开关只禁用对应模块。即使三个模块全部关闭，CLI 仍会读取和检查用户的普通配置、模型、凭据，并初始化运行所需的配置文件。它们不代表使用一份完全空白的用户配置。

## 6. 权限与自动审批

CLI 沿用现有权限规则，不等待 UI 审批。权限判断需要审批时，按本次自动批准名单立即作出决定：命中工具组或具体工具名则 `approved`，均未命中则 `denied`，取消后为 `cancelled`。

| 模式 | 主要行为 |
| --- | --- |
| `full-access` | 文件、Shell、PTY 和实际 MCP 调用按现有规则直接允许，不因自动批准名单为空而被额外拦截。 |
| `sandbox-full-access` | 允许根内的文件工具操作直接允许；根外访问、Shell/PTY 和实际 MCP 调用需要审批。 |
| `sandbox-read-only` | 允许根内的 `glob`、`grep`、`read` 直接允许；其他需要审批的访问使用自动批准名单。 |

工具自身的参数校验、路径检查和模块权限仍然执行。`present`、Skill、Memory、MCP 发现等内部状态或上下文操作沿用各自规则，不能仅凭工具组推断是否触发审批。

自动批准名单是“审批发生时如何回答”，不是工具允许列表。它不会隐藏工具，不会禁止原本无需审批的调用，也不能将模型不支持或未注册的工具变为可用。

固定工具组如下：

| 工具组 | 匹配内容 |
| --- | --- |
| `file` | `glob`、`grep`、`read`、`write`、`edit`、`present` |
| `shell` | `shell` |
| `terminal` | `terminal_open`、`terminal_input`、`terminal_close`、`terminal_list` |
| `mcp` | `mcp_list_tools`、`mcp_load_tools`、`tool_search`，以及注册元数据为 `kind=mcp` 的远端工具 |
| `skill` | `skill_load` |
| `memory` | `memory_list`、`memory_read`、`memory_write` |

具体工具名精确匹配注册名，不支持通配符。远端 MCP 工具的分组依据注册元数据，不靠名字前缀识别。

例如在默认模式下自动批准 Shell 和 MCP 的审批：

```powershell
--sandbox-mode sandbox-full-access --auto-approve-groups shell,mcp
```

例如在只读模式下，允许需要审批的 `write` 和 `edit` 调用：

```powershell
--sandbox-mode sandbox-read-only --auto-approve-tools write,edit
```

该名单不限定调用路径；命中后，现有规则发起的相应审批会被批准。若需要保留目录边界，不要把批准工具名理解为“只批准工作区内调用”。

工具被拒绝或执行失败时，现有 ToolResult 会交还模型，Run 不会仅因某一次工具失败就直接终止。

## 7. 单次 MCP 配置

通过 `--mcp-config` 或 Request 的 `mcp_config` 指定 JSON 文件。文件必须包含 `mcpServers` 数组，数组条目沿用当前 NiCode MCP 配置结构。

Streamable HTTP 示例：

```json
{
  "mcpServers": [
    {
      "name": "asset-service",
      "enabled": true,
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp",
      "startup_timeout_sec": 10,
      "tool_timeout_sec": 60
    }
  ]
}
```

stdio 示例：

```json
{
  "mcpServers": [
    {
      "name": "local-service",
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["G:/services/example/server.js"],
      "cwd": "G:/services/example"
    }
  ]
}
```

相应调用：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run `
  --prompt-file "G:\tasks\task.txt" `
  --workspace "G:\code\repo" `
  --mcp-config "G:\tasks\mcp-servers.json" `
  --auto-approve-groups mcp `
  --output "G:\results\result.json" `
  --format jsonl
```

显式文件替换本次使用的整个 MCP 配置列表，不与全局列表合并，也不写回用户配置。省略时使用现有全局配置；`{"mcpServers":[]}` 表示本次没有配置服务。该文件不支持 TOML，不能与 `isolated.mcp=true` 同时使用。

HTTP 配置可使用现有 `bearer_token_env_var` 指定宿主环境变量名，或使用 `http_headers`。不能同时通过这两种方式重复提供 Authorization。stdio 还可通过 `env` 传入环境变量。

MCP 保留现有 Catalog、搜索、载入预算、Schema 校验和调用逻辑。启动连接不会立即向模型暴露所有远端工具定义；模型通过发现和载入工具选择远端能力，载入结果在后续 Step 的工具定义中生效。单个服务连接失败会输出 stderr 诊断，其余服务和任务仍可继续；总超时仍覆盖整个初始化过程。

## 8. 最终结果 JSON

无论 `--format` 选择哪种格式，`--output` 都保存最终结果 JSON。成功结果的结构示例：

```json
{
  "version": 1,
  "run_id": "external-task-151",
  "session_id": "5e800d84-7eef-4473-a0b5-a89d8180d863",
  "status": "completed",
  "stop_reason": "finished",
  "answer": "已检查启动说明并修正 README。",
  "answer_complete": true,
  "model": {
    "providerId": "provider-id",
    "protocol": "chat_completions",
    "modelId": "configured-model-id",
    "name": "api-model-name",
    "reasoningLevel": "medium"
  },
  "record_directory": "C:\\Users\\example\\.nicode\\logs\\cli\\5e800d84-7eef-4473-a0b5-a89d8180d863",
  "metrics": {
    "steps": 2,
    "tool_calls": 1,
    "duration_ms": 8200,
    "usage": {
      "input_tokens": 1000,
      "output_tokens": 200,
      "total_tokens": 1200
    },
    "usage_complete": true,
    "usage_reported_steps": 2,
    "usage_scope": "reported_agent_requests"
  }
}
```

示例 ID、用量和耗时仅用于说明字段。结果外层采用 snake_case；`model` 直接使用现有 ModelRef，内部字段保留 `providerId`、`modelId`、`reasoningLevel` 的 camelCase。

| 字段 | 含义 |
| --- | --- |
| `version` | 公共结果协议版本，当前为 `1`。 |
| `run_id` | 外部任务 ID；省略时自动生成。 |
| `session_id` | 每次新生成的内部 UUID，不复用 `run_id`，也不对应桌面对话索引。 |
| `status`、`stop_reason` | 执行状态和具体结束原因，见退出码表。 |
| `answer` | 最后一个已记录 Assistant Message 的文本块，排除 thinking 和工具调用块。没有可用消息时可为空。 |
| `answer_complete` | 仅模型正常完成时为 `true`；达到限制或失败时保留已有回答，但为 `false`。 |
| `model` | 本次实际模型引用；模型解析前失败时为 `null`。 |
| `record_directory` | 本次内部记录目录；目录创建前失败时为 `null`。 |
| `metrics` | 从已提交事件汇总的统计。 |
| `error` | 失败时可选，包含稳定错误码 `code`、阶段 `stage` 和公开说明 `message`。 |

`completed` 表示 Agent 正常结束，不代表任务答案正确。Benchmark 得分、业务验收和 Git Patch 提取由调用方处理。

### 指标口径

- `steps`：已经写入 `step/start` 的 Step 数。一次 AgentLoop Step 算一步，工具调用不额外计步。
- `tool_calls`：完整工具调用块的数量，包括后来被拒绝或失败的调用，不代表工具成功次数。
- `duration_ms`：从请求校验通过起计时，结果构造时结算，包含初始化、执行和收尾，不包含之后的最终结果写入耗时。
- `usage`：累计各条权威 Assistant Message 报告的 Usage，完全未报告时为 `null`。
- `usage_complete`：至少启动一个 Step，且所有已启动 Step 均报告权威 Usage 时为 `true`。
- `usage_reported_steps`：已报告权威 Usage 的 Step 数。
- `usage_scope`：固定为 `reported_agent_requests`，不宣称覆盖不可观测的失败请求或 SDK 重试账单用量。

Usage 中，`input_tokens` 是未缓存输入；`cache_read_tokens`、`cache_write_tokens` 为另外两个输入桶。`output_tokens` 包含 reasoning，`reasoning_tokens` 只是其中子集，不能再次加入总量。`total_tokens`、缓存和 reasoning 字段未报告时保持缺失，不补零。

停止时最终 `answer` 来自已记录的 Assistant Message，未完成消息的流式文本不保证写入最终回答；调用方可能已经在 `message.delta` 中看到这些片段。

## 9. 实时 JSONL 事件

使用 `--format jsonl` 时，stdout 每行输出一个 JSON 对象，最终结果仍写入 `--output`。例如将事件和诊断分别保存：

```powershell
node "G:\code\NiCode\dist\src\cli\main.js" run `
  --request "G:\tasks\request.json" `
  --output "G:\results\result.json" `
  --format jsonl `
  1> "G:\results\events.jsonl" `
  2> "G:\results\diagnostics.log"
```

公共事件信封固定为：

```json
{"version":1,"seq":1,"type":"run.started","run_id":"external-task-151","session_id":"5e800d84-7eef-4473-a0b5-a89d8180d863","data":{}}
```

`seq` 是本次公共输出独立、单调递增的序号，与内部 EventLog 序号无关。类型专属字段放在 `data` 中。

| `type` | `data` 主要字段 | 说明 |
| --- | --- | --- |
| `run.started` | 空对象 | 请求校验通过后发出，运行环境可能尚在初始化。 |
| `step.started` | `step` | 一个 Step 已开始。 |
| `message.delta` | `step`、`block_id`、`text` | 公开文本增量，不导出 thinking 增量。 |
| `message.completed` | `step`、`text` | 已记录 Assistant Message 的完整公开文本。 |
| `tool.started` | `step`、`call_id`、`tool` | 已调度到工具执行入口，包含参数检查和权限检查阶段，不代表已经产生副作用。 |
| `tool.completed` | `step`、`call_id`、`status` | 工具结果状态，不包含结果正文。 |
| `approval.resolved` | `step`、`approval_id`、`decision` | 本次非交互审批的决定。 |
| `step.completed` | `step`、`reason` | 内部 Step 结束原因。 |
| `run.finished` | `result` | 最终结果与资源清理处理结束后发出，最多一次。正常写出时包含与结果文件一致的结果对象。 |

`message.completed.text` 是完整消息文本；已经消费 `message.delta` 的程序应使用它确认或替换对应消息，避免把完整文本再次追加造成重复。最终回答以 Result 为准。

公共输出采用字段白名单，不导出模型内部思考、原始工具参数、完整工具结果、凭据配置、请求头或异常堆栈。`answer` 和消息文本是模型生成内容，可能复述输入或工具中的信息，公共格式不等于对自然语言内容进行完整脱敏。

调用方应持续读取 stdout 和 stderr，或将其重定向到文件。CLI 等待写入回调处理背压；stdout 管道关闭或写入 5 秒内无法完成时按输出异常结束，不无限缓存事件。管道已经关闭时，调用方无法再依赖收到 `run.finished`，应结合退出码和可用结果文件判断。

## 10. 限制、取消与退出码

| 情况 | `status` | `stop_reason` | 退出码 |
| --- | --- | --- | ---: |
| 模型正常结束 | `completed` | `finished` | 0 |
| 参数、Request 或模型选择无效 | `failed` | `invalid_request` | 2 |
| 达到 Step 上限 | `stopped` | `max_steps` | 10 |
| 总超时 | `stopped` | `timeout` | 124 |
| 收到可处理的 SIGINT / SIGTERM | `stopped` | `interrupted` | 130 |
| 模型未完成或完成状态未知 | `stopped` | `model_incomplete` | 1 |
| 初始化、执行、资源清理或输出异常 | `failed` | `error` | 1 |

Step 上限在下一 Step 创建前检查。例如 `--max-steps 1` 允许第一个 Step 及其工具调用运行；如果模型还需要第二个 Step 才能总结工具结果，则以 `max_steps` 结束。

总超时从请求校验通过开始，包含配置初始化、MCP 连接和 Loop 执行，不包含前面的输入文件读取与校验。超时、SIGINT、SIGTERM 共用本次取消信号，首次终止原因生效；停止后取消模型和工具请求，并释放 MCP、Shell、Terminal 和网络资源。

资源清理宽限为 5 秒，因此 `--timeout` 不是包含全部收尾和输出写入的精确进程寿命上限。Windows 外部强制结束进程或其他不可捕获终止，无法保证写出最终结果；自动化程序应优先给 CLI 自身超时和清理留出时间。

PowerShell 中应在执行命令后立即保存退出码：

```powershell
$runExitCode = $LASTEXITCODE
$result = Get-Content -LiteralPath "G:\results\result.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$result.status
$result.stop_reason
$result.answer
$runExitCode
```

结果文件通过同目录临时文件完成写入后重命名。写入失败返回 `1`，不能报告成功；旧文件可能仍然存在。重复使用同一个输出路径时，调用方应结合本次退出码和 `run_id` 检查结果，避免误读旧任务结果。

## 11. 本地运行记录与错误排查

运行记录默认保存在当前用户主目录下：

```text
.nicode/
  logs/
    cli/
      <session_id>/
        events.sqlite
        tool_output/
```

最终结果的 `record_directory` 给出实际绝对路径。每次使用内部 UUID 生成目录，外部 `run_id` 不参与路径拼接；这些运行不会登记到桌面对话索引。

`events.sqlite` 保存现有内部事件，`tool_output` 保存工具产生的输出文件。内部记录可能包含模型思考和完整工具内容，和默认过滤的公共 JSON/JSONL 不同。

| 现象 | 检查方式 |
| --- | --- |
| 找不到 CLI 入口 | 在仓库目录执行 `npm run build:cli`，检查 `dist/src/cli/main.js` 是否存在；从其他目录运行时使用入口绝对路径。 |
| 找不到指定模型或有效默认模型 | 确认当前用户配置中已保存模型；`--model` 填写稳定 `modelId`；检查运行账号及 `USERPROFILE` 是否与配置模型时一致。 |
| 推理等级无效 | 删除 `--reasoning-level` 使用模型首个等级，或填写模型当前支持的值。 |
| `workspace` 无效或输入文件不可读 | 检查目录/文件是否存在，并按前述路径基准核对相对路径。 |
| 参数冲突 | Request 模式将任务配置放入 JSON，命令行仅保留 `--request`、`--output`、`--format`。 |
| 工具被拒绝 | 检查沙箱模式、是否触发审批，以及组或精确工具名是否命中自动批准名单。 |
| MCP 服务连接失败或没有工具 | 检查 `enabled`、传输配置、服务进程/地址和启动超时；确认未隔离 MCP；远端工具仍需发现和载入。 |
| Shell / Terminal 无法启动 | 检查 `pwsh` 是否可运行，以及本机是否允许创建进程、PTY。 |
| `OUTPUT_FAILED` | 检查输出父目录、文件写权限、stdout 管道状态及读取端是否持续消费。 |
| `RUN_FAILED`、`CLEANUP_FAILED`、`EVENT_WRITE_FAILED` | 查看 `error.stage`、stderr 和本次 `record_directory` 中的记录。 |
| 达到 Step 上限或超时 | 根据任务调整 `--max-steps`、`--timeout`，结合本地事件确认时间消耗位置。 |

参数错误时，只要能识别有效的 `--output` 且路径可写，CLI 会尽力写出失败结果；缺少输出路径或输出本身失败时，不保证存在新结果文件。

## 12. 当前边界与开发验证

当前入口只支持新任务的一次执行，不提供会话恢复、交互式追问、Session 消息队列、Session 级自动上下文压缩或服务端常驻模式。Shell/Terminal 沿用当前 PowerShell 后端，没有新增 Bash 后端或操作系统级沙箱。

外部 Benchmark 可负责准备工作区和任务正文，调用 `run`，读取 Result 与 JSONL，再转换为自己的轨迹、Patch 或评分输入；CLI 本身不提供 Benchmark 专用子命令。

开发者可在仓库根目录执行现有验证：

```powershell
npm run test:cli
npm run typecheck
npm run build
```

`test:cli` 先编译，再运行协议测试和真实 Node 子进程集成测试，使用临时用户目录、本机模型模拟服务与 MCP 服务，包含现有 PowerShell/PTY 的调用。测试需要允许创建本机进程，不依赖真实模型 API。

协议和生命周期的实现位置分别为 `src/cli/protocol.ts` 与 `src/cli/main.ts`。后续参数或公共输出变化时，应同步更新本文和对应测试。
