import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {selfhostTemporalSettings} from '../dist/src/selfhost/temporal-settings.mjs';
const base={TEMPORAL_ADDRESS:'temporal:7233',TEMPORAL_NAMESPACE:'customer-a'};
test('explicit namespace and plaintext connection remain available for private bundled Temporal',()=>{
  assert.deepEqual(selfhostTemporalSettings(base),{address:'temporal:7233',namespace:'customer-a',connectionOptions:{}});
  assert.throws(()=>selfhostTemporalSettings({TEMPORAL_ADDRESS:'temporal:7233'}),/TEMPORAL_NAMESPACE/);
});
test('credentials cannot silently downgrade to plaintext and malformed configuration fails closed',()=>{
  assert.throws(()=>selfhostTemporalSettings({...base,TEMPORAL_TLS_ENABLED:'yes'}),/true or false/);
  assert.throws(()=>selfhostTemporalSettings({...base,TEMPORAL_API_KEY:'secret'}),/require TEMPORAL_TLS_ENABLED/);
  assert.throws(()=>selfhostTemporalSettings({...base,TEMPORAL_TLS_ENABLED:'true',TEMPORAL_TLS_CERT_PATH:'/missing'}),/Set both/);
  assert.throws(()=>selfhostTemporalSettings({...base,TEMPORAL_TLS_ENABLED:'true',TEMPORAL_API_KEY:' '}),/empty/);
  assert.throws(()=>selfhostTemporalSettings({...base,TEMPORAL_API_KEY:'secret',TEMPORAL_API_KEY_PATH:'/missing'}),/only one/);
});
test('API and worker options preserve mTLS, custom CA and namespace-scoped API key',()=>{
  const dir=mkdtempSync(join(tmpdir(),'oc-temporal-settings-'));
  try{
    for(const [name,value] of Object.entries({ca:'ca',crt:'certificate',key:'private-key',api:'test-key\n'}))writeFileSync(join(dir,name),value);
    const result=selfhostTemporalSettings({...base,TEMPORAL_TLS_ENABLED:'true',TEMPORAL_TLS_CA_PATH:join(dir,'ca'),TEMPORAL_TLS_CERT_PATH:join(dir,'crt'),TEMPORAL_TLS_KEY_PATH:join(dir,'key'),TEMPORAL_API_KEY_PATH:join(dir,'api'),TEMPORAL_TLS_SERVER_NAME:'temporal.example.com'});
    assert.equal(result.connectionOptions.apiKey,'test-key');
    assert.deepEqual(result.connectionOptions.metadata,{'temporal-namespace':'customer-a'});
    assert.equal(result.connectionOptions.tls.serverRootCACertificate.toString(),'ca');
    assert.equal(result.connectionOptions.tls.clientCertPair.crt.toString(),'certificate');
    assert.equal(result.connectionOptions.tls.clientCertPair.key.toString(),'private-key');
    assert.equal(result.connectionOptions.tls.serverNameOverride,'temporal.example.com');
  }finally{rmSync(dir,{recursive:true});}
});
