# Minou CLI 使用说明

本文对应当前实现的 **Headless Agent Execution Protocol V1**。CLI 的 `run` 命令接收任务，执行 `runAgentLoop`，逐行输出已提交的事件和最终结果。它可以用于本地脚本、CI 或外部 Benchmark 调用。

CLI 使用独立 Node 入口。每条命令执行一个 Turn，「run」创建会话，「continue」给已有会话追加一条消息。

## 1. 准备环境

在本地 Minou 仓库根目录安装项目已有依赖并编译 CLI：

```powershell
npm ci
npm run build:cli
```

已有依赖时直接执行 `npm run build:cli` 即可。此命令运行 TypeScript 编译器，产物入口为 `dist/src/cli/main.js`，不启动 Electron 或 Vite。使用完整源码编译产物和项目依赖运行，不能只复制 `main.js` 一个文件。

运行环境需要支持项目使用的 `node:sqlite`；本文命令以 Node.js 24 为例。Shell 和 Terminal 工具使用 Minou 的 `resources/powershell` 中的 PowerShell 7。Windows 的入口是 `pwsh.exe`，macOS 和 Linux 的入口是 `pwsh`。

CLI 复用当前用户的 Minou 配置。启动时使用 `USERPROFILE`，未设置时使用 Node 的用户主目录，在其下初始化或检查 `.minou`。运行任务前，先通过 Minou 的模型配置功能保存 Provider、模型、协议参数和 API Key。首次创建的 Provider 数据库为空，CLI 不会自动添加模型或凭据，也没有配置模型的子命令。

查看帮助不需要已配置模型：

```powershell
node ".\dist\src\cli\main.js" run --help
```

## 2. 快速开始

将任务正文直接传给 `--prompt`。指定 `--output` 或 `--outputjson` 时先确认目标文件的父目录已存在。

```powershell
node ".\dist\src\cli\main.js" run `
  --prompt "阅读当前工作区，说明项目结构，并检查 README 与 package.json 的启动命令是否一致。" `
  --workspace "G:\code\repo" `
  --max-steps 20 `
  --timeout 300 `
  --output "G:\results\answer"
