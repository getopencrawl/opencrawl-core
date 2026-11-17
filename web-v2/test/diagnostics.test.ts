import test from 'node:test';
import assert from 'node:assert/strict';
import {searchGroups} from '../src/pages/diagnostics.tsx';
import type {DiagnosticSearch} from '../src/pages/types.ts';

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

