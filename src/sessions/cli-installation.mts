// Shared by human-facing setup commands and agent instructions. The native
// installer needs no JS runtime and is preferred on a person's own machine. npm
// is preferred in cloud and locked-down sandbox environments.
export const NATIVE_INSTALL_SH='https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh';
export const NATIVE_INSTALL_PS1='https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.ps1';
export const NPM_INSTALL_COMMAND='npm install -g @getopencrawl/cli';
export function nativeInstallCommand(windows=false):string {
  return windows?`irm ${NATIVE_INSTALL_PS1} | iex`:`curl -fsSL ${NATIVE_INSTALL_SH} | sh`;
}
export function nativePathCommand(windows=false):string {
  return windows?'$env:PATH = "$HOME\\.local\\bin;" + $env:PATH':'export PATH="$HOME/.local/bin:$PATH"';
}
