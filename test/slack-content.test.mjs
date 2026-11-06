import {test} from 'node:test';
import assert from 'node:assert/strict';
import {slackMessageText} from '../src/connectors/slack-content.mjs';
import {normalizeSlack} from '../src/connectors/slack.mjs';
const binding={tenantId:'team',connectionId:'slack',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=slack/'};

test('a nonempty notification fallback does not hide the complete message blocks',()=>{
  const fallback='Preview '+'.'.repeat(600)+'…';
  const item=normalizeSlack(binding,'threads',{_airbyte_extracted_at:1000,_airbyte_data:{channel_id:'C123',ts:'1234567890.000001',thread_ts:'1234567889.000001',text:fallback,
    blocks:[{type:'header',text:{type:'plain_text',text:'Incident update'}},{type:'section',text:{type:'mrkdwn',text:'Full investigation includes the missing searchable suffix.'}}]}},'raw');
  assert.ok(item.document.text.includes(fallback));assert.ok(item.document.text.includes('missing searchable suffix'));
  assert.equal(item.document.threadTs,'1234567889.000001');
});
test('block-only rich text, lists, tables and link labels retain readable content',()=>{
 const body=slackMessageText({blocks:[{type:'rich_text',elements:[{type:'rich_text_list',elements:[{type:'rich_text_section',elements:[{type:'text',text:'Nested item'},{type:'link',text:'Design document',url:'https://example.com/design'}]}]}]},
 {type:'table',rows:[[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text:'Table conclusion'}]}]}]]}]});
 for(const word of ['Nested item','Design document','https://example.com/design','Table conclusion'])assert.ok(body.includes(word));
});
test('visible attachment fields and file labels are indexed without hidden metadata',()=>{
 const body=slackMessageText({text:'Message',metadata:{secret:'DO_NOT_INDEX'},blocks:[{type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'View report'},value:'HIDDEN_ACTION_VALUE',action_id:'HIDDEN_ACTION_ID'}]}],
 attachments:[{title:'Incident report',text:'Complete report body',fields:[{title:'Resolution',value:'Recovered normally'}],blocks:[{type:'section',text:{type:'plain_text',text:'Attachment block body'}}],private_metadata:'HIDDEN_METADATA'}],
 files:[{title:'diagram.png',url_private:'HIDDEN_PRIVATE_URL'}]});
 for(const word of ['View report','Complete report body','Recovered normally','Attachment block body','diagram.png'])assert.ok(body.includes(word));
 assert.ok(!body.includes('HIDDEN_'));assert.ok(!body.includes('DO_NOT_INDEX'));
});
test('plain-text mirrors do not duplicate fallback text and real shorter edits stay shorter',()=>{
 assert.equal(slackMessageText({text:'Hello world',blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text:'Hello world'}]}]}]}),'Hello world');
 assert.equal(slackMessageText({text:'Short edited body'}),'Short edited body');
 const full='x'.repeat(200000);
 assert.equal(slackMessageText({text:full,blocks:[{type:'section',text:{type:'plain_text',text:full}}]}),full);
});
test('combined content is bounded and invalid structures do not silently acknowledge loss',()=>{
 assert.throws(()=>slackMessageText({text:'x'.repeat(200000),blocks:[{type:'section',text:{type:'plain_text',text:'y'.repeat(100000)}}]}),/exceeds/);
 assert.throws(()=>slackMessageText({blocks:{text:'not a list'}}),/list/);
 assert.throws(()=>slackMessageText({attachments:[{text:123}]}),/text/);
 let nested={type:'text',text:'deep'};for(let i=0;i<30;i++)nested={type:'rich_text',elements:[nested]};
 assert.throws(()=>slackMessageText({blocks:[nested]}),/complex/);
});

test('rich-text phrases retain repeated words and words contained inside fallback tokens',()=>{
 const body=slackMessageText({text:'notification preview',blocks:[{type:'rich_text',elements:[{type:'rich_text_section',elements:[{type:'text',text:'do '},{type:'text',text:'not'},{type:'text',text:' do this'}]}]}]});
 assert.equal(body,'notification preview\ndo not do this');
});

test('inline formatting preserves whole words, link phrases and explicit line boundaries',()=>{
 const elements=[{type:'text',text:'inter'},{type:'text',text:'oper',style:{bold:true}},{type:'text',text:'ability and '},{type:'link',text:'linked',url:'https://example.com'},{type:'text',text:' words\nnext line'}];
 for(const type of ['rich_text_section','rich_text_quote','rich_text_preformatted']) {
  const body=slackMessageText({blocks:[{type:'rich_text',elements:[{type,elements},{type:'rich_text_section',elements:[{type:'text',text:'Separate paragraph'}]}]}]});
  assert.equal(body,'interoperability and linked words\nnext line\nhttps://example.com\nSeparate paragraph');
 }
});

test('visible menu labels, descriptions and confirmations survive without action payloads',()=>{
 const option={text:{type:'plain_text',text:'Escalate incident'},description:{type:'plain_text',text:'Page the on-call team'},value:'HIDDEN_ACTION_PAYLOAD'};
 const body=slackMessageText({blocks:[{type:'section',text:{type:'mrkdwn',text:'Incident actions'},accessory:{type:'overflow',options:[option],confirm:{title:{type:'plain_text',text:'Confirm escalation'},text:{type:'mrkdwn',text:'This pages the current responder.'},confirm:{type:'plain_text',text:'Escalate now'},deny:{type:'plain_text',text:'Keep investigating'}}}},
 {type:'actions',elements:[{type:'static_select',placeholder:{type:'plain_text',text:'Choose a severity'},option_groups:[{label:{type:'plain_text',text:'Customer impact'},options:[{text:{type:'plain_text',text:'Major outage'},value:'HIDDEN_SEVERITY'}]}]},
 {type:'external_select',initial_option:{text:{type:'plain_text',text:'Already selected item'},value:'HIDDEN_EXTERNAL'}}]}]});
 for(const text of ['Escalate incident','Page the on-call team','Confirm escalation','This pages the current responder.','Escalate now','Keep investigating','Choose a severity','Customer impact','Major outage','Already selected item'])assert.ok(body.includes(text),text);
 assert.ok(!body.includes('HIDDEN_'));
});
test('attachment attribution and both file labels remain searchable',()=>{
 const body=slackMessageText({attachments:[{service_name:'Incident service',text:'Alert body'}],files:[{title:'Release report',name:'release-2026.txt',url_private:'HIDDEN_DOWNLOAD'}]});
 for(const text of ['Incident service','Release report','release-2026.txt'])assert.ok(body.includes(text));
 assert.ok(!body.includes('HIDDEN_'));
});

test('presentation-node fallback text remains available even with populated blocks',()=>{
 const body=slackMessageText({blocks:[{type:'rich_text',fallback:'Accessible representation',elements:[{type:'rich_text_section',elements:[{type:'text',text:'Rendered content'}]}]}]});
 assert.ok(body.includes('Accessible representation'));assert.ok(body.includes('Rendered content'));
});
