import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
test('repository tooling has no Python source or interpreter commands',()=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const offenders=[];const interpreter=new RegExp('(?:^#!.*|\\b)'+'py'+'thon(?:[0-9.]+)?(?:\\s|$)','m');
 for(const name of new Set(files)){const path=join(root,name);if(!existsSync(path)||!lstatSync(path).isFile())continue;
 // Standalone Airbyte source container moved unchanged from the hosted repository.
 if(['connectors/github/Dockerfile','connectors/github/source.py','connectors/github/tests/test_source.py'].includes(name))continue;
if(/\.py[co]?$/.test(name)){offenders.push(name);continue;}if(!/\.(?:[cm]?[jt]s|sh|ya?ml)$/.test(name)&&!/(?:^|\/)Dockerfile(?:\.|$)/.test(name))continue;
 // The declared standalone connector exception includes its exact CI test invocation.
 // No other workflow command or application/tooling source is exempted.
 let source=readFileSync(path,'utf8');
 if(name==='.github/workflows/ci.yml')source=source.replace('      - name: Verify the standalone GitHub connector\n        run: '+ 'py'+'thon3 -m unittest discover -s connectors/github/tests\n','');
 if(interpreter.test(source))offenders.push(name);}
 assert.deepEqual(offenders,[],'Core tooling must use TypeScript/Node; external upstream build dependencies are not repository source');
});
