import {NATIVE_INSTALL_SH, nativeInstallCommand, nativePathCommand} from '../../../src/sessions/cli-installation.mjs';

export function setupCommands(mcpUrl:string, windows=false, setupStartCommand?:string, setupCliCommand?:string) {
  const startOverride=setupStartCommand?.trim()||undefined,cliOverride=setupCliCommand?.trim()||undefined;
  if(Boolean(startOverride)!==Boolean(cliOverride))throw new Error('Setup start and CLI commands must be configured together.');
  const endpoint=new URL(mcpUrl).origin;
  const quoted="'"+endpoint.replace(/'/g,windows?"''":"'\\''")+"'";
  const suffix=` --api ${quoted}`,cli=cliOverride??'opencrawl';
  const setup=`${cli} setup${suffix}`;
  const install=windows
    ? `$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\n${nativeInstallCommand(true)}\nif (-not $? -or $LASTEXITCODE -ne 0) { throw 'OpenCrawl installation failed' }\n${nativePathCommand(true)}`
    : `opencrawl_installer=$(curl -fsSL ${NATIVE_INSTALL_SH}) &&\nprintf '%s' "$opencrawl_installer" | sh &&\n${nativePathCommand(false)}`;
  return {
    setup,install,start:startOverride??(windows?`& {\n${install}\n${setup}\nif ($LASTEXITCODE -ne 0) { throw 'OpenCrawl setup failed' }\n}`:`${install} &&\n${setup}`),
    handoff:`Continue my OpenCrawl setup in this conversation. Run ${cli} setup status${suffix} --local --json to read my installationId and saved choices without network access. Use ${cli} for every OpenCrawl command. For this client selected for a plugin or future recording, guide only the next native hook-trust or MCP sign-in step. Use this plugin's MCP connection at ${mcpUrl}. If its tools are missing, finish this plugin's authentication and refresh its tools in this harness; never substitute another OpenCrawl connection. Call this deployment's native installation_status MCP tool with installationId and client, then call native verify_installation with its proof.id as proofId. When recording is enabled, send the exact installation_status.proof.marker once as visible assistant text, then check installation_status for authenticated capture and search evidence. Keep verification in this client's native conversation. When future recording is off, preserve that choice, complete only MCP sign-in and tool proof, and expect not_selected with no capture required. Preserve skipped history and let history-only imports continue in the background. Local status does not prove current authentication or server progress. Reuse saved choices without repeating completed steps or changing sandbox permissions. Only after this plugin is authenticated and its loaded tool list lacks installation_status, ${cli} verify-installation${suffix} --client CLIENT --json is the fallback only when shell network access is normally authorized.`,
  };
}
