# NiCode 开发与验证指南

本文依据当前 [package.json](../package.json)、TypeScript 配置、开发脚本和实际测试文件整理，供定位代码与选择验证入口。开发约定统一由 [AGENTS.md](../AGENTS.md) 管理；本文列出可执行方式，不表示每次任务都必须运行全部检查。

## 文档任务的验证边界

仅整理文档、修改开发规则、提交或合并分支时，只核对 diff、内容与引用、变更范围和 Git 状态，**不运行测试、类型检查或构建**。即使待合并分支包含此前已提交的代码，也不因此额外运行检查。用户明确要求验证，或任务实际修改代码、依赖、构建配置、业务契约时，再按相应范围验证。

以下命令是现有入口的说明，不代表本文编写时已经执行或通过。

## 源码定位

| 任务 | 优先阅读位置 |
| --- | --- |
| 桌面启动与窗口 | [electron-main.ts](../src/main/electron-main.ts)、[index.ts](../src/main/index.ts)、[electron-windows.ts](../src/main/electron-windows.ts) |
| 配置与模型持久化 | [config-files.ts](../src/main/config-files.ts)、[config-schema.ts](../src/main/config-schema.ts)、[provider-store.ts](../src/main/provider-store.ts) |
| 对话命令、队列与停止 | [session-ipc.ts](../src/main/session-ipc.ts)、[SessionRuntime](../runtime/agent/src/session-runtime.ts) |
| 模型调用与工具小轮 | [loop.ts](../runtime/agent/src/loop.ts)、[model 模块入口](../runtime/model/src/index.ts)、[tool-executor.ts](../runtime/tools/src/tool-executor.ts) |
| 网页搜索与配置库 | [搜索工具](../runtime/tools/src/web-search/index.ts)、[搜索存储](../runtime/tools/src/web-search/store.ts)、[结果整理](../runtime/tools/src/render/web-search.ts) |
| 网页抓取 | [抓取工具](../runtime/tools/src/web-fetch/index.ts)、[流式限量读取](../runtime/tools/src/web-fetch/fetch.ts)、[结果整理](../runtime/tools/src/render/web-fetch.ts) |
| 会话恢复与 Usage | [session-state.ts](../runtime/session/src/session-state.ts)、[event-log.ts](../runtime/session/src/event-log.ts)、[usage.ts](../runtime/model/src/usage.ts) |
| 页面与展示缓存 | [main.tsx](../src/renderer/main.tsx)、[session-page.tsx](../src/renderer/session-page.tsx)、[Renderer session-state.ts](../src/renderer/session-state.ts) |
| Headless CLI | [main.ts](../src/cli/main.ts)、[protocol.ts](../src/cli/protocol.ts)、[CLI 使用说明](cli-usage.md) |

完整边界与调用顺序见 [架构与执行流程](architecture.md)，数据结构见 [配置与持久化](configuration-and-storage.md)。

## 现有工程命令

命令从仓库根目录运行。当前说明使用 Windows、Node.js 24 与 npm。进程工具及相关测试使用仓库的 `resources/powershell` 中的 PowerShell 7。Windows x64 可用 `scripts/setup-pwsh.ps1` 准备资源。Windows 的入口是 `pwsh.exe`，macOS 和 Linux 使用对应发行包中的可执行文件 `pwsh`。

| 命令 | 实际作用 |
| --- | --- |
| `npm ci` | 按 lockfile 安装依赖 |
| `npm start` | 执行完整 build 后启动 Electron |
| `npm run dev` | 编译主进程与 preload，启动 Vite 和 Electron 开发窗口 |
| `npm run typecheck` | 分别运行测试/主进程与 Renderer 的 TypeScript 检查，不产出文件 |
| `npm run build` | `tsc` 编译后执行 `vite build` |
| `npm run build:cli` | 运行 `tsc`，不启动 Electron 或 Vite；按 tsconfig 编译，并非只编译 CLI 文件 |
| `npm run cli -- run ...` | 手动调用编译后的 CLI 入口 |
| `npm run test:cli` | 先编译，再运行 CLI 协议和真实子进程集成测试 |

[scripts/dev-electron.mjs](../scripts/dev-electron.mjs) 在 `127.0.0.1:5173` 启动 Vite，并通过 `NICODE_RENDERER_URL` 交给 Electron。React / CSS 变更使用 HMR；主进程和 preload 改动需要重新启动命令。

[tsconfig.json](../tsconfig.json) 输出主进程、CLI 与 Runtime 到 `dist/`；[tsconfig.test.json](../tsconfig.test.json) 纳入测试并关闭产出；[tsconfig.renderer.json](../tsconfig.renderer.json) 单独检查 Renderer TSX 与 DOM 类型。[vite.config.mts](../vite.config.mts) 构建页面到 `dist/src/renderer/`。

## 按模块选择测试

现有 TypeScript 测试使用 `node:assert/strict` 与 Node 类型剥离，不依赖额外测试框架。可按实际改动选择文件，例如：

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/model/test/usage.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/tools/test/tool-scheduler.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/main/config-files.test.ts
```

`--experimental-strip-types` 只处理执行时类型剥离，不替代 `tsc` 类型检查。`node --check <file>.ts` 也不是本项目可靠的 TypeScript 检查方式。

搜索工具的定向验证入口如下，全部使用临时数据库、本地假搜索服务或假模型，不需要真实 API Key。CLI 搜索测试运行实际编译入口，先执行 `npm run build:cli` 或完整构建：

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/tools/test/web-search-store.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/tools/test/web-search.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/agent/test/web-search-turn.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/cli/web-search.test.ts
```