```

省略 `--modelid` 时使用已配置的默认模型。指定模型时传入数据库中的稳定 `modelId`。stdout 逐行输出已提交的事件。`--output` 保存回答正文，`--outputjson` 保存运行状态、统计、回答和日志路径。省略对应参数时不创建该文件。

构建后可在仓库目录执行 `npm link`，再使用 `minou run --prompt "任务正文"`。也可以用 `npm run cli -- run --prompt "任务正文"` 手工运行。外部程序直接调用 `node` 或 `minou` 可以让 stdout 只包含 CLI 的输出。

## 3. 启动参数

| 参数 | 默认值与说明 |
| --- | --- |
| `--prompt <text>` | 必填，传入非空白的任务正文。 |
| `--modelid <id>` | 默认使用 Minou 的有效默认模型。 |
| `--supportreason <true\|false>` | 默认 `true`，覆盖本次运行的思考能力。为 `false` 时模型请求省略推理控制字段，等级不参与校验。 |
| `--reasoning-level <level>` | 默认使用模型保存的第一个推理等级。开启思考能力时，显式值须属于模型保存的等级列表。 |
| `--workspace <path>` | 默认是 CLI 启动目录。指定时必须是已存在的目录。 |
| `--max-steps <count>` | 正整数，默认 `100`。 |
| `--timeout <seconds>` | 正整数，默认 `1800` 秒，包含本次运行初始化。 |
| `--isolate <modules>` | 默认启用 Skill、Memory 和 MCP。传入逗号分隔的 `skill`、`memory`、`mcp` 禁用指定模块。 |
| `--mcp-config <path>` | 指定本次运行使用的 MCP 配置 JSON 文件，其内容包含 `mcpServers` 数组。 |
| `--use-configured-mcp <true\|false>` | 默认 `true`。未指定 `--mcp-config` 时，决定是否使用用户配置中的 MCP 服务。 |
| `--restrict-system-tools <true\|false>` | 默认 `false`。设为 `true` 时启用内置工具白名单。 |
| `--system-tools <names>` | 逗号分隔的精确工具名，默认空列表。开启白名单且列表为空时，所有内置工具均不开放。 |
| `--sandbox-mode <mode>` | 默认 `sandbox-full-access`。可选 `full-access`、`sandbox-full-access`、`sandbox-read-only`、`auto`。 |
| `--auto-approve-groups <groups>` | 默认空列表。逗号分隔的工具组，可选 `file`、`shell`、`terminal`、`mcp`、`skill`、`memory`。 |
| `--auto-approve-tools <names>` | 默认空列表，接收逗号分隔的精确工具名。 |
| `--output <path>` | 可选，按 UTF-8 写入最终回答正文，保留原有换行。扩展名任意，父目录必须已存在。 |
| `--outputjson <path>` | 可选，将最终运行结果写入 JSON 文件。父目录必须已存在，路径须与 `--output` 不同。 |
| `--help` | 使用 `minou run --help` 或 `minou --help` 查看帮助。 |

参数支持 `--name value` 和 `--name=value`。以 `--` 开头的任务正文可用 `--prompt="-- 开头的任务正文"` 传入。列表参数用逗号分隔，布尔选项接受 `true` 和 `false`。未知参数、重复参数和额外位置参数会被拒绝。

## 4. 路径规则

`--workspace`、`--mcp-config`、`--output`、`--outputjson` 的相对路径均相对于 CLI 启动目录。MCP 配置中服务自身的 `command`、`args`、`cwd` 交由 MCP SDK 处理。子进程省略 `cwd` 时继承宿主工作目录。

## 5. 上下文、模块与用户配置

初始上下文由现有基础 System Prompt、本次工作区信息、工作区根目录的 `AGENTS.md`、已启用的 Global Skill 描述和任务正文构成。没有 `AGENTS.md` 时继续运行。

`--workspace` 决定本次工具工作目录和文件允许范围，不会绑定同路径的桌面 Project。Shell、Terminal 的初始目录为 workspace；文件工具允许范围包含 workspace 和本次 `tool_output` 目录。

三个隔离开关相互独立：

| 开关 | 为 `true` 时 | 省略或为 `false` 时 |
| --- | --- | --- |
| `--isolate skill` | 跳过启动阶段 Global/Project Skill 来源初始化和 registry 扫描；不创建 SkillManager、不注册 `skill_load`、不注入描述。 | 使用已启用的 Global Skill，按现有配置运行。 |
| `--isolate memory` | 不创建 MemoryManager、不注册 Memory 工具、不访问 default Memory。 | 使用 default 分组；正文由工具按需访问，不主动加入初始上下文。 |
| `--isolate mcp` | 不创建 MCPManager、不连接服务、不注册发现或远端工具。 | 保留 MCP 模块，按本次 MCP 文件和 `--use-configured-mcp` 选择连接。 |

例如只关闭 Skill 和 Memory，保留 MCP：

```powershell
node ".\dist\src\cli\main.js" run --prompt "查看当前项目并总结结果" --workspace "G:\code\repo" --isolate skill,memory --output "G:\results\answer"
```

这些开关只禁用对应模块。即使三个模块全部关闭，CLI 仍会读取和检查用户的普通配置、模型、凭据，并初始化运行所需的配置文件。它们不代表使用一份完全空白的用户配置。

### 限制内置工具

启用白名单后，模型只能看到并执行名单中的内置工具。名称区分大小写，必须是本次可用的精确注册名。未知名称或被模块隔离排除的工具会使请求失败。名单覆盖 `skill_load`、Memory 工具和 MCP 的内置发现与载入工具。远端 MCP 工具仍通过允许使用的 MCP 载入工具在后续 Step 中开放。关闭白名单时，CLI 按各模块的配置开放内置工具。

例如只开放内置文件查看工具。

```powershell
minou run --prompt "查看当前项目并总结结果" --restrict-system-tools true --system-tools glob,grep,read
```

## 6. 权限与自动审批

CLI 沿用现有权限规则。需要审批时，`auto` 模式交由本轮模型审核，其他模式按本次自动批准名单决定。名单命中时返回 `approved`，未命中时返回 `denied`。停止运行会取消等待中的审核。

| 模式 | 主要行为 |
| --- | --- |
| `full-access` | 文件、Shell、PTY 和实际 MCP 调用按现有规则直接允许，不因自动批准名单为空而被额外拦截。 |
| `sandbox-full-access` | 允许根内的文件工具操作直接允许；根外访问、Shell/PTY 和实际 MCP 调用需要审批。 |
| `sandbox-read-only` | 允许根内的 `glob`、`grep`、`read` 直接允许；其他需要审批的访问使用自动批准名单。 |
| `auto` | 文件工具沿用 `sandbox-full-access` 的范围检查。根外文件访问、进程工具和实际 MCP 调用触发审批时，由本轮模型独立审核。审核使用提交的本轮上下文，有效批准后方可继续。 |

工具自身的参数校验、路径检查和模块权限仍然执行。Skill、Memory、MCP 发现等内部状态或上下文操作沿用各自规则，不能仅凭工具组推断是否触发审批。

自动批准名单是“审批发生时如何回答”，不是工具允许列表。它不会隐藏工具，不会禁止原本无需审批的调用，也不能将模型不支持或未注册的工具变为可用。

固定工具组如下：

| 工具组 | 匹配内容 |
| --- | --- |
| `file` | `glob`、`grep`、`read`、`write`、`edit` |
| `shell` | `shell` |
| `terminal` | `terminal_open`、`terminal_input` |
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

通过 `--mcp-config` 指定 JSON 文件。文件必须包含 `mcpServers` 数组，数组条目沿用当前 Minou MCP 配置结构。

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
node ".\dist\src\cli\main.js" run `
  --prompt "查看当前项目并总结结果" `
  --workspace "G:\code\repo" `
  --mcp-config "G:\tasks\mcp-servers.json" `
  --auto-approve-groups mcp `
  --output "G:\results\answer"
