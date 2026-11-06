import {realmIndex} from '../src/search/realm.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createObjectStore} from '../src/sessions/s3-store.mjs';
import {createConnectorSearch} from '../src/connectors/search.mjs';
import {createConnectorPipeline} from '../src/connectors/pipeline.mjs';

test('real S3/OpenSearch: stock Slack, replay ordering, durable suppression and two tenants', {
  skip: !process.env.OPENCRAWL_TEST_S3_ENDPOINT || !process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
}, async t => {
  const run = randomUUID(), objects = [], indexes = [];
  const store = createObjectStore({endpoint: process.env.OPENCRAWL_TEST_S3_ENDPOINT, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  t.after(async () => {
    for (const key of objects) await store.delete(key);
    // Only disposable indexes created by this test are removed.
    for (const index of indexes) await fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL + '/' + index, {method: 'DELETE'});
  });
  const handles = [];
  for (const tenant of ['a', 'b']) {
    const tenantId = `fixture-${run}-${tenant}`, connectionId = `fixture-${run}-${tenant}`;
    const binding = {tenantId, connectionId, workspaceId: 'T123', provider: 'slack', access: 'team-public', rawPrefix: `raw/v1/source=slack/workspace=T123/connection=${connectionId}/`};
    const index = realmIndex('test', tenantId); indexes.push(index);
    const search = createConnectorSearch({endpoint: process.env.OPENCRAWL_TEST_OPENSEARCH_URL, index, tenantId});
    for (let attempt = 0; ; attempt++) {
      try { await store.checkAccess(); await search.ensureIndex(); break; }
      catch (error) { if (attempt === 60) throw error; await new Promise(r => setTimeout(r, 1000)); }
    }
    const tracked = {...store, put: async (key, bytes, type) => {objects.push(key); await store.put(key, bytes, type);}};
    const pipeline = createConnectorPipeline({binding, store: tracked, search});
    async function ingest(stream, data, extractedAt, suffix) {
      const key = `${binding.rawPrefix}stream=${stream}/date=2026-11-04/sync=1/${suffix}.jsonl.gz`;
      await tracked.put(key, gzipSync(JSON.stringify({_airbyte_extracted_at: extractedAt, _airbyte_data: data}) + '\n'));
      return pipeline.processObject({key});
    }
    const principal = {tenantId};
    await ingest('channels', {id: 'C123', name: 'general', is_private: false}, 1000, 'channel');
    const message = {channel_id: 'C123', ts: '1234567890.000001', text: `pineapple current ${tenant}`, blocks: [{type: 'section', text: {type: 'mrkdwn', text: 'Full block body with searchable kumquat conclusion'}}], attachments: [{text: 'Attachment has dragonfruit details'}]};
    await ingest('channel_messages', message, 2000, 'current');
    await ingest('threads', {...message, text: 'obsolete grapefruit'}, 1000, 'older');
    await ingest('threads', {...message, ts: '1234567891.000001', thread_ts: message.ts, text: 'pineapple thread reply', blocks: [], attachments: []}, 2000, 'reply');
    await ingest('channel_messages', message, 2000, 'duplicate');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 2);
    assert.equal((await search.search(principal, [binding], {query: 'grapefruit'})).hits.length, 0);
    assert.equal((await search.search(principal, [binding], {query: 'kumquat'})).hits.length, 1);
    assert.equal((await search.search(principal, [binding], {query: 'dragonfruit'})).hits.length, 1);
    // Direct history is authoritative even when a newer search snapshot exists.
    await ingest('canonical_messages', {...message,text:'pineapple canonicalguava',blocks:[],attachments:[]}, 1500, 'canonical');
    await ingest('channel_messages', {...message,text:'searchpreviewpapaya',blocks:[],attachments:[]}, 3000, 'newer-preview');
    await search.refresh();
    assert.equal((await search.search(principal,[binding],{query:'canonicalguava'})).hits.length,1);
    assert.equal((await search.search(principal,[binding],{query:'searchpreviewpapaya'})).hits.length,0);
    await ingest('canonical_messages',{...message,text:'pineapple shorterquince',blocks:[],attachments:[]},4000,'canonical-edit');
    await ingest('canonical_messages',{...message,text:'canonicalguava',blocks:[],attachments:[]},1500,'canonical-replay');
    await search.refresh();
    assert.equal((await search.search(principal,[binding],{query:'canonicalguava'})).hits.length,0);
    assert.equal((await search.search(principal,[binding],{query:'shorterquince'})).hits.length,1);
    await search.suppress(principal, binding, {kind: 'message', sourceId: 'C123:' + message.ts});
    await ingest('channel_messages', message, 3000, 'after-suppression');
    await ingest('canonical_messages',message,5000,'canonical-after-suppression');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 1);
    await ingest('channels', {id: 'C123', name: 'general', is_private: true}, 4000, 'private');
    await search.refresh();
    assert.equal((await search.search(principal, [binding], {query: 'pineapple'})).hits.length, 0);
    handles.push({search, binding, principal});
  }
  await assert.rejects(handles[0].search.search(handles[1].principal, [handles[0].binding], {query: 'pineapple'}), /scope/);
});

