import {dirname, join} from 'node:path';
import {compare, read, stable, updateDue} from '../distribution.ts';
import {atomicJson, configDir, withSessionLock} from '../session.ts';
import {readCaptureConfig} from '../capture/runtime.ts';
import {readSetupState, scopeKey, type SetupState} from './state.ts';
import {pluginRelease, type PluginRelease} from './plugin-release.ts';
import {loadPublishedPackage,type PublishedPackage} from './published-plugins.ts';
import {setupPluginIdentity} from './plugin-identity.ts';
import {verifyPluginBundle} from './plugin-context.ts';
import {fileHash} from './plugin-bundle.ts';
import {isDeepStrictEqual} from 'node:util';

type Client = PluginRelease['packages'][number]['harness'];
type Candidate = {client:Client; installed:string; version:string; sha256:string};
export function updateCandidates(state:SetupState, release=pluginRelease, platform=process.platform+'-'+process.arch):Candidate[] {
  const candidates:Candidate[]=[];
  for (const entry of release.packages) {
    const client=entry.harness;
    const pin=entry.archives?.[platform];
    if (!pin || !entry.captureAvailable || !state.selections.plugins[client]) continue;
    const result=state.pluginResults?.find(row=>row.client===client);
    if (!result || !['installed','prepared','unchanged'].includes(result.status)) continue;
    const source=result.source;
    if (!source || source.repository!==release.repository || source.path!==entry.path ||
        !stable(source.version) || compare(source.version,entry.version)>=0) continue;
    candidates.push({client,installed:source.version,version:entry.version,sha256:pin.sha256});
  }
  return candidates;
}

function currentInstallation(api?:string) {
  const config=readCaptureConfig();
  if (!config || config.disabled || config.authPending || config.hookOwnership!=='plugin' ||
      !config.owner || !config.installationId || config.installationId==='pending' || (api && api!==config.api)) return;
  const scope={api:config.api,tenantId:config.owner.tenantId,userId:config.owner.userId};
  const state=readSetupState(scope);
  if (!state || state.firstRun==='choosing' || state.installationId!==config.installationId) return;
  return state;
}

function candidateFile(state:SetupState) {
  return join(configDir(),'setup',scopeKey(state.scope)+'.plugin-updates.json');
}

function ownedSource(state:SetupState, candidate:Candidate) {
  const {client,installed}=candidate;
  const identity=setupPluginIdentity(state.scope.api);
  const receipt=read(join(configDir(),'setup-plugins',client,identity.key,'installed.json'));
  if (receipt?.schemaVersion!==2 || receipt.api!==identity.api || receipt.client!==client ||
      receipt.configHome!==dirname(configDir()) || receipt.pluginName!==identity.name ||
      typeof receipt.directory!=='string' || typeof receipt.nativeRoot!=='string') return false;
  const binding=read(join(receipt.directory,'.opencrawl-binding.json'));
  const source=read(join(receipt.directory,'.opencrawl-source.json'));
  return binding?.api===identity.api && binding?.client===client && binding?.configHome===receipt.configHome &&
    binding?.installationId===state.installationId && binding?.owner?.tenantId===state.scope.tenantId &&
    binding?.owner?.userId===state.scope.userId && source?.repository===pluginRelease.repository && source?.version===installed;
}

type Staged = Candidate & ({status:'ready_for_review';hookChanges:string[]} | {status:'retry'});
function verifiedInstallation(state:SetupState, candidate:Candidate) {
  if (!ownedSource(state,candidate)) return;
  const identity=setupPluginIdentity(state.scope.api);
  const receipt=read(join(configDir(),'setup-plugins',candidate.client,identity.key,'installed.json'));
  if (!receipt) return;
  try {
    const bundles=[...new Set<string>([receipt.directory,receipt.nativeRoot])].map(nativeRoot=>
      verifyPluginBundle({api:identity.api,client:candidate.client,configHome:dirname(configDir()),pluginName:identity.name,nativeRoot}));
    if (bundles.every(bundle=>bundle.digest===receipt.digest)) return bundles[0];
  } catch { return; }
}

/** Describe changes to the hook definitions and their runtime. Host trust can cover other files too. */
export function changedHookFiles(installed:Record<string,string>, candidate:PublishedPackage) {
  const target={...candidate.files,...candidate.binaries};
  return [...new Set([...Object.keys(installed),...Object.keys(target)])].filter(name=>
    (name==='hooks.json'||/^(hooks|runtime|scripts|bin)\//.test(name)) &&
    (!(name in target)||fileHash(target[name]!)!==installed[name])).sort();
}

/** Verification and download are safe in the background. Archives live outside host discovery. */
export async function stagePluginUpdates(api?:string, signal?:AbortSignal, load=loadPublishedPackage):Promise<Staged[]> {
  const state=currentInstallation(api);
  if (!state) return [];
  const candidates=updateCandidates(state).filter(row=>ownedSource(state,row));
  if (!candidates.length) return [];
  const file=candidateFile(state);
  const key={installationId:state.installationId,acceptedAt:state.acceptedAt,candidates};
  const cached=():Staged[]|undefined=>{
    const receipt=read(file);
    if (isDeepStrictEqual(receipt?.key,key) && !updateDue(receipt) && Array.isArray(receipt.results))
      return receipt.results;
  };
  const previous=cached();
  if (previous) return previous;
  return withSessionLock('plugin-updates:'+scopeKey(state.scope),async()=>{
    const raced=cached();
    if (raced) return raced;
    const results:Staged[]=[];
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      const bundle=verifiedInstallation(state,candidate);
      if (!bundle) continue;
      try {
        const pkg=await load(candidate.client,{signal});
        if (pkg.source.archive?.sha256!==candidate.sha256) throw new Error('Plugin release changed');
        results.push({...candidate,status:'ready_for_review',hookChanges:changedHookFiles(bundle.files,pkg)});
      } catch {
        signal?.throwIfAborted();
        results.push({...candidate,status:'retry'});
      }
    }
    signal?.throwIfAborted();
    const current=currentInstallation(state.scope.api);
    if (!current || current.installationId!==state.installationId || !isDeepStrictEqual(current.scope,state.scope) ||
        current.acceptedAt!==state.acceptedAt || !isDeepStrictEqual(updateCandidates(current).filter(row=>ownedSource(current,row)),candidates)) return [];
    const nextCheckAt=Date.now()+(results.length!==candidates.length||results.some(row=>row.status==='retry')?15*60_000:6*3_600_000);
    atomicJson(file,{key,nextCheckAt,results});
    return results;
  },0,signal);
}

export function formatPluginUpdates(rows:Staged[]) {
  if (!rows.length) return 'No eligible managed plugin updates.';
  return rows.map(row=>row.client+' '+row.installed+' → '+row.version+
    (row.status==='ready_for_review'?' — downloaded for review. '+(row.hookChanges.length?'Hook files changed: '+row.hookChanges.join(', ')+'.':'Hook definitions and runtime are unchanged.'):' — download pending.')).join('\n');
}