```

显式文件替换本次使用的整个 MCP 配置列表。省略该文件时，`--use-configured-mcp` 为 `true` 会使用全局配置，为 `false` 则跳过全局服务的初始化。`{"mcpServers":[]}` 表示本次配置为空。以上设置只在本次运行生效。`--isolate mcp` 完全禁用 MCP 模块，并且与 `--mcp-config` 互斥。

HTTP 配置可使用现有 `bearer_token_env_var` 指定宿主环境变量名，或使用 `http_headers`。不能同时通过这两种方式重复提供 Authorization。stdio 还可通过 `env` 传入环境变量。

MCP 保留现有 Catalog、搜索、载入预算、Schema 校验和调用逻辑。启动连接不会立即向模型暴露所有远端工具定义；模型通过发现和载入工具选择远端能力，载入结果在后续 Step 的工具定义中生效。单个服务连接失败会输出 stderr 诊断，其余服务和任务仍可继续；总超时仍覆盖整个初始化过程。

## 8. 已提交事件的 JSONL 输出

CLI 在 SQLite 提交成功后，按日志 `seq` 将每条事件的完整 JSON 对象写到 stdout，一行一条。以下命令分别保存事件、回答、运行结果和诊断信息。

```powershell
node ".\dist\src\cli\main.js" run `
  --prompt "查看当前项目并总结结果" `
  --output "G:\results\answer" `
  --outputjson "G:\results\run.json" `
  1> "G:\results\events.jsonl" `
  2> "G:\results\diagnostics.log"
```

事件行保留日志中的类型和字段，例如 `turn/start`、`user/message`、`assistant/block_end`、`assistant/message`、`tool/result` 和 `turn/end`。`eventId`、`sessionId`、`seq` 及事件载荷与 SQLite 记录一致。内存里的块开始和增量不会输出。已持久化的思考块、工具参数和结果也会随事件原样输出。

