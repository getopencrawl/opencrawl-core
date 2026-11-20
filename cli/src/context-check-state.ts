import type {SuggestionEvent} from '../../src/search/suggestion-events.mts';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,statSync,lstatSync,chmodSync,openSync,closeSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {atomicJson,configDir,withFileLock} from './session.ts';
import {readCaptureConfig,type CaptureConfig} from './capture/runtime.ts';
import {apiOrigin,CliError} from './oauth.ts';
import {CHECK_HARNESSES,hash,object,checkText,type CheckHarness,type CheckEvent} from './context-check-events.ts';

export type CheckBinding={api:string;installationId:string;owner:{tenantId:string;userId:string}};
export type CheckSettings=CheckBinding&{schemaVersion:1;revision:string;harnesses:CheckHarness[]};
export type CheckInput={eventId:string;currentSession:{harness:CheckHarness;sessionId:string};role:'user';message:string;task:string;context:{role:'user';text:string}[];timestamp:string};
export type LifecycleDetail=SuggestionEvent extends infer E ? E extends SuggestionEvent ? Omit<E,'id'|'at'|'harness'|'eventKey'|'sessionHash'> : never : never;
export type CheckTask={id:string;session:string;event:string;created:number;state:'running'|'working'|'ready'|'delivering'|'delivered'|'failed';input:string;projects:string;binding:string};
const invalid=()=>new CliError('CHECK_PROFILE_CHANGED','Context checks no longer match the selected installation and account.');
export const checkBinding=(config:CaptureConfig|null,api:string):CheckBinding=>{
  if(!config||config.authPending||config.api!==apiOrigin(api)||!config.installationId||config.installationId==='pending'||!config.owner?.tenantId||!config.owner.userId)throw invalid();
  return {api:config.api,installationId:config.installationId,owner:{tenantId:config.owner.tenantId,userId:config.owner.userId}};
};
const settingsFile=(api:string)=>join(configDir(),'context-checks',hash(api)+'.json');
type Choices=Partial<Record<CheckHarness,boolean>>;
function readChoices(file:string,binding:CheckBinding):{revision:string;choices:Choices}|undefined {
  try{
    if(statSync(file).size>8192)throw invalid();
    const value:unknown=JSON.parse(readFileSync(file,'utf8'));
    if(!object(value)||value.schemaVersion!==1||typeof value.revision!=='string'||!Array.isArray(value.harnesses)||value.harnesses.length>CHECK_HARNESSES.length||value.harnesses.some(v=>!CHECK_HARNESSES.includes(v as CheckHarness))||!object(value.owner))throw invalid();
    if(value.api!==binding.api||value.installationId!==binding.installationId||value.owner.tenantId!==binding.owner.tenantId||value.owner.userId!==binding.owner.userId)return;
    const choices:Choices={};
    if(value.choices===undefined){
      // The old allowlist cannot distinguish an omitted client from an explicit opt-out.
      for(const harness of CHECK_HARNESSES)choices[harness]=value.harnesses.includes(harness);
    }else{
      if(!object(value.choices))throw invalid();
      for(const [harness,enabled] of Object.entries(value.choices)){
        if(!CHECK_HARNESSES.includes(harness as CheckHarness)||typeof enabled!=='boolean')throw invalid();
        choices[harness as CheckHarness]=enabled;
      }
    }
    return {revision:value.revision,choices};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
}
function preferences(binding:CheckBinding){
  const legacy=settingsFile(binding.api),saved=readChoices(legacy,binding);
  if(saved)return {file:legacy,...saved};
  const file=join(dirname(legacy),hash(JSON.stringify([binding.api,binding.installationId,binding.owner.tenantId,binding.owner.userId]))+'.json');
  return {file,...(readChoices(file,binding)??{revision:'recording-default-v1',choices:{}})};
}
function resolveSettings(binding:CheckBinding,config:CaptureConfig,revision:string,choices:Choices):CheckSettings{
  const harnesses=CHECK_HARNESSES.filter(h=>config.hookOwnership==='plugin'&&(choices[h]??(!config.disabled&&config.harnesses?.includes(h)===true)));
  return {schemaVersion:1,...binding,revision,harnesses};
}
export function checkSettings(binding:CheckBinding,config:CaptureConfig):CheckSettings {
  const {revision,choices}=preferences(binding);
  return resolveSettings(binding,config,revision,choices);
}
export async function updateCheckSettings(binding:CheckBinding,selected:readonly CheckHarness[],enabled:boolean):Promise<CheckSettings>{
  return withFileLock(settingsFile(binding.api)+'.lock',async()=>{
    const config=readCaptureConfig();
    if(!config||JSON.stringify(checkBinding(config,binding.api))!==JSON.stringify(binding))throw invalid();
    const {file,choices}=preferences(binding);
    for(const harness of selected)choices[harness]=enabled;
    const settings=resolveSettings(binding,config,randomUUID(),choices);
    atomicJson(file,{...settings,choices});return settings;
  });
}
export function assertCheckSettings(settings:CheckSettings,harness:CheckHarness):void {
  const config=readCaptureConfig(),binding=checkBinding(config,settings.api);
  if(!config||JSON.stringify(binding)!==JSON.stringify(checkBindingFromSettings(settings)))throw invalid();
  const current=checkSettings(binding,config);
  if(current.revision!==settings.revision||!current.harnesses.includes(harness))throw invalid();
}
export const checkBindingFromSettings=(settings:CheckSettings):CheckBinding=>({api:settings.api,installationId:settings.installationId,owner:settings.owner});

/** Private bounded delivery cache, separate from capture and credentials. Each
 * row keeps only a redacted request and status, never result text or auth. */
export class CheckStore {
  readonly db:Database;
  constructor(readonly settings:CheckSettings,readonly harness:CheckHarness){
    const root=join(configDir(),'context-checks');mkdirSync(root,{recursive:true,mode:0o700});
    const path=join(root,hash(JSON.stringify(checkBindingFromSettings(settings)))+'.sqlite');
    try{const fd=openSync(path,'wx',0o600);closeSync(fd);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw invalid();
    chmodSync(path,0o600);this.db=new Database(path);
    this.db.exec('PRAGMA busy_timeout=100; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS checks(id TEXT PRIMARY KEY,session TEXT NOT NULL,event TEXT NOT NULL,created INTEGER NOT NULL,state TEXT NOT NULL,input TEXT NOT NULL,projects TEXT NOT NULL,binding TEXT NOT NULL); CREATE INDEX IF NOT EXISTS check_session ON checks(session,created); CREATE TABLE IF NOT EXISTS suggestion_outbox(id TEXT PRIMARY KEY,dedup TEXT UNIQUE NOT NULL,binding TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);');
  }
  close(){this.db.close();}
  record(task:CheckTask,detail:LifecycleDetail):void {
    try{
    const input=JSON.parse(task.input) as CheckInput;
    const report={id:randomUUID(),at:new Date().toISOString(),harness:input.currentSession.harness,eventKey:hash(JSON.stringify([input.currentSession.harness,input.currentSession.sessionId,input.eventId])),sessionHash:hash(JSON.stringify([input.currentSession.harness,input.currentSession.sessionId])),...detail} as SuggestionEvent;
    this.queue(report,hash(JSON.stringify([task.id,detail])));
    }catch{/* A lost observation must not suppress a usable suggestion. */}
  }
  queue(event:SuggestionEvent,dedup=event.id):void {
    this.db.query('DELETE FROM suggestion_outbox WHERE created<? OR binding!=? OR id IN (SELECT id FROM suggestion_outbox ORDER BY created DESC LIMIT -1 OFFSET 511)').run(Date.now()-86400000,this.settings.revision);
    this.db.query('INSERT OR IGNORE INTO suggestion_outbox VALUES(?,?,?,?,?)').run(event.id,dedup,this.settings.revision,Date.now(),JSON.stringify(event));
  }
  pending():SuggestionEvent[]{return this.db.query<{payload:string},[string]>('SELECT payload FROM suggestion_outbox WHERE binding=? ORDER BY created,rowid LIMIT 24').all(this.settings.revision).map(row=>JSON.parse(row.payload) as SuggestionEvent);}
  acknowledge(ids:string[]):void {for(const id of ids)this.db.query('DELETE FROM suggestion_outbox WHERE binding=? AND id=?').run(this.settings.revision,id);}

  private scope(event:CheckEvent){return hash(JSON.stringify([this.harness,event.sessionId]));}
  get(id:string):CheckTask|undefined {return this.db.query<CheckTask,[string]>('SELECT * FROM checks WHERE id=?').get(id)??undefined;}
  current(task:CheckTask):boolean {
    const row=this.db.query<{id:string;state:string},[string]>('SELECT id,state FROM checks WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 1').get(task.session);
    return row?.id===task.id&&!['failed','delivered'].includes(row.state)&&task.binding===this.settings.revision&&Date.now()-task.created<120000;
  }
  invalidate(event:CheckEvent){
    for(const task of this.db.query<CheckTask,[string]>("SELECT * FROM checks WHERE session=? AND state NOT IN ('failed','delivered')").all(this.scope(event)))this.record(task,{stage:'dropped',reason:'excluded'});
    this.db.query("UPDATE checks SET state='failed' WHERE session=? AND state!='delivered'").run(this.scope(event));}
  find(event:CheckEvent):CheckTask|undefined{return this.get(hash(JSON.stringify([this.settings.revision,this.scope(event),event.eventId])));}
  set(task:CheckTask,state:CheckTask['state']):boolean {
    return this.db.query("UPDATE checks SET state=? WHERE id=? AND binding=? AND state IN ('running','working','ready','delivering') AND (?='failed' OR id=(SELECT id FROM checks WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 1))").run(state,task.id,this.settings.revision,state,task.session).changes===1;
  }
  claim(task:CheckTask,from:CheckTask['state'],to:CheckTask['state']):boolean {
    return this.db.query('UPDATE checks SET state=? WHERE id=? AND binding=? AND state=?').run(to,task.id,this.settings.revision,from).changes===1;
  }
  enqueue(event:CheckEvent):CheckTask|undefined {
    if(event.message===undefined)return;
    return this.db.transaction(()=>{
      const existing=this.find(event);if(existing)return;
      const now=Date.now(),session=this.scope(event);
      for(const task of this.db.query<CheckTask,[number,number]>("SELECT * FROM checks WHERE (state IN ('running','working') AND created<?) OR (state IN ('ready','delivering') AND created<?) LIMIT 512").all(now-30000,now-120000))this.record(task,{stage:'dropped',reason:'expired'});
      this.db.query("UPDATE checks SET state='failed' WHERE (state IN ('running','working') AND created<?) OR (state IN ('ready','delivering') AND created<?)").run(now-30000,now-120000);
      const previous=this.db.query<CheckTask,[string]>("SELECT * FROM checks WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 1").get(session);
      if(previous&&!['failed','delivered'].includes(previous.state))this.record(previous,{stage:'dropped',reason:'superseded'});
      this.db.query("DELETE FROM checks WHERE created<? OR id IN (SELECT id FROM checks WHERE state IN ('failed','delivered') ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 512)").run(now-86400000);
      const prior=this.db.query<{input:string},[string]>('SELECT input FROM checks WHERE session=? ORDER BY created DESC,rowid DESC LIMIT 4').all(session);
      const inputs=prior.map(row=>JSON.parse(row.input) as CheckInput),message=checkText(event.message!,4000);
      const input:CheckInput={eventId:event.eventId,currentSession:{harness:this.harness,sessionId:event.sessionId},role:'user',message,
        task:checkText(inputs[0]?.task||message,1000),context:inputs.reverse().map(previous=>({role:'user',text:checkText(previous.message,400)})),timestamp:new Date(now).toISOString()};
      const task:CheckTask={id:hash(JSON.stringify([this.settings.revision,session,event.eventId])),session,event:event.eventId,created:now,state:'running',input:JSON.stringify(input),projects:JSON.stringify(event.projects),binding:this.settings.revision};
      if(Buffer.byteLength(task.input)>12000)throw new CliError('CHECK_INPUT_TOO_LARGE','Prompt could not fit the bounded check request.');
      this.db.query('INSERT INTO checks VALUES(?,?,?,?,?,?,?,?)').run(task.id,task.session,task.event,task.created,task.state,task.input,task.projects,task.binding);
      this.record(task,{stage:'observed'});
      return task;
    }).immediate();
  }
}
