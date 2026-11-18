param([string]$Action)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$command = @(Get-Content -LiteralPath (Join-Path $root '.opencrawl-command'))
if ($command.Count -lt 1 -or $command.Count -gt 16 -or -not [System.IO.Path]::IsPathRooted($command[0])) { exit 0 }
foreach ($argument in $command) { if ($argument.Length -gt 4096) { exit 0 } }
$executable = $command[0]
$arguments = @($command | Select-Object -Skip 1)
& $executable @arguments plugin-hook --root $root --action $Action
exit $LASTEXITCODE
