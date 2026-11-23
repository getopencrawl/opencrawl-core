import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes, createHash} from 'node:crypto';
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {userInfo} from 'node:os';

// A new dedicated Linux VM owns all files and the PostgreSQL instance. Only
// the provider plugin calls its own native hooks and workload identity helper.
const directory='/tmp/oc-devin-board-trial';
const [action,argument]=process.argv.slice(2);
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,stdio:'inherit'});
const read=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,encoding:'utf8'}).trim();
const core=join(directory,'core'), configFile=join(directory,'trial.json');
assert.equal(process.platform,'linux');
assert(process.getuid()>0,'Use the ordinary VM account');
if(action==='prepare'){
  assert.match(argument,/^[a-f0-9]{40}$/);
  assert(Number(process.versions.node.split('.')[0])>=24,'Use Node 24 or newer');
  assert.equal(read('bun',['--version']),'1.3.14');
  const pgBin=read('pg_config',['--bindir']);
  for(const tool of ['pg_ctl','initdb'])assert(existsSync(join(pgBin,tool)),'PostgreSQL server tools required');
  mkdirSync(directory,{mode:0o700}); // Refuse to adopt an existing path.
  run('git',['init','-q',core]);
  run('git',['fetch','-q','--depth=1','https://github.com/getopencrawl/opencrawl-core.git',argument],core);
  run('git',['checkout','-q','--detach','FETCH_HEAD'],core);
  assert.equal(read('git',['rev-parse','HEAD'],core),argument);
  run('npm',['ci','--no-audit','--no-fund'],core);
  run('npm',['run','build'],core);
  const cli=join(core,'cli');
  run('bun',['install','--frozen-lockfile'],cli);
  run('bun',['scripts/build.ts','--current'],cli);
  const binary=join(directory,'opencrawl');
  copyFileSync(join(cli,'dist','linux-'+process.arch,'bin','opencrawl'),binary);
  chmodSync(binary,0o700);
  const password=randomBytes(24).toString('hex');
  const passwordFile=join(directory,'pg-password');
  writeFileSync(passwordFile,password+'\n',{mode:0o600,flag:'wx'});
  run(join(pgBin,'initdb'),['-D',join(directory,'pg'),'-U',userInfo().username,'--auth-local=peer','--auth-host=scram-sha-256','--pwfile='+passwordFile]);
  writeFileSync(configFile,JSON.stringify({pgBin,revision:argument}),{mode:0o600,flag:'wx'});
  console.log('Prepared dedicated VM files. Next use the session ID from the provider chat URL.');
}else{
  const stat=lstatSync(directory);
  assert(stat.isDirectory()&&stat.uid===process.getuid()&&(stat.mode&0o077)===0);
  const {pgBin}=JSON.parse(readFileSync(configFile));
  if(action==='serve'){
    assert.match(argument,/^devin-[a-f0-9]{32}$/);
    const database=join(directory,'pg');
    execFileSync(join(pgBin,'pg_ctl'),['-D',database,'-l',join(directory,'pg.log'),'-o','-h 127.0.0.1 -k '+directory+' -p 19279','-w','start'],{stdio:'inherit'});
    const password=readFileSync(join(directory,'pg-password'),'utf8').trim();
    const pgUrl='postgresql://'+encodeURIComponent(userInfo().username)+':'+password+'@127.0.0.1:19279/postgres';
    try{
      const child=spawn(process.execPath,[resolve(import.meta.dirname,'devin-workload.mjs'),core,'org-8116610651f3465eafd661d6817a4d5d',argument,join(directory,'receipt')],{env:{...process.env,OPENCRAWL_TEST_POSTGRES_URL:pgUrl},stdio:'inherit'});
      process.once('SIGTERM',()=>child.kill('SIGTERM'));
      process.once('SIGINT',()=>child.kill('SIGTERM'));
      const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',done)});
      assert.equal(code,0);
    }finally{run(join(pgBin,'pg_ctl'),['-D',database,'-m','fast','-w','stop'])}
  }else if(action==='verify'){
    assert.match(argument,/^ELM[A-F0-9]{16}$/);
    const receipt=JSON.parse(readFileSync(join(directory,'receipt','board-result.json')));
    assert.equal(receipt.verifiedIdentity,true);
    assert.equal(receipt.offered,true);
    assert.equal(receipt.reads,1);
    assert.equal(receipt.modelAckCalls,0);
    assert.equal(receipt.serverConfirmedRead,true);
    assert.equal(createHash('sha256').update(argument).digest('hex'),receipt.wordSha256);
    const boards=join(directory,'profile','opencrawl','board');
    const names=readdirSync(boards).filter(name=>name.endsWith('.devin-inbox.json'));
    assert.equal(names.length,1);
    const feed=JSON.parse(readFileSync(join(boards,names[0]))).direct;
    assert.equal(feed.after,1);
    assert.equal(feed.pending,undefined);
    console.log(JSON.stringify({...receipt,answerMatched:true,checkpoint:feed.after,pending:false}));
  }else throw Error('Use prepare REVISION, serve NATIVE_SESSION or verify OBSERVED_WORD');
}
