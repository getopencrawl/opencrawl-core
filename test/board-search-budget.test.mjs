import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boardStateFixture,boardTenant,postgresUrl} from './fixtures/board-state.mjs';
import {createBoardSearch} from '../dist/src/board/search.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);

live('lexical facet matching scans chunks per query term rather than once per message',async t=>{
 const f=await boardStateFixture(t),principal={tenantId:'lexical-budget',userId:'writer'};
 const messages=Array.from({length:512},(_,i)=>({id:i+1,timestamp:1700000000000+i,topic:i%2?'work':'release',agent:'writer',author:'writer',name:'codex:writer',text:i%2?'needle extra':'needle',requestId:String(i)}));
 // The two terms also match when they live in different indexed chunks.
 messages[0].text='needle '+ 'padding '.repeat(5000)+' extra';
 await f.repository.importLegacy(boardTenant(principal.tenantId),{schema:1,messages,agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}});
 const search=createBoardSearch({state:f.state}),original=f.database.transaction.bind(f.database),plans=[];
 f.database.transaction=run=>original(async client=>{
  const query=client.query.bind(client);
  client.query=async(sql,values)=>{
   if(String(sql).includes('SELECT m.topic value,count(*)'))plans.push((await query('EXPLAIN (ANALYZE,FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0].Plan);
   return query(sql,values);
  };
  try{return await run(client);}finally{client.query=query;}
 });
 try{
  const one=await search.search(principal,{query:'needle',facets:['topic']});assert.equal(one.total,512);
  assert.deepEqual(one.facets.topic.values,[{value:'release',count:256},{value:'work',count:256}]);
  const two=await search.search(principal,{query:'needle extra',agents:['@CODEX:WRITER'],facets:['topic']});assert.equal(two.total,257);
  assert.deepEqual(two.facets.topic.values,[{value:'work',count:256},{value:'release',count:1}]);
  const walk=node=>[node,...(node.Plans??[]).flatMap(walk)];
  assert.equal(plans.length,2);
  for(const [index,plan]of plans.entries()){
   const nodes=walk(plan),rejected=nodes.reduce((total,node)=>total+(node['Rows Removed by Join Filter']??0)*node['Actual Loops'],0);
   assert.ok(rejected<=messages.length*(index+2),`query performed ${rejected} rejected join comparisons`);
   const scans=nodes.filter(node=>node['Relation Name']==='opencrawl_board_search_chunks');
   assert.ok(scans.length>0);
   const loops=scans.reduce((total,node)=>total+node['Actual Loops'],0);
   assert.ok(loops<=index+1,`expected at most ${index+1} chunk scans, observed ${loops}; the former correlated query performed at least 512`);
  }
 }finally{f.database.transaction=original;}
});
