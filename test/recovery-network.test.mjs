import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoveryCompose} from '../deploy/recovery-network.mjs';
const fixture=()=>({airbyte:{address:'172.30.0.5'},compose:{networks:{default:{ipam:{config:[{subnet:'172.30.0.0/28',gateway:'172.30.0.1'}]}}},services:{
 'temporal-db':{networks:{default:{ipv4_address:'172.30.0.2'}}},
 temporal:{networks:{default:{ipv4_address:'172.30.0.3'}}},
 app:{networks:{default:{ipv4_address:'172.30.0.4'}}},
 'database-ready':{},'storage-ready':{},
}}});
test('restore reserves init-job addresses without consuming saved Temporal or Airbyte addresses',()=>{
 const saved=fixture(),before=structuredClone(saved),result=recoveryCompose(saved);
 assert.deepEqual(saved,before,'recovery must not rewrite its verified snapshot');
 for(const name of ['temporal-db','temporal','app'])assert.deepEqual(result.services[name],saved.compose.services[name]);
 assert.equal(result.services['database-ready'].networks.default.ipv4_address,'172.30.0.6');
 assert.equal(result.services['storage-ready'].networks.default.ipv4_address,'172.30.0.7');
 const addresses=Object.values(result.services).map(service=>service.networks.default.ipv4_address);
 assert.equal(new Set([...addresses,saved.airbyte.address]).size,addresses.length+1);
 assert.deepEqual(recoveryCompose({...saved,compose:result}),result,'restored configuration is idempotent');
});
test('restore rejects conflicting, foreign and exhausted saved networks before restoring data',()=>{
 for(const change of [
  saved=>{saved.airbyte.address='172.30.0.3';},
  saved=>{saved.airbyte.address='172.31.0.5';},
  saved=>{saved.compose.services.temporal.networks.default.ipv4_address='172.30.0.2';},
  saved=>{saved.compose.networks.default.ipam.config[0].subnet='172.30.0.1/28';},
  saved=>{saved.compose.services.app.networks.other={};},
 ]){const saved=fixture();change(saved);assert.throws(()=>recoveryCompose(saved));}
 assert.throws(()=>recoveryCompose({compose:{networks:{default:{ipam:{config:[{subnet:'10.0.0.0/30',gateway:'10.0.0.1'}]}}},services:{first:{networks:{default:{ipv4_address:'10.0.0.2'}}},initializer:{}}}}),/no free address/);
 const legacy={compose:{services:{app:{image:'saved'}}}};assert.deepEqual(recoveryCompose(legacy),legacy.compose);
});