分别覆盖配置持久化与事务、请求字符串替换与 fetch 透传、每条摘要 800 token 边界及代理对保护、错误边界、桌面 Session 事件关联与回填，以及真实 CLI 子进程的工具注册与调用。超时测试临时缩短底层计时，同时断言生产代码传入的默认值仍为 30 秒。

网页抓取使用以下定向测试入口，均使用本地 HTTP 服务或假模型，不访问远端网页。CLI 测试运行编译后的入口，需先构建：

```powershell
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/tools/test/web-fetch.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types runtime/agent/test/web-fetch-turn.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/cli/web-fetch.test.ts
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types test/renderer/web-fetch.test.ts
```

分别覆盖转换、原文保持、5 MiB 字节边界、分块断流与压缩响应、五次跳转限制、相对与无效目标、跳转链共享超时及取消、转换后 32 KiB UTF-8 截断、并发独立文件、目录错误与部分写入失败清理、写入期间取消、工具注册与分组，以及真实 Session/CLI 的全文文件、结果回填、事件关联和 Renderer 历史/增量投影。超时测试缩短底层计时并断言默认参数仍为 30 秒。真实页面测试为 `test/renderer/electron-web-fetch.test.cjs`，按下文隐藏窗口方式运行；覆盖普通成功、截断成功与超限失败卡片、Markdown 原文及末尾截断说明和全文路径展示，并保存 `dist/web-fetch-renderer.png` 与 `dist/web-fetch-truncated-renderer.png`。定向工具测试之外，调度回归仍用 start/end 与并发峰值断言。

| 范围 | 已有测试位置和关注点 |
| --- | --- |
| 模型、网络与错误 | `runtime/model/test/`、`runtime/network/test/`、`runtime/error/test/`：转换、Usage、流、重试与取消 |
| Agent、上下文与会话 | `runtime/agent/test/`、`runtime/context/test/`、`runtime/session/test/`：Step / Turn、队列、工具回填、压缩、持久化与恢复 |
| 工具与权限 | `runtime/tools/test/`、`test/main/file-access.test.ts`：参数、结果整理、调度、文件、进程与访问判断 |
| Skill、Memory 与 MCP | `runtime/skill/test/`、`runtime/memory/test/`、`runtime/mcp/test/`，以及 Agent / Session 下对应集成文件 |
| 主进程与 preload | `test/main/`、`test/preload/`：数据库、启动、IPC、模型设置、项目、MCP 和 Skill 管理 |
| Renderer 状态 | `test/renderer/session-state.test.ts`：缓存、历史与增量事件合并、草稿及流式投影 |
| CLI | `test/cli/protocol.test.ts`、`test/cli/run.test.ts`：输入与公开协议、输出、隔离、限步、超时及真实 Node 子进程 |

模型端到端测试使用本机假服务器与真实 SDK；CLI 集成测试还使用临时用户目录、真实 PowerShell / PTY 和本机 MCP 服务。部分测试需要创建子进程、绑定本机端口或加载原生模块；运行失败时应区分环境权限与断言失败，不把未执行或被阻止表述为通过。

调度行为的判断应查看实际 start/end 和结果轨迹，而不是仅凭总耗时猜测是否并发。

## 真实 Electron 验证

已有 `.cjs` 测试覆盖真实 Electron、preload、IPC 与页面；需先具备构建产物。以下示例仅在相关代码任务需要验证时运行：

```powershell
npm run build
$testProcess = Start-Process -FilePath (Join-Path (Get-Location) 'node_modules/electron/dist/electron.exe') -ArgumentList 'test/renderer/electron-session.test.cjs' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput 'dist/electron-session.stdout.log' -RedirectStandardError 'dist/electron-session.stderr.log'
Get-Content dist/electron-session.stdout.log
Get-Content dist/electron-session.stderr.log
$testProcess.ExitCode
```

根据改动选择入口，使用同一启动方式替换测试文件：

- `test/renderer/electron-session.test.cjs`：真实对话页面与流式内容。
- `test/renderer/electron-approval.test.cjs`：工具审批交互。
- `test/renderer/electron-default-model.test.cjs`：默认模型保存与发送边界。
- `test/renderer/electron-mcp-settings.test.cjs`：MCP 配置与页面。
- `test/renderer/electron-skill-settings.test.cjs`：技能来源、加载与启停。
- `test/renderer/electron-workspace-design.test.cjs`：工作区、路由、窗口和布局交互。
- `test/main/electron-process-tools.test.cjs`：Electron 环境实际加载和使用进程工具。

测试输出与截图主要写入被忽略的 `dist/`。是否通过应依据对应测试退出码和断言；本文不把存在测试文件等同于当前环境已通过。

## 前端资料

前端任务按 AGENTS.md 要求先阅读 [设计规范](design-system.md) 与 [UI 路线图](ui-roadmap.md)。这些文件描述展示规则和任务计划，功能是否实现仍需核对源码；路线图的待办不构成一次实现全部任务的授权。
