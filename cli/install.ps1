# Native Windows install. Requires only PowerShell and the Windows tar command.
param([string]$Version = 'latest', [switch]$Setup, [switch]$CaptureNew)
$ErrorActionPreference = 'Stop'
if ($Setup -and $CaptureNew) { throw 'Choose either -Setup or -CaptureNew.' }
if ($Version -in @('latest', 'next')) {
  $epoch = [math]::Floor([DateTimeOffset]::UtcNow.ToUnixTimeSeconds() / 30)
  $Version = (Invoke-RestMethod "https://raw.githubusercontent.com/getopencrawl/opencrawl-core/cli-stable/release.json?epoch=$epoch").version
}
if ($Version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Usage: install.ps1 [latest|VERSION]' }
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
  # Use the bundled .NET cryptography API even when a caller's PSModulePath
  # prevents Windows PowerShell from discovering the Get-FileHash module.
  $stream = [System.IO.File]::OpenRead((Join-Path $scratch $archive))
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha256.Dispose() }
  if ($actual -ne $expected) { throw 'OpenCrawl download checksum mismatch.' }
  & tar -xzf (Join-Path $scratch $archive) -C $scratch
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack OpenCrawl.' }
  if ((Get-Item (Join-Path $scratch 'package/bin/opencrawl.exe')).Length -eq 0) { throw 'OpenCrawl archive has no executable.' }
  & (Join-Path $scratch 'package/bin/opencrawl.exe') install
  if ($LASTEXITCODE -ne 0) { throw 'OpenCrawl installation failed.' }
} finally { Remove-Item -Recurse -Force $scratch }

$bin = if ($env:OPENCRAWL_INSTALL_DIR) { $env:OPENCRAWL_INSTALL_DIR } else { Join-Path $HOME '.local/bin' }
$bin = [System.IO.Path]::GetFullPath($bin)
if (($env:Path -split ';')[0] -ne $bin) { $env:Path = "$bin;$env:Path" }
if ($CaptureNew) {
  & (Join-Path $bin 'opencrawl.cmd') provision --capture-new --json
  if ($LASTEXITCODE -ne 0) { throw "OpenCrawl provisioning exited with code $LASTEXITCODE." }
} elseif ($Setup) {
  if ([Environment]::UserInteractive -and ![Console]::IsInputRedirected -and ![Console]::IsErrorRedirected) {
    & (Join-Path $bin 'opencrawl.cmd') setup
    if ($LASTEXITCODE -ne 0) { throw "OpenCrawl setup exited with code $LASTEXITCODE." }
  } else {
    Write-Host 'Run opencrawl setup in a terminal to continue.'
  }
}