test('real S3/OpenSearch: workspace providers, linked passages, shorter edits, replay and isolation', {
  skip: !process.env.OPENCRAWL_TEST_S3_ENDPOINT || !process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
}, async t => {
  const run = randomUUID(), tenantId = `workspace-${run}`, objects = [], index = realmIndex('test', tenantId);
  const store = createObjectStore({endpoint: process.env.OPENCRAWL_TEST_S3_ENDPOINT, bucket: 'capture-test', credentials: {accessKeyId: 'capture-test', secretAccessKey: 'capture-test-secret'}});
  const search = createConnectorSearch({endpoint: process.env.OPENCRAWL_TEST_OPENSEARCH_URL, index, tenantId});
  t.after(async () => {for (const key of objects) await store.delete(key); await fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL + '/' + index, {method: 'DELETE'});});
  const tracked = {...store, put: async (key, bytes, type) => {objects.push(key); await store.put(key, bytes, type);}};
  await search.ensureIndex();
  const principal = {tenantId}, date = '2026-11-05T12:00:00Z';
  for (const provider of ['notion', 'granola', 'circleback', 'github']) {
    const connectionId = `${provider}-${run}`;
    const binding = {tenantId, connectionId, workspaceId: 'workspace', provider, access: 'workspace-global', rawPrefix: `raw/v1/source=${provider}/workspace=workspace/connection=${connectionId}/`};
    const pipeline = createConnectorPipeline({binding, store: tracked, search});
    async function raw(stream, data, name = '1', at = 2000) {
      const key = `${binding.rawPrefix}stream=${stream}/date=2026-11-05/sync=1/${name}.jsonl.gz`;
      await tracked.put(key, gzipSync((Array.isArray(data) ? data : [data]).map(d => JSON.stringify({_airbyte_extracted_at: at, _airbyte_data: d})).join('\n')));
    }
    async function runPipeline() {let records = 0; const page = await pipeline.listPage(); for (const key of page.keys) records += (await pipeline.processObject({key})).records; await search.refresh(); return records;}
    if (provider === 'notion') {
      await raw('pages', {id: 'p', last_edited_time: date, properties: {Title: {type: 'title', title: [{plain_text: 'Plan'}]}}});
      await runPipeline(); // Partial source arrival must be superseded at equal timestamps.
      await raw('page_markdown', {id: 'p', page_last_edited_time: date, markdown: '# Topic\n' + 'Pineapple obsolete detail for a long page.\n'.repeat(160)});
    } else if (provider === 'github') {
      await raw('commits', {repository: 'team/repo', sha: 'abc', message: 'Pineapple commit', committer_date: date, files: [{patch: 'excludedcode'}]});
      await raw('pull_requests', {repository: 'team/repo', number: 1, title: 'Review', body: 'Pineapple PR', updated_at: date, reviews: [{id: 1, body: 'Pineapple review'}]});
    } else {
      const granola = provider === 'granola';
      await raw(granola ? 'notes' : 'meetings', granola ? {id: 'm', title: 'Plan', summary_text: 'Pineapple summary', updated_at: date} : {id: 'm', name: 'Plan', notes: 'Pineapple summary', updatedAt: date});
      await raw('transcripts', Array.from({length: 60}, (_, i) => granola ? {note_id: 'm', note_updated_at: date, speaker: {name: 'Ada'}, start_time: String(i), text: 'Pineapple transcript with useful detailed context.'} : {meeting_id: 'm', meeting_updated_at: date, speaker: 'Ada', timestamp: i, text: 'Pineapple transcript with useful detailed context.'}));
    }
    assert.ok(await runPipeline() > 0);
    const result = await search.search(principal, [binding], {query: 'pineapple'});
    assert.ok(result.hits.length > 0, provider); assert.ok(result.hits.every(d => d.provider === provider && d.connectionId === connectionId));
    if (provider !== 'github') assert.ok(result.hits.some(d => d.parentId), provider);
    assert.equal(await runPipeline(), 0);
    await assert.rejects(search.search({tenantId: 'other'}, [binding], {query: 'pineapple'}), /scope/);
    if (provider === 'notion') {
      await raw('page_markdown', {id: 'p', page_last_edited_time: '2026-11-06T12:00:00Z', markdown: 'Pineapple replacement'}, 'shorter', 3000);
      await runPipeline();
      assert.equal((await search.search(principal, [binding], {query: 'obsolete'})).hits.length, 0);
      assert.equal((await search.search(principal, [binding], {query: 'replacement'})).hits.length, 1);
      // A later extraction of an older source revision cannot undo that edit.
      await raw('page_markdown', {id: 'p', page_last_edited_time: date, markdown: 'Obsolete stale'}, 'stale', 4000);
      await runPipeline();
      assert.equal((await search.search(principal, [binding], {query: 'obsolete'})).hits.length, 0);
    }
  }
});

