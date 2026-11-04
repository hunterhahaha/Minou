# PowerShell 本地安装说明

NiCode 的 Shell 和终端工具使用此目录中的 PowerShell 7。仓库只跟踪本 README；PowerShell 可执行文件、依赖和子目录由本地安装脚本准备，不提交到 Git。

## 安装（Windows x64）

在 Windows PowerShell 或 PowerShell 终端中，先进入 NiCode 仓库根目录，再运行安装脚本：

```powershell
# 替换为你本机的 NiCode 仓库路径。
cd G:\code\NiCode

# 从仓库根目录运行 scripts 下的安装脚本。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-pwsh.ps1
```

`-ExecutionPolicy Bypass` 仅用于本次启动的 PowerShell 进程，不修改系统的永久执行策略。

安装脚本位于 [scripts/setup-pwsh.ps1](../../scripts/setup-pwsh.ps1)，当前固定下载 PowerShell **7.6.9 Windows x64 ZIP**，需要能够访问 GitHub。脚本会创建 `resources/powershell`，将压缩包下载到临时目录，解压到此目录并覆盖同名文件，最后删除临时压缩包。由于目标路径相对于当前工作目录，必须在仓库根目录执行。

## 检查安装结果

仍在仓库根目录运行：

```powershell
.\resources\powershell\pwsh.exe --version
```

成功时会输出已安装的 PowerShell 版本。此安装方式将 PowerShell 放入项目资源目录，不会将其添加到系统 `PATH`。

上述脚本仅准备 Windows x64 资源；其他操作系统或处理器架构不适用此脚本。
