// Run "image" during a Replicas image build and "user" as the agent user.
// The image contains only public code and skills. Each workspace binds its
// own identity on first use, including when its harness starts before a shell.
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const base = '/opt/opencrawl-replicas';
const script = join(base, 'agent-tools.mjs');
const node = '/opt/replicas/node/bin/node';
const clients = ['claude-code', 'codex'];
const skills = ['opencrawl', 'oc-continue', 'oc-import-memories'];
export const release = '0.3.9';
// Same verified Linux artifacts used by the CLI in src/sessions/plugin-release.mts.
export const pins = {
  'claude-code': {x64:'e017aefaa38681bcaa24d8b632ba5f094b9dc781afe68c47b29d085e3f3eabaf',arm64:'e1fb5e908baa75c28af01c45a2e2ce38a7d304efff192fa4c42b18cc4cdc5f36'},
  codex: {x64:'db7ea734f3b60c5a67aeb9dd1269199031ce0ae50848bb16b73f8ac32e88fd2c',arm64:'9834946464cdde2da74d4705af93a741ef1fb88e380549bd3e6e2693280977a2'}
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const matcher = '^mcp__opencrawl__(opencrawl_search(_v1)?|board_post|board_sync|board_presence|board_follow|board_inbox)$';
const events = {SessionStart:'start', UserPromptSubmit:'suggest', PreToolUse:'search'};

function atomic(path, bytes, mode, exclusive = false) {
  mkdirSync(dirname(path), {recursive:true, mode:mode === 0o600 ? 0o700 : 0o755});
  const temp = path + '.' + randomUUID();
  writeFileSync(temp, bytes, {mode, flag:'wx'});
  try {
    if (exclusive) {
      try {linkSync(temp, path);} catch (error) {if (error.code !== 'EEXIST') throw error;}
    } else renameSync(temp, path);
  } finally {if (existsSync(temp)) unlinkSync(temp);}
}
const createJson = (path, value) => atomic(path, JSON.stringify(value) + '\n', 0o600, true);

export function withHooks(config, client) {
  if (!config || Array.isArray(config) || typeof config !== 'object' || config.disableAllHooks === true)
    throw Error('Review disabled or invalid harness settings.');
  if (config.hooks !== undefined && (!config.hooks || Array.isArray(config.hooks) || typeof config.hooks !== 'object'))
    throw Error('Invalid harness hooks.');
  const hooks = {...config.hooks};
  for (const [event, action] of Object.entries(events)) {
    const command = [node, script, 'hook', client, action].join(' ');
    const group = { ...(action === 'search' ? {matcher} : {}), hooks:[{type:'command', command, timeout:action === 'search' ? 8 : 35}] };
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw Error('Invalid hook groups for ' + event);
    const others = groups.flatMap(group => {
      if (!Array.isArray(group.hooks)) throw Error('Invalid handlers for ' + event);
      if (!group.hooks.some(handler => handler.command === command)) return [group];
      const remaining = group.hooks.filter(handler => handler.command !== command);
      return remaining.length ? [{...group, hooks:remaining}] : [];
    });
    hooks[event] = [...others, group];
  }
  return {...config, hooks};
}

function writeHooks(path, client, mode) {
  const stat = lstatSync(path, {throwIfNoEntry:false});
  if (stat && !stat.isFile()) throw Error('Review non-regular hook file ' + path);
  const before = stat ? read(path) : {};
  const after = withHooks(before, client);
  if (JSON.stringify(before) !== JSON.stringify(after)) atomic(path, JSON.stringify(after,null,2)+'\n', stat ? stat.mode & 0o777 : mode);
}

function protectedPath(path) {
  for (let item = path;; item = dirname(item)) {
    const stat = lstatSync(item);
    if (stat.uid !== 0 || (stat.mode & 0o022) || stat.isSymbolicLink()) throw Error('Administrator-owned path required: ' + item);
    if (item === '/') break;
  }
}
function systemDir(path) {
  protectedPath(dirname(path));
  if (!existsSync(path)) mkdirSync(path,{mode:0o755});
  protectedPath(path);
}

async function image() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !pins.codex[process.arch]) throw Error('Use the Replicas Linux image builder with administrative permission.');
  process.umask(0o022);
  protectedPath(node);
  systemDir(base);
  systemDir('/etc/codex');
  const policy = '/etc/codex/hooks.json';
  if (existsSync(policy)) protectedPath(policy);
  // Only unpack the known, checksum-verified release. Never execute an archive
  // entry as administrator. Workspace/tenant state belongs to the user phase.
  const assets = join(base,release + '-' + process.arch);
  if (!existsSync(assets)) {
    const stage = mkdtempSync(join(base,'.image-'));
    try {
      for (const client of clients) {
        const name = 'opencrawl-' + client + '-' + release + '-linux-' + process.arch + '.zip';
        const url = 'https://github.com/getopencrawl/opencrawl-plugins/releases/download/v' + release + '/' + name;
        const archive = join(stage,name);
        execFileSync('/usr/bin/curl',['-fsSL','--retry','3','--proto','=https','--proto-redir','=https','-o',archive,url]);
        if (hash(readFileSync(archive)) !== pins[client][process.arch]) throw Error('Release checksum mismatch: ' + client);
        const dest = join(stage,client);
        mkdirSync(dest);
        execFileSync('/usr/bin/unzip',['-q',archive,'bin/opencrawl-hook',...skills.map(s=>'skills/'+s+'/*'),'-d',dest]);
        chmodSync(join(dest,'bin/opencrawl-hook'),0o755);
        unlinkSync(archive);
      }
      chmodSync(stage,0o755);
      renameSync(stage,assets);
    } finally {rmSync(stage,{recursive:true,force:true});}
  }
  protectedPath(assets);
  atomic(script,readFileSync(fileURLToPath(import.meta.url)),0o644);
  writeHooks(policy,'codex',0o644);
}

