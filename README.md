# Minou

<img src="resources/minou.png" width="96" height="96" alt="Minou logo">

**English** | [简体中文](README.zh-CN.md)

Minou is a local coding agent with an Electron desktop app and a headless CLI. Connect your own model provider, work with a local codebase, and let the agent read and edit files, run commands, and use tools through MCP.

The app runs locally; model requests are sent to the provider you configure. Minou is in active V1 development and currently runs from source. A packaged desktop installer is not yet available.

## Features

- **Desktop workspace:** organize projects and conversations, stream responses, and select models and reasoning levels.
- **Multiple model protocols:** Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses, with configurable providers and API keys.
- **Coding tools:** search, read, write, and edit files; run PowerShell commands and interactive terminal sessions.
- **Permissions and approvals:** choose a permission mode for each conversation and review tool requests when approval is required.
- **MCP connections:** configure local STDIO and remote Streamable HTTP servers in Settings, with tool discovery and loading on demand.
- **Skills and memory:** manage global and project skills, and keep project memory across conversations.
- **Headless execution:** pass a task on the command line and receive committed events as JSON Lines and optionally save a run summary.

## Getting started

The commands below target Windows with Node.js 24 and npm. Shell and terminal tools use PowerShell 7 from `resources/powershell`. On Windows x64, run `scripts/setup-pwsh.ps1` from the repository root to prepare the resource. Other operating systems have not been verified here.

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

Pass the task directly to `--prompt`:

```powershell
node dist/src/cli/main.js run --prompt "Summarize this project" --workspace . --output ./answer
```

Each invocation starts a fresh run using the configured default model unless you pass `--modelid`. Use `--supportreason false` to omit reasoning controls. Stdout prints committed events as JSON Lines. Use `--output` to save the final answer as UTF-8 text and `--outputjson` to save the final run result as JSON.

The defaults are 100 steps and a 1,800-second timeout. The CLI runs without an Electron window. Use `run` to start a conversation and `continue --session-id <id> --prompt <text>` to add a turn using its saved settings.

To use the shorter `minou` command, run `npm link` after building, then use `minou run ...`. See the [detailed CLI guide (Chinese)](docs/cli-usage.md) for startup options, permissions, isolation options, events, and exit codes.

## Settings and local data

- **Models:** manage providers, credentials, models, and the default model in Settings.
- **MCP:** add, edit, enable, delete, or refresh server connections in Settings → MCP. A connection failure is shown in the app so you can correct the configuration and retry.
- **Skills:** manage and enable skills from global or project sources in Settings → Skills.
- **Storage:** desktop data lives in `%USERPROFILE%\.minou`, including configuration, provider credentials, conversations, logs, skills, and memory. The CLI uses the same user configuration, falling back to the home directory if `USERPROFILE` is unset.

CLI permission modes govern Minou's tool checks and approval flow. With `--sandbox-mode auto`, the current model reviews requests that require approval. Other modes use the run's auto-approval settings when approval is required. Keep API keys and your local `.minou` directory private, and review tasks and permissions before running an agent on a codebase.

## Project documentation

For development conventions, implementation notes, repository organization, and validation commands, see [AGENTS.md](AGENTS.md).
