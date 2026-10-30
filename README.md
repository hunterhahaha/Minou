# NiCode

**English** | [简体中文](README.zh-CN.md)

NiCode is a local coding agent with an Electron desktop app and a headless CLI. Connect your own model provider, work with a local codebase, and let the agent read and edit files, run commands, and use tools through MCP.

The app runs locally; model requests are sent to the provider you configure. NiCode is in active V1 development and currently runs from source. A packaged desktop installer is not yet available.

## Features

- **Desktop workspace:** organize projects and conversations, stream responses, and select models and reasoning levels.
- **Multiple model protocols:** Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses, with configurable providers and API keys.
- **Coding tools:** search, read, write, and edit files; run PowerShell commands and interactive terminal sessions.
- **Permissions and approvals:** choose a permission mode for each conversation and review tool requests when approval is required.
- **MCP connections:** configure local STDIO and remote Streamable HTTP servers in Settings, with tool discovery and loading on demand.
- **Skills and memory:** manage global and project skills, and keep project memory across conversations.
- **Headless execution:** run a task from a prompt file or JSON request and receive a JSON result or a JSONL event stream.

## Getting started

The commands below target Windows with Node.js 24, npm, and PowerShell 7 (`pwsh`). Shell and terminal tools require `pwsh` to be available locally. Other operating systems have not been verified here.

From your local checkout:

```powershell
npm ci
npm start
```

`npm start` builds the application and opens the desktop window.

1. Open Settings and add a custom model provider with its protocol, endpoint, and API key.
2. Add a model supported by that provider and select it for your conversation. Configure its reasoning levels and request field as needed by the provider.
3. Create or select a project and its working directory, or start a conversation in the default workspace.
4. Choose a permission mode, enter a task, and review approval requests as they appear. Use Stop to interrupt an active task.

The initial provider database is empty. Configure a working model before sending your first task or using the CLI. Model access and any provider charges use your own provider account.

## Command-line usage

Configure a model in the desktop app first, then build the CLI:

```powershell
npm run build:cli
node dist/src/cli/main.js run --help
```

Create a UTF-8 `task.txt` containing your task, then run:

```powershell
node dist/src/cli/main.js run --prompt-file ./task.txt --workspace . --output ./result.json
```

Each invocation starts a fresh run using the configured default model. `--output` is required and its parent directory must already exist. By default, stdout contains the final JSON result and stderr contains diagnostics. Add `--format jsonl` for a stream of public events; the final result is still saved to the output file.

For structured requests:

```powershell
node dist/src/cli/main.js run --request ./request.json --output ./result.json --format jsonl
```

Prompt-file input and request-file input are mutually exclusive. The defaults are 100 steps and a 1,800-second timeout. The CLI runs without an Electron window and does not resume desktop conversations.

To use the shorter `nicode` command, run `npm link` after building, then use `nicode run ...`. See the [detailed CLI guide (Chinese)](docs/cli-usage.md) for request fields, permissions, isolation options, events, and exit codes.

## Settings and local data

- **Models:** manage providers, credentials, models, and the default model in Settings.
- **MCP:** add, edit, enable, delete, or refresh server connections in Settings → MCP. A connection failure is shown in the app so you can correct the configuration and retry.
- **Skills:** manage and enable skills from global or project sources in Settings → Skills.
- **Storage:** desktop data lives in `%USERPROFILE%\.nicode`, including configuration, provider credentials, conversations, logs, skills, and memory. The CLI uses the same user configuration, falling back to the home directory if `USERPROFILE` is unset.

Permission modes govern NiCode's tool checks and approval flow; they do not create an operating-system sandbox. In headless runs, requests requiring approval are denied unless matched by the run's auto-approval settings. Keep API keys and your local `.nicode` directory private, and review tasks and permissions before running an agent on a codebase.

## Project documentation

For development conventions, implementation notes, repository organization, and validation commands, see [AGENTS.md](AGENTS.md).
