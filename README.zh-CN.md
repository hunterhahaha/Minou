# Minou

<img src="resources/minou.png" width="96" height="96" alt="Minou 标志">

[English](README.md) | **简体中文**

Minou 是一个本地运行的编程智能体，提供 Electron 桌面应用和无界面的 CLI。接入自己的模型供应商后，可以在本地代码库中让智能体读写文件、执行命令，并通过 MCP 使用外部工具。

应用在本机运行，模型请求发送至你配置的供应商。项目目前处于 V1 持续开发阶段，通过源码启动，暂未提供桌面安装包。

## 功能

- **桌面工作区：**管理项目与对话，查看流式回复，选择模型与推理等级。
- **多种模型协议：**支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses，可配置供应商与 API Key。
- **编程工具：**搜索、读取、写入和编辑文件，执行 PowerShell 命令与交互式终端任务。
- **权限与审批：**为每个对话选择权限模式，在需要审批时确认工具请求。
- **MCP 连接：**在设置中管理本地 STDIO 和远程 Streamable HTTP 服务，按需发现和载入工具。
- **技能与记忆：**管理全局和项目技能，在多次对话之间保留项目记忆。
- **无界面执行：**将任务直接传给 CLI，逐行接收已提交事件，可选保存运行结果。

## 快速开始

以下命令面向 Windows，需要 Node.js 24 和 npm。Shell 与终端工具使用 `resources/powershell` 中的 PowerShell 7。Windows x64 可在仓库根目录运行 `scripts/setup-pwsh.ps1` 准备资源。本说明未验证其他操作系统。

在本地仓库目录执行：

```powershell
npm ci
npm start
```

`npm start` 会构建应用并打开桌面窗口。

1. 打开设置，添加自定义模型供应商，填写协议、接口地址和 API Key。
2. 添加供应商支持的模型，并在对话中选择它；根据供应商要求配置推理等级和请求字段。
3. 创建或选择项目及其工作目录，也可以在默认工作区开始对话。
4. 选择权限模式、输入任务，并处理执行过程中出现的审批请求。需要中断任务时点击停止。

首次启动的供应商数据库为空。发送第一个任务或使用 CLI 前，需要先配置可用模型。模型访问及供应商费用使用你自己的供应商账户。

## 命令行使用

先在桌面应用中配置模型，再构建 CLI：

```powershell
npm run build:cli
node dist/src/cli/main.js run --help
```

将任务正文直接传给 `--prompt`。

```powershell
node dist/src/cli/main.js run --prompt "说明当前项目结构" --workspace . --output ./answer
```

每次调用创建新的运行。省略 `--modelid` 时使用已配置的默认模型。传入 `--supportreason false` 可以省略模型请求中的思考控制字段。stdout 逐行输出已提交事件。`--output` 将最终回答写成 UTF-8 文本，`--outputjson` 将运行结果写成 JSON；两者均可省略。

默认最多执行 100 步，总超时为 1,800 秒。CLI 在独立 Node 进程中工作。`run` 创建会话，`continue --session-id <id> --prompt <text>` 使用已保存的会话设置继续下一轮。

如需使用简短的 `minou` 命令，构建后执行 `npm link`，然后使用 `minou run ...`。启动参数、权限、隔离选项、事件和退出码详见 [CLI 使用说明](docs/cli-usage.md)。

## 设置与本地数据

- **模型：**在设置中管理供应商、凭据、模型及默认模型。
- **MCP：**在设置 → MCP 中新增、编辑、启用、删除或刷新服务连接；连接失败会显示错误，可修正后重试。
- **技能：**在设置 → 技能中管理并启用全局或项目来源的技能。
- **存储：**桌面端数据位于 `%USERPROFILE%\.minou`，包括配置、供应商凭据、对话、日志、技能和记忆。CLI 使用相同的用户配置；未设置 `USERPROFILE` 时使用用户主目录。

CLI 权限模式控制 Minou 的工具检查与审批流程。使用 `--sandbox-mode auto` 时，需要审批的调用由本轮模型审核。其他模式触发审批时使用本次运行的自动批准名单。请妥善保管 API Key 和本地 `.minou` 目录，并在代码库中运行智能体前确认任务与权限设置。

## 项目文档

开发约定、实现记录、仓库组织方式和验证命令统一见 [AGENTS.md](AGENTS.md)。