调用方应持续读取 stdout 和 stderr，或将其重定向到文件。CLI 等待写入回调处理背压；stdout 管道关闭或写入 5 秒内无法完成时按输出异常结束，不无限缓存事件。管道写入失败时，退出码和日志可用于判断运行状态。

`--outputjson` 的 `metrics.usage` 取本次运行最近一次上报的 Agent 请求用量，`usage_scope` 为 `latest_reported_agent_request`。每次上报覆盖整份用量，其中 `input_tokens` 为未缓存输入，`output_tokens` 包含推理用量，缓存桶单列。后续请求未上报时保留最近一次上报值，整次运行都未上报时为 `null`。`usage_reported_steps` 记录上报用量的 Step 数，`usage_complete` 表示本次运行至少有一个 Step 且每个 Step 都上报了用量。

## 9. 限制、取消与退出码

| 情况 | `status` | `stop_reason` | 退出码 |
| --- | --- | --- | ---: |
| 模型正常结束 | `completed` | `finished` | 0 |
| 参数或模型选择无效 | `failed` | `invalid_request` | 2 |
| 达到 Step 上限 | `stopped` | `max_steps` | 10 |
| 总超时 | `stopped` | `timeout` | 124 |
| 收到可处理的 SIGINT / SIGTERM | `stopped` | `interrupted` | 130 |
| 模型未完成或完成状态未知 | `stopped` | `model_incomplete` | 1 |
| 初始化、执行、资源清理或输出异常 | `failed` | `error` | 1 |

Step 上限在下一 Step 创建前检查。例如 `--max-steps 1` 允许第一个 Step 及其工具调用运行；如果模型还需要第二个 Step 才能总结工具结果，则以 `max_steps` 结束。

总超时从请求校验通过开始，包含配置初始化、MCP 连接和 Loop 执行，不包含前面的参数与 MCP 配置文件校验。超时、SIGINT、SIGTERM 共用本次取消信号，首次终止原因生效；停止后取消模型和工具请求，并释放 MCP、Shell、Terminal 和网络资源。

资源清理宽限为 5 秒，因此 `--timeout` 不是包含全部收尾和输出写入的精确进程寿命上限。Windows 外部强制结束进程或其他不可捕获终止，无法保证写出最终结果；自动化程序应优先给 CLI 自身超时和清理留出时间。

PowerShell 中应在执行命令后立即保存退出码：

```powershell
$runExitCode = $LASTEXITCODE
$result = Get-Content -LiteralPath "G:\results\run.json" -Raw -Encoding UTF8 | ConvertFrom-Json
$result.status
$result.stop_reason
$result.answer
$runExitCode
```

两个输出文件均通过同目录临时文件完成写入后重命名。写入失败时，CLI 在 stderr 报告 `OUTPUT_FAILED` 并返回 `1`，原有文件可能仍然存在。

## 10. 继续已有会话

从首次执行的 JSONL 事件或 --outputjson 结果中读取 session_id：

```powershell
minou continue --session-id <id> --prompt "基于上一轮的结果，继续处理下一项。"
```

`continue` 只接受 `--session-id` 和 `--prompt`。工作区、模型选择、内置工具、MCP 服务与允许的工具、审批和限额来自首次 run 保存的会话设置。MCP 工具可在首次确定的范围内按需载入；续跑时重连原服务并恢复已载入的工具。相同会话已在执行时，第二个进程会收到占用错误。

每次续跑先恢复已有日志，再检查当前 AGENTS.md 和已启用 Skill。实际增量排在新 Turn 的开始事件之前，模型同时收到原有基线和历史。JSONL 只输出本次提交的事件，包括必要的恢复事件。缺少会话设置的早期 CLI 日志会返回错误。

## 11. 本地运行记录与错误排查

运行记录默认保存在当前用户主目录下：