test('real S3/OpenSearch: complete file suffixes, shorter replacement, late replay and file suppression', {
 skip:!process.env.OPENCRAWL_TEST_S3_ENDPOINT||!process.env.OPENCRAWL_TEST_OPENSEARCH_URL,
},async t=>{
 const {createHash}=await import('node:crypto');
 const run=randomUUID(),tenantId='file-'+run,objects=[],index=realmIndex('test',tenantId);
 const binding={tenantId,connectionId:run,workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:`raw/v1/source=slack/workspace=T123/connection=${run}/`};
 const store=createObjectStore({endpoint:process.env.OPENCRAWL_TEST_S3_ENDPOINT,bucket:'capture-test',credentials:{accessKeyId:'capture-test',secretAccessKey:'capture-test-secret'}});
 const tracked={...store,put:async(k,v,type)=>{objects.push(k);await store.put(k,v,type);}};
 const search=createConnectorSearch({endpoint:process.env.OPENCRAWL_TEST_OPENSEARCH_URL,index,tenantId}),principal={tenantId};
 t.after(async()=>{for(const key of objects)await store.delete(key);await fetch(process.env.OPENCRAWL_TEST_OPENSEARCH_URL+'/'+index,{method:'DELETE'});});
 await search.ensureIndex();const pipeline=createConnectorPipeline({binding,store:tracked,search});
 async function ingest(stream,data,at,name){const key=binding.rawPrefix+`stream=${stream}/date=2026-11-05/sync=test/${name}.jsonl.gz`;await tracked.put(key,gzipSync(JSON.stringify({_airbyte_extracted_at:at,_airbyte_data:data})+'\n'));await pipeline.processObject({key});await search.refresh();}
 async function file(text,at,name){const bytes=Buffer.from(text),sha=createHash('sha256').update(bytes).digest('hex'),content_key=binding.rawPrefix+'files/sha256/'+sha+'.bin';await tracked.put(content_key,bytes,'text/plain');await ingest('file_documents',{format_version:1,id:'F1',channel_id:'C1',available:true,media_type:'text/plain',content_key,content_sha256:sha,content_bytes:bytes.length},at,name);}
 await ingest('channels',{id:'C1',is_private:false},1,'channel');
 await file('body '.repeat(40000)+' farawaydragonfruit',1000,'long');
 assert.equal((await search.search(principal,[binding],{query:'farawaydragonfruit'})).hits.length,1);
 await file('short replacementquince',2000,'short');
 assert.equal((await search.search(principal,[binding],{query:'farawaydragonfruit'})).hits.length,0);
 assert.equal((await search.search(principal,[binding],{query:'replacementquince'})).hits.length,1);
 await file('obsolete latepapaya',1000,'late');
 assert.equal((await search.search(principal,[binding],{query:'latepapaya'})).hits.length,0);
 await search.suppress(principal,binding,{kind:'file',sourceId:'C1:F1'});
 await file('resurrectedpineapple',3000,'suppressed');
 assert.equal((await search.search(principal,[binding],{query:'resurrectedpineapple'})).hits.length,0);
});
