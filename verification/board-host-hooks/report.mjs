import fs from 'node:fs';import os from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
const dir=join(os.tmpdir(),'oc-host-hooks-'+createHash('sha256').update(process.cwd()).digest('hex').slice(0,20));
const file=join(dir,'events.jsonl');
console.log(JSON.stringify({events:fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse):[]}));
