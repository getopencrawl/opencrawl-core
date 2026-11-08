import test from 'node:test';
import assert from 'node:assert/strict';
import {searchGroups} from '../src/pages/diagnostics.tsx';
import type {DiagnosticSearch} from '../src/pages/types.ts';
import {workspaceSearchDiagnostics} from '../src/reference/search.ts';

test('diagnostics includes current agent memories without losing text, score, provenance or coverage', () => {
  const memory = {_id:'memory-current',_score:4.25,_source:{title:'Project preferences',text:'Use the shared React shell.',path:'memory/project.md',snapshotId:'snapshot-current',generation:3,kind:'agent_memory'}};
  const result: DiagnosticSearch = {
    sessions:[{scope:'workspace',response:{hits:{hits:[{_id:'session-one'}]}}}],
    connectors:{responses:[{hits:{hits:[{_id:'connector-one'}]}}]},
    memories:{state:'ready',truncated:true,hits:{total:{value:12},hits:[memory]}},
  };
  const groups = searchGroups(result);
  assert.deepEqual(groups.map(group => group.label),['Agent sessions','Connected sources','Agent memories']);
  assert.equal(groups.reduce((total,group) => total + group.hits.length,0),3);
  const memories = groups.find(group => group.label === 'Agent memories');
  assert.equal(memories?.hits[0],memory,'metadata and JSON must retain the complete authorized hit');
  assert.equal(memories?.total,12);
  assert.equal(memories?.state,'ready');
  assert.ok(memories && 'truncated' in memories);
  assert.equal(memories.truncated,true);
});

test('memory coverage remains visible when its index is pending or unconfigured', () => {
  assert.equal(searchGroups({sessions:[]}).length,0,'older adapters do not fabricate a memory group');
  for (const state of ['pending','not_configured']) {
    const [group] = searchGroups({memories:{state}});
    assert.equal(group?.label,'Agent memories');
    assert.equal(group?.state,state);
    assert.deepEqual(group?.hits,[]);
  }
});

test('single-tenant diagnostics keeps memory passages in their own group with source-specific coverage', () => {
  const provenance = {path:'memory/project.md',snapshotId:'current-snapshot',generation:3,harness:'codex',kind:'agent_memory',userId:'operator'};
  const result = workspaceSearchDiagnostics({
    results:[
      {id:'sessions:first',source:'sessions',title:'Recorded task',text:'Session evidence',provenance:{sessionId:'first'}},
      {id:'memories:current',source:'memories',title:'Project preferences',text:'Use the shared React shell.',provenance},
    ],
    coverage:[{source:'sessions',state:'ready',truncated:false},{source:'connectors',state:'not_configured',truncated:false},{source:'memories',state:'ready',truncated:true}],
    truncated:true,
  });
  const groups = searchGroups(result), memories = groups.find(group => group.label === 'Agent memories');
  assert.deepEqual(memories?.hits,[{_id:'memories:current',_source:{...provenance,title:'Project preferences',text:'Use the shared React shell.',provenance,passageId:'memories:current'}}]);
  assert.ok(memories && 'truncated' in memories);
  assert.equal(memories.truncated,true);
  const connectors = groups.find(group => group.label === 'Connected sources');
  assert.ok(connectors && 'truncated' in connectors);
  assert.equal(connectors.truncated,false);
  assert.equal(result.sessions?.[0]?.response.hits?.hits?.[0]?._id,'sessions:first');
  assert.equal(workspaceSearchDiagnostics({results:[],coverage:[]}).memories,undefined);
  assert.equal(workspaceSearchDiagnostics({coverage:[{source:'memories',state:'pending'}]}).memories?.state,'pending');
});
