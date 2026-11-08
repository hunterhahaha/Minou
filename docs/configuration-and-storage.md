# NiCode 配置与持久化

本文依据 2026-10-30 当前配置类型、校验器、SQL 建表语句和读写实现整理。数据库字段以对应源码为核对入口；本文不是修改格式或新增迁移的授权。

## 用户目录与启动初始化

桌面入口调用 [initializeConfigFilesSnapshot](../src/main/config-files.ts)，Windows 要求 `USERPROFILE` 是绝对路径。macOS、Linux 桌面和 CLI 在未设置 `USERPROFILE` 时回退到 Node 用户主目录。所有数据集中在其下的 `.nicode`。

```text
.nicode/
├─ config.json                    全局普通配置 V2
├─ desktop-settings.json          窗口关闭偏好，首次保存时创建
├─ providers.sqlite               Provider、Model、API Key 与默认模型
├─ web-search.sqlite              搜索服务商、启用状态、fetch 请求原文与 JMESPath
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

桌面设置由 [desktop-settings.ts](../src/main/desktop-settings.ts) 管理。`desktop-settings.json` 的 `closeBehavior` 接受 `"tray"` 或 `"quit"`。缺少文件或读取无效时使用 `"tray"`。在「设置 → 通用」保存时，主进程串行写入并原子替换文件，成功后立即应用，失败时继续使用上次生效值。

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

### Kimi 与 MiniMax 地区入口

按指定地址表配置以下 Chat Completions 创建模板，替换原有 `Kimi`、`MiniMax` 单一目录项及其 Responses、Anthropic 预设。模型名称、上下文窗口、最大输出和推理配置沿用当前 Chat Completions 模板；地址表未提供新的模型规格或套餐模型白名单。

| 入口 | Base URL |
| --- | --- |
| Kimi 国内 API | `https://api.moonshot.cn/v1` |
| Kimi 国内 Coding Plan | `https://api.kimi.com/coding/v1` |
| Kimi 国际 API | `https://api.moonshot.ai/v1` |
| Kimi 国际 Coding Plan | `https://api.kimi.ai/coding/v1` |
| MiniMax 国内 | `https://api.minimax.com/v1` |
| MiniMax 国际 | `https://api.minimax.io/v1` |

MiniMax 的 API 与 Coding Plan 共用地区地址，不单独拆分套餐入口。各入口仅提供创建资料；创建和运行继续使用现有 Provider 存储与 Adapter 流程，模板不自动改写已保存的供应商。Kimi 的套餐模型可用性仍以所用账号权益为准。

### GLM 标准 API 与 Coding Plan 接入

2026-11-02 依据两家官方文档重建 GLM 创建模板，入口分别为 `BigModel API`、`BigModel Coding Plan`、`Z.AI API`、`Z.AI Coding Plan`，替换原来的 `BigModel` 目录项。模板只影响新建供应商，不会改写已保存的供应商。

| 入口 | Chat Completions | Anthropic Messages | Responses |
| --- | --- | --- | --- |
| BigModel API | `https://open.bigmodel.cn/api/paas/v4` | 未纳入预设 | 未纳入预设 |
| BigModel Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/v1` |
| Z.AI API | `https://api.z.ai/api/paas/v4` | 未纳入预设 | 未纳入预设 |
| Z.AI Coding Plan | `https://api.z.ai/api/coding/paas/v4` | `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/v1` |

