# Native Windows install. Requires only PowerShell and the Windows tar command.
param([string]$Version = 'next')
$ErrorActionPreference = 'Stop'
if ($Version -eq 'next') { $Version = (Invoke-RestMethod 'https://registry.npmjs.org/@getopencrawl/cli/next').version }
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Usage: install.ps1 [next|VERSION]' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This release supports Windows x64.' }
$archive = 'opencrawl-win32-x64.tgz'
$base = "https://github.com/getopencrawl/opencrawl-core/releases/download/cli-v$Version"
if ($env:OPENCRAWL_DOWNLOAD_BASE) { $base = $env:OPENCRAWL_DOWNLOAD_BASE }
if ($base -notmatch '^https://' -and $base -notmatch '^http://(127\.0\.0\.1|localhost):') { throw 'Downloads require HTTPS.' }
$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('opencrawl-install-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
  Write-Host "Downloading OpenCrawl $Version (win32-x64)..."
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $scratch 'SHA256SUMS') -UseBasicParsing
  Invoke-WebRequest "$base/$archive" -OutFile (Join-Path $scratch $archive) -UseBasicParsing
  $lines = @(Get-Content (Join-Path $scratch 'SHA256SUMS') | Where-Object { $_ -match "^[a-f0-9]{64}  $([regex]::Escape($archive))$" })
  if ($lines.Count -ne 1) { throw 'Missing or duplicate OpenCrawl checksum.' }
  $expected = $lines[0].Substring(0, 64)
  if ((Get-FileHash (Join-Path $scratch $archive) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'OpenCrawl download checksum mismatch.' }
  & tar -xzf (Join-Path $scratch $archive) -C $scratch
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack OpenCrawl.' }
  & (Join-Path $scratch 'package/bin/opencrawl.exe') install
  if ($LASTEXITCODE -ne 0) { throw 'OpenCrawl installation failed.' }
} finally { Remove-Item -Recurse -Force $scratch }
