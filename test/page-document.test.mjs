import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {oauthReturnSchema} from '../dist/src/application/page-types.mjs';
import {document} from '../dist/src/application/presentation.mjs';

test('page data cannot escape its inert JSON element, even with closing tags and Unicode separators',()=>{
  const hostile='</script><script>globalThis.compromised=true</script>&\u2028\u2029';
  const page={kind:'message',heading:hostile,detail:'Private text',href:'/auth/login',action:'Sign in'};
  const html=document(page);
  assert.equal((html.match(/<script\b/g)||[]).length,2);
  assert.doesNotMatch(html, /<h1|<main|<form|<script>globalThis|&\u2028/);
  const payload=/<script id="opencrawl-page" type="application\/json">(.*?)<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(payload),{page,signedIn:false});
});

test('server presentation paths do not compose browser feature markup',async()=>{
  for(const file of ['application/presentation.mts','application/integration-callback.mts','application/integration-http.mts','selfhost/application.mts','sessions/cloud-setup.mts']) {
    const source=await readFile(new URL('../src/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/<(?:main|nav|h1|form|button|input|textarea|section)\b|renderTo(?:String|StaticMarkup)/,file);
  }
});

test('OAuth return rendering allows registered Claude callbacks but rejects active content',()=>{
  for(const url of ['https://client.example/callback?code=one-use','http://127.0.0.1:33418/callback','claude://claude.ai/mcp-auth-callback/sdk?code=one-use&state=bound'])assert.equal(oauthReturnSchema.safeParse({kind:'oauth-return',url}).success,true,url);
  for(const url of ['javascript:alert(1)','data:text/html,hello','file:///etc/passwd','vbscript:alert(1)','claude:alert(1)','claude://secret@claude.ai/mcp-auth-callback/sdk','https://secret@client.example/callback','claude://claude.ai/mcp-auth-callback/sdk#fragment'])assert.equal(oauthReturnSchema.safeParse({kind:'oauth-return',url}).success,false,url);
});