标准 API 使用标准 API Key；套餐使用对应平台的个人或团队套餐 Key。目录无法判断 Key 类型或账号权益，入口名称本身不保证实际扣费来源。官方自 2026-10-16 起分类管理 Key，详见 [BigModel Key 分类公告](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management) 与 [Z.AI 文档索引中的 Key 管理说明](https://docs.z.ai/llms.txt)。

普通 API 以官方仍列出的通用编码与智能体型号为范围：两家均收录 `glm-5.3`、`glm-5.3-flash`、`glm-5.3-flashx`、`glm-5.2`、`glm-5.1`、`glm-5`、`glm-4.7`、`glm-4.6`；BigModel 另收录其官方目录中的 `glm-5-turbo`、`glm-4.7-flash`。不收录法律专属型号、图像生成、OCR、语音、向量及更早代际型号。这是预设选型范围，不代表被省略的模型都已下线。

套餐白名单按协议保守收录：Chat Completions 为 `glm-5.3`、`glm-5.3-flash`、`glm-5.2`，Anthropic 为前两者，Responses 为 `glm-5.3`。不由普通 API 列表推断套餐权益，FlashX 官方尚未开放套餐。普通 API 只预设双方明确给出的标准 Chat 入口；不代表其余协议在服务端不受支持。

5.3 系列使用 1,000,000 上下文、131,072 最大输出，推理等级为 `low/high/max`；5.2 使用相同窗口与输出，预设使用 `none/high/max` 三个实际档位。更早型号使用 200,000 上下文与 `thinking.type=enabled/disabled`。Chat 的 5.2/5.3 使用 `reasoning_effort`，套餐 Anthropic 使用 `output_config.effort`，Responses 使用 `reasoning.effort`。5.3 预设不提供关闭思考选项。GLM 的 Chat Completions 历史思考使用通用 `reasoning_content` 回传规则。

核对来源：[BigModel 模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[深度思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[套餐模型与协议](https://docs.bigmodel.cn/cn/coding-plan/latest-model)、[Responses](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)、[Z.AI 模型概览](https://docs.z.ai/guides/overview/overview)、[标准 API](https://docs.z.ai/api-reference/introduction)、[套餐协议](https://docs.z.ai/devpack/tool/others)、[套餐模型与 effort](https://docs.z.ai/devpack/latest-model)、[Flash/FlashX 权益](https://docs.z.ai/guides/vlm/glm-5.3-flash)。


Responses 的官方兼容页与套餐切换页对低档 effort 的映射说明不同，因此 Responses 预设只暴露双方都明确支持的 `high/max`，不提供关闭思考或含义不一致的低档。

### Anthropic 与 OpenRouter

Anthropic 使用 `https://api.anthropic.com` 的 Messages 协议，收录 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`。三款模型的上下文均为 1,000,000，最大输出为 128,000，使用 `output_config.effort` 的 `low/medium/high/xhigh/max` 档位。

OpenRouter 使用 `https://openrouter.ai/api/v1` 的 Chat Completions 协议，仅预设五款：`anthropic/claude-sonnet-5.5`、`anthropic/claude-opus-5.5`、`openai/gpt-6.1-sol`、`google/gemini-4-argon`、`moonshotai/kimi-k3.1-pro`。推理统一写入 `reasoning.effort`，按每款模型的平台能力声明提供档位；Gemini 仅 `low/medium/high`，Kimi 为 `none/low/high/max`，其余为 `low/medium/high/xhigh/max`。

OpenRouter 的上下文窗口依据模型目录；Claude / GPT 最大输出为 128,000，Gemini / Kimi 的单次输出保守设为 65,536，避免平台接近整个上下文窗口的输出上限使当前 Summary 阈值失去可用输入余量。这是应用预设上限，不是服务端最大能力。上述资料只在创建供应商时使用，不自动覆盖已有供应商。

源码：[anthropic.ts](../src/main/compatible-providers/anthropic.ts)、[openrouter.ts](../src/main/compatible-providers/openrouter.ts)。2026-11-02 核对来源：[Claude 模型规格](https://platform.claude.com/docs/en/models/overview)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[OpenRouter 模型目录](https://openrouter.ai/api/v1/models)、[统一推理配置](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[模型榜单](https://openrouter.ai/rankings)。

### Gemini 与 NVIDIA

Gemini 使用 Google AI Studio API Key 和 `https://generativelanguage.googleapis.com/v1beta/openai/` 的 Chat Completions 兼容入口，收录 `gemini-4-argon`、`gemini-3.8-flash`。两款均配置 1,048,576 上下文、65,536 输出规格与 `reasoning_effort=low/medium/high`，不提供 `none/minimal`。不包含 Vertex AI 的项目、地区与 OAuth 入口。

Gemini 模板目前只完成连接与模型资料配置。当前统一 Assistant 内容块和 Chat Adapter 未保存、回传 Gemini 的 thought signature；本次未扩展消息、流事件与持久化契约，因此不能将模板存在理解为已验证多轮工具调用完整兼容。完整签名支持需要独立决定其跨 Adapter、Agent、事件日志和恢复的数据流。

NVIDIA 使用托管 NIM 的 `https://integrate.api.nvidia.com/v1`，仅提供 Chat Completions，收录 `openai/gpt-oss-120b` 与 `meta/llama-3.3-70b-instruct`。两款配置 131,072 上下文、4,096 输出规格，输出依据托管端点公布的限制。GPT-OSS 提供 `reasoning_effort=low/medium/high`；Llama 关闭推理配置发送。`supportsReasoning` 表示是否发送推理控制字段，不用厂商名称推断能力。

当前 Chat Adapter 不发送 `max_tokens`，上述最大输出属于模型配置与上下文预算资料，实际生成仍使用端点默认值；其中 NVIDIA Llama 默认输出为 1,024。本次不更改这一现有请求行为，也不配置本地 GPU、自托管容器或新协议。

源码：[gemini.ts](../src/main/compatible-providers/gemini.ts)、[nvidia.ts](../src/main/compatible-providers/nvidia.ts)。2026-11-02 核对来源：[Google OpenAI 兼容入口](https://ai.google.dev/gemini-api/docs/openai)、[Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[Thinking](https://ai.google.dev/gemini-api/docs/thinking)、[NVIDIA GPT-OSS API](https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-120b-infer)、[Llama API](https://docs.api.nvidia.com/nim/reference/meta-llama-3_3-70b-instruct-infer)。

## web-search.sqlite

[store.ts](../runtime/tools/src/web-search/store.ts) 使用 `node:sqlite` 创建 V1 独立数据库，`PRAGMA user_version = 1`。STRICT 表 `web_search_providers` 包含：

| 字段 | 类型与用途 |
| --- | --- |
| `id` | 非空字符串主键，服务商唯一身份 |
| `name` | 非空服务商名称，允许重复；设置页使用所选预置服务商的名称 |
| `enabled` | 非空整数 `0/1`，新增默认禁用 |
| `request_json` | 非空合法 JSON 字符串，按原文保存完整 fetch 请求配置 |
| `response_jmespath` | 非空 JMESPath，负责将响应映射成 `WebSearchItem[]` |

`web_search_single_enabled` 是 `enabled = 1` 的部分唯一索引，保证全库最多启用一个服务商。启动创建空库，不预置凭据。内部接口支持列表、读取启用配置、新增或更新、启停和删除；新增默认禁用，更新保留启用状态。切换启用项采用事务，失败保留原状态；`null` 禁用全部，删除启用项不自动选替代项。已有数据库只检查版本、表和索引存在，不迁移或覆盖。

请求配置示例（数据库中的 `request_json` 保存以下 JSON 的完整字符串）：

```json
{
  "url": "https://google.serper.dev/search",
  "method": "POST",
  "headers": {
    "X-API-KEY": "YOUR_API_KEY",
    "Content-Type": "application/json"
  },
  "body": "{\"q\":\"${query}\",\"num\":10}"
}
```

执行时先替换整段请求字符串中的 `${query}`，再 `JSON.parse`，分离 `url` 后直接向 fetch 传入其余配置；只由 Runtime 覆盖取消信号。完整的 `"${query}"` 字符串占位符使用 `JSON.stringify(query)` 替换；如上述 body 中的 `\"${query}\"` 则再多编码一层，保证查询中的引号、反斜杠、换行等字符在外层配置与内层 JSON body 中均可正确还原。替换只执行一遍，query 自身包含 `${query}` 时不再次展开。

工具不读取服务商业务字段，不补请求头或重新组装 body。URL 等字符串内的嵌入占位符（如 `?q=${query}`）仍按原文字面量替换，不做 URL 编码；这类嵌入替换若使配置 JSON 无效则返回请求错误。保存接口只检查必要字符串及 JSON、JMESPath 语法，不检查服务商请求字段。每次搜索重新读配置并在网络请求前关闭数据库连接。

JMESPath 输出只检查顶层为数组，直接包装成 `{ results }`；条目结构由表达式保证，不逐项校验、补字段、筛选、排序或转换日期。配置与请求可能包含明文凭据，不应公开数据库。设置页通过搜索管理 IPC 获取 `{ id, name, enabled }` 摘要，仅编辑指定记录时读取完整请求，密钥以密码输入框显示，不进入列表缓存或浏览器持久化。

预置定义统一位于 `src/main/web-search-providers/`，由相邻 `web-search-providers.ts` 显式导入汇总；增加服务商时在该目录新增定义并登记。定义包含参数的 key、label、type、required、secret、可选 defaultValue/max 和 target 字段位置，以及 requestJsonTemplate 与 responseJmespath。target 可声明字符串字段的固定 prefix：生成请求时添加，编辑读取时校验并移除；不匹配前缀或移除后必填值为空时拒绝读取。Tavily 的 APIKEY 必填，只填写 Key，由绑定器添加 `Bearer ` 后写入 Authorization；max_results 可选、默认 5、仅接受 1–8 的整数。前端按定义把参数填入并序列化最终请求，再保存请求原文和固定映射。编辑通过相同字段位置还原参数，不单独保存参数副本或模板身份列。

新增预置同样仅提供创建资料，不覆盖已保存配置，不自动启用或发起请求：

| 服务商与定义 | 请求地址 | APIKEY 填写方式 | 数量参数 | 响应摘要 |
| --- | --- | --- | --- | --- |
| [DeepSeek Search](../src/main/web-search-providers/deepseek.ts) | `https://api.deepseek.com/v1/tools/search` | 只填 Key，自动添加 `Bearer ` 后写入 Authorization | count，默认 5，1–50 | summary，空时回退 snippet；date 映射到 publishedAt |
| [Exa](../src/main/web-search-providers/exa.ts) | `https://api.exa.ai/search` | API Key 本身，写入 x-api-key | numResults，默认 5，1–100 | 请求 highlights，以换行拼接摘录；publishedDate 映射到 publishedAt |
| [Bocha](../src/main/web-search-providers/bocha.ts) | `https://api.bocha.cn/v1/web-search` | 只填 Key，自动添加 `Bearer ` 后写入 Authorization | count，默认 5，1–50 | 请求 summary，以长摘要优先、snippet 回退；datePublished 映射到 publishedAt |

上述数量参数均可留空。DeepSeek 使用独立 Search API，固定不请求网页全文，查询受服务商 1–128 个 Unicode 字符限制；NiCode 不改写或截断查询，服务商拒绝时沿用现有 HTTP 错误处理。Exa 固定 auto 搜索模式；Bocha 固定 noLimit 时间范围。所有服务商表单只填写 Key；Tavily、DeepSeek、Bocha 通过 target.prefix 自动添加 `Bearer `，Exa 不添加前缀。编辑回填仅返回纯 Key，再次保存不会重复添加前缀。

接口依据：[DeepSeek Search](https://api-docs.deepseek.com/api/search/)、[DeepSeek 鉴权](https://api-docs.deepseek.com/guides/search/)、[Exa Search](https://exa.ai/docs/reference/search)、[博查官方适配参考](https://github.com/bocha-ai/dsh-web-search-bocha)。模板及本地响应样本测试不表示已验证远端凭据、账户权限或服务可用性。

管理接口区分创建、更新、详情、列表、删除和唯一启用；创建 UUID 由主进程生成，普通更新不接受 enabled，名称不能切换为另一预置服务商。name 直接加入当前 V1 建表定义，不增加迁移、兼容或重建逻辑；已有缺少该列的数据库会按现有结构检查报告错误。

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

含 Composer 文件引用的 `user/message` 在 `message.content` 中保存含绝对路径的模型文本，并在同一事件的 `message.fileReferences` 中保存项目、关联目录、相对路径、绝对路径、文件名和正文中的 UTF-16 偏移。历史页面根据偏移渲染可点击的标签。引用保存于现有事件载荷中，草稿仍是 Renderer 内存状态。

### 桌面会话 Meta

[meta-store.ts](../runtime/session/src/meta-store.ts) 创建 STRICT 表 `session_meta`，数据库版本为 1：

```text
project_id, session_id, name, version,
current_model_json, sandbox_mode_json, usage_json, skills_json, additional_meta_json
```

主键为 `(project_id, session_id)`。`current_model_json` 包含 `providerId`、`protocol`、`modelId`、`name`、`reasoningLevel`。`sandbox_mode_json` 保存当前对话的权限模式，默认 `sandbox-full-access`。Usage、Skill 来源历史和其他 Meta 分开序列化；MCP 载入记录保存在 `additional_meta_json.loadedMcpTools`，`loadedMcpToolsSeq` 记录已同步的最后一条 MCP 增量序号，初始为 0。普通工具调用只更新调用统计。

Meta 不等同于 Event Log：名称和运行设置有自己的写入入口，Usage 与部分上下文状态由事件派生。单条 Meta 缺失或 JSON 损坏时可交恢复流程补建，数据库结构不合法则报错。详细类型与恢复逻辑见 [session-state.ts](../runtime/session/src/session-state.ts)。

### 会话派生文件

- `contextstate.json` 保存 `agentsmd: { hash, content }`、`skills: { id, content }` 和 `mcp` 定义数组。MCP 数组初始为空，成功 Summary 提交后才替换为该次摘要的工具定义快照。
- `agents_md.snapshot` 保存参与增量比较的规则快照。
- `tool_output/` 保存工具输出文件；具体输出路径由工具实现创建。`web_fetch` 的最终处理文本超过 32 KiB 时，完整 UTF-8 文本保存为 `web_fetch_<本机生成 UUID>.md`，独占创建、不覆盖已有文件；小结果不创建文件，全文不包含截断提示。桌面使用当前会话目录，CLI 使用 `.nicode/logs/cli/<内部 session-id>/tool_output/`。模型可见结果仅保存正文前缀及末尾截断说明、绝对路径；恢复历史时不重新获取或加载全文。

SessionState 基于已校验日志修复派生状态。成功 Summary 的 `summary/end` 带覆盖范围与完整基线。恢复时使用该记录修复基线文件，并从 Meta 的 MCP 游标之后补应用已提交的增量。缺少 Meta 时从完整日志重建载入集合。


MCP 的 `mcp/tools_added` 保存载入记录和当时的工具定义，`mcp/tools_removed` 保存移出的工具名。两类事件都带原始工具调用事件身份。同次载入的移除和新增按序在一笔 SQLite 事务里提交。

支持原生回放的 Adapter 在 `assistant/block_end` 和 `assistant/message` 的内容块上保存可选的 `replay`。其 `name` 和 `protocol` 来自端点规则，`payloadJson` 保存对应协议的原生数据。桌面 IPC 和 CLI 输出通用字段。

[model-adapters.ts](../src/main/model-adapters.ts) 对名称为 `OpenRouter` 或 `Open Router`、协议为 `chat_completions` 的供应商启用 `openrouter` 回放来源。名称匹配忽略大小写和首尾空白。正常结束或工具调用结束时，Adapter 将整条响应的有序 `reasoning_details` 数组附在最后完成的块上。只有密文时使用空文本的 thinking 块承载回放。签名和密文保存在 `payloadJson` 中，历史重建按来源校验后回传。

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