```text
.minou/
  logs/
    cli/
      <session_id>/
        events.sqlite
        cli-session.sqlite
        contextstate.json
        agents_md.snapshot
        tool_output/
```

`--outputjson` 文件中的 `record_directory` 给出内部日志目录，`event_log_path` 直接指向事件日志数据库。首次 run 使用内部 UUID 创建目录，后续 continue 追加到同一目录。

`events.sqlite` 保存已提交的内部事件，包括完整的 Assistant 内容块和消息。JSONL 的事件行直接对应这些记录。工具产生的输出文件保存在 `tool_output`。

| 现象 | 检查方式 |
| --- | --- |
| 找不到 CLI 入口 | 在仓库目录执行 `npm run build:cli`，检查 `dist/src/cli/main.js` 是否存在；从其他目录运行时使用入口绝对路径。 |
| 找不到指定模型或有效默认模型 | 确认当前用户配置中已保存模型；`--modelid` 填写稳定 `modelId`；检查运行账号及 `USERPROFILE` 是否与配置模型时一致。 |
| 推理等级无效 | 删除 `--reasoning-level` 使用模型首个等级，或填写模型当前支持的值。 |
| 初始化阶段出现 Adapter 路由错误 | 检查 `INVALID_REQUEST` 提示中的 Provider、协议或冲突条目。CLI 在发出模型请求之前退出，显式指定的结果 JSON 也包含该提示。 |
| `workspace` 无效或输入文件不可读 | 检查目录/文件是否存在，并按前述路径基准核对相对路径。 |
| 参数冲突 | 检查是否重复指定参数，或同时使用 `--isolate mcp` 和 `--mcp-config`。 |
| 工具被拒绝 | 检查内置工具白名单、沙箱模式，以及触发审批后记录的决定。 |
| MCP 服务连接失败或没有工具 | 检查 `--use-configured-mcp`、`--mcp-config`、模块隔离以及服务自身的 `enabled`、传输配置和启动超时。 |
| Shell / Terminal 无法启动 | 检查错误中的绝对路径是否指向当前平台的 PowerShell 7 可执行文件，以及本机是否允许创建进程和 PTY。Windows x64 可用 `scripts/setup-pwsh.ps1` 准备资源。 |
| `OUTPUT_FAILED` | 检查输出父目录、文件写权限、stdout 管道状态及读取端是否持续消费。 |
| `RUN_FAILED`、`CLEANUP_FAILED`、`EVENT_WRITE_FAILED` | 查看 `error.stage`、stderr 和本次 `record_directory` 中的记录。 |
| 达到 Step 上限或超时 | 根据任务调整 `--max-steps`、`--timeout`，结合本地事件确认时间消耗位置。 |

参数校验失败时，CLI 通过 stderr 和退出码报告错误。参数有效后发生的运行错误也会写入显式指定的 `--outputjson` 文件。回答文件只有在 Turn 已启动且显式指定 `--output` 时才会写入。

## 12. 当前边界与开发验证

CLI 通过独立命令逐轮执行。交互式终端、Session 消息队列、Session 级自动上下文压缩和服务端常驻模式仍在当前范围之外。Shell/Terminal 沿用当前 PowerShell 后端，没有新增 Bash 后端或操作系统级沙箱。

外部 Benchmark 可负责准备工作区和任务正文，调用 `run`，读取 JSONL，并按需要通过 `--outputjson` 获取运行结果，再转换为自己的轨迹、Patch 或评分输入；CLI 本身不提供 Benchmark 专用子命令。

开发者可在仓库根目录执行现有验证：

```powershell
npm run test:cli
npm run typecheck
npm run build
```

`test:cli` 先编译，再运行协议测试和真实 Node 子进程集成测试，使用临时用户目录、本机模型模拟服务与 MCP 服务，包含现有 PowerShell/PTY 的调用。测试需要允许创建本机进程，不依赖真实模型 API。

协议和生命周期的实现位置分别为 `src/cli/protocol.ts` 与 `src/cli/main.ts`。后续参数或公共输出变化时，应同步更新本文和对应测试。
