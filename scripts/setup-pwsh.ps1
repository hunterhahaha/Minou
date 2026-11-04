$version = "7.6.9"
$url = "https://github.com/PowerShell/PowerShell/releases/download/v$version/PowerShell-$version-win-x64.zip"

$dest = "resources/powershell"
$zip = "$env:TEMP/nicode-pwsh.zip"

New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest $url -OutFile $zip
Expand-Archive $zip -DestinationPath $dest -Force
Remove-Item $zip