import test from 'node:test';
import assert from 'node:assert/strict';
import {createConsoleApi} from '../dist/src/application/console.mjs';
import {selfhostSettings} from '../dist/src/selfhost/settings.mjs';
const env={OPENCRAWL_URL:'https://selfhost.example',OPENCRAWL_ORGANIZATION_ID:'org_fixture',OPENCRAWL_AUTH_SECRET:'a'.repeat(32),OPENCRAWL_SETUP_TOKEN:'b'.repeat(32),OPENCRAWL_OPENSEARCH_URL:'http://127.0.0.1:9200'};
test('self-host custom setup start and CLI prefix must be supplied together',()=>{
 const start='sh /private/candidate/install.sh && /private/candidate/opencrawl setup',cli='/private/candidate/opencrawl';
 assert.equal(selfhostSettings(env).setupStartCommand,undefined);
 assert.throws(()=>selfhostSettings({...env,OPENCRAWL_SETUP_START_COMMAND:start}),/must be configured together/);
 assert.throws(()=>selfhostSettings({...env,OPENCRAWL_SETUP_CLI_COMMAND:cli}),/must be configured together/);
 const settings=selfhostSettings({...env,OPENCRAWL_SETUP_START_COMMAND:start,OPENCRAWL_SETUP_CLI_COMMAND:cli});
 assert.equal(settings.setupStartCommand,start);assert.equal(settings.setupCliCommand,cli);
});

test('core console rejects incomplete setup command pairs before serving a fallback',()=>{
 for(const overrides of [{setupStartCommand:'private-start'},{setupCliCommand:'private-cli'}])assert.throws(()=>createConsoleApi(overrides),/configured together/);
});