function user() {
  if (process.getuid() === 0) throw Error('Run user setup as the workspace agent user.');
  const home = homedir();
  const claude = process.env.CLAUDE_CONFIG_DIR || join(home,'.claude');
  for (const client of clients) {
    const dest = join(client === 'codex' ? join(home,'.agents') : claude,'skills');
    mkdirSync(dest,{recursive:true});
    for (const skill of skills) {
      const target = join(base,release+'-'+process.arch,client,'skills',skill);
      const path = join(dest,skill);
      if (!existsSync(join(target,'SKILL.md'))) throw Error('Missing released skill: '+skill);
      const old = lstatSync(path,{throwIfNoEntry:false});
      if (!old) symlinkSync(target,path,'dir');
      else if (old.isSymbolicLink() && readlinkSync(path).startsWith(base + '/') && readlinkSync(path) !== target) {
        const temp = path + '.' + randomUUID();
        symlinkSync(target,temp,'dir'); renameSync(temp,path);
      } else if (!existsSync(join(path,'SKILL.md'))) throw Error('Review existing skill path: '+path);
    }
  }
  writeHooks(join(claude,'settings.json'),'claude-code',0o600);
}

function destination() {
  const api = process.env.OPENCRAWL_API_URL;
  if (!api || new URL(api).origin !== api || new URL(api).protocol !== 'https:' ||
      process.env.OPENCRAWL_AUTH !== 'replicas-workspace' || !process.env.REPLICAS_WORKSPACE_ID)
    throw Error('Configure the OpenCrawl server and Replicas workspace identity.');
  return api;
}

// Use the identity returned by the authenticated server. Never copy a binding
// between workspaces or save a token in an image, environment or config file.
async function binding(client, api) {
  const workspace = process.env.REPLICAS_WORKSPACE_ID;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspace)) throw Error('Invalid Replicas workspace ID.');
  const configHome = resolve(process.env.OPENCRAWL_CONFIG_HOME || process.env.XDG_CONFIG_HOME || join(homedir(),'.config'));
  const profile = join(configHome,'opencrawl');
  const root = join(profile,'replicas-agent-tools',hash(api),workspace,client);
  const bindingFile = join(root,'.opencrawl-binding.json');
  if (existsSync(bindingFile)) return root;
  const token = execFileSync('/usr/local/bin/replicas',['identity','token','--audience',api],{encoding:'utf8',timeout:6000,stdio:['ignore','pipe','ignore']}).trim();
  const response = await fetch(api+'/api/sessions/identity',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(6000)});
  if (!response.ok) throw Error('OpenCrawl workspace enrollment returned HTTP '+response.status);
  const principal = (await response.json()).data?.principal;
  if (principal?.owner?.provider !== 'replicas' || principal.owner.workspaceId !== workspace ||
      !principal.tenantId || !/^workload_replicas_[a-f0-9]{64}$/.test(principal.userId)) throw Error('Unexpected OpenCrawl workload identity.');
  const owner = {tenantId:principal.tenantId,userId:principal.userId};
  const configFile = join(profile,'capture','config.json');
  createJson(configFile, {
    schemaVersion:1, api, installationId:'replicas-'+workspace, owner,
    installedAt:new Date().toISOString(), disabled:true, harnesses:[], historyHarnesses:[],
    roots:{'claude-code':process.env.CLAUDE_CONFIG_DIR || join(homedir(),'.claude'), codex:process.env.CODEX_HOME || join(homedir(),'.codex')},
    command:['opencrawl']
  });
  const existing = read(configFile);
  if (existing.api !== api || existing.owner?.tenantId !== owner.tenantId || existing.owner.userId !== owner.userId ||
      existing.authPending || !existing.installationId || existing.installationId === 'pending') throw Error('Existing OpenCrawl profile belongs to another installation.');
  const common = {schemaVersion:1,api,owner,installationId:existing.installationId};
  const checksDir = join(profile,'context-checks');
  const preference = join(checksDir,hash(JSON.stringify([api,existing.installationId,owner.tenantId,owner.userId]))+'.json');
  createJson(preference,{...common,revision:'replicas-agent-tools-v1',harnesses:clients,choices:{'claude-code':true,codex:true}});
  createJson(join(root,client === 'codex' ? '.codex-plugin' : '.claude-plugin','plugin.json'),{name:'opencrawl'});
  createJson(bindingFile,{...common,client,configHome,captureMode:'hook',workspaceMcp:{name:'opencrawl',url:api+'/mcp'}});
  return root;
}

async function hook(client, action) {
  if (!clients.includes(client) || !Object.values(events).includes(action)) throw Error('Unknown Replicas hook.');
  const api = destination();
  const root = await binding(client,api);
  const executable = join(base,release+'-'+process.arch,client,'bin','opencrawl-hook');
  const result = spawnSync(executable,['--root',root,'--action',action],{stdio:'inherit',timeout:30000});
  if (result.status !== 0) throw Error('OpenCrawl native '+action+' hook failed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action,client,event] = process.argv.slice(2);
    if (action === 'image') await image();
    else if (action === 'user') user();
    else if (action === 'hook') await hook(client,event);
    else throw Error('Expected image, user or hook.');
  } catch (error) {
    // Never print native credential helpers' child process errors or input.
    console.error('OpenCrawl Replicas setup:', error.code || error.message.split('\n')[0]);
    process.exitCode = 1;
  }
}
