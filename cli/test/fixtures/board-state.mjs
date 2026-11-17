import {boardIdentity} from '../../../dist/src/board/identity.mjs';
// Volatile repository for CLI protocol/process tests on all three platforms.
// Core repository, restart and concurrency acceptance runs against PostgreSQL.
export function fixtureBoardState(){
  const tenants=new Map();let pending=Promise.resolve();
  const copy=structuredClone,empty=()=>({head:0,messages:[],agents:{},participants:{},participantsPresent:false,usage:{calls:0,inputBytes:0,outputBytes:0}});
  function reader(data){
    const messages=({before,after,through,topic,threadId,rootsOnly,limit,descending=false})=>data.messages.filter(m=>(before===undefined||m.id<before)&&(after===undefined||m.id>after)&&(through===undefined||m.id<=through)&&(topic===undefined||m.topic===topic)&&(threadId===undefined||m.threadId===threadId)&&(!rootsOnly||m.threadId===undefined)).sort((a,b)=>descending?b.id-a.id:a.id-b.id).slice(0,limit);
    return {
      async replyCounts(roots){return Object.fromEntries(roots.map(id=>[id,data.messages.filter(m=>m.threadId===id).length]));},
      async metadata(){return {head:data.head,usage:copy(data.usage),participantsPresent:data.participantsPresent};},
      async message(id){return copy(data.messages.find(m=>m.id===id)??null);},async messages(input){return copy(messages(input));},
      async messagesByIds(ids){return copy(data.messages.filter(m=>ids.includes(m.id)));},
      async agentNames(ids){return Object.fromEntries(data.messages.filter(m=>ids.includes(m.agent)).map(m=>[m.agent,m.name]));},
      async participant(id){return copy(data.participants[id]??null);},async participants(){return copy(data.participants);},
      async profiles(){return Object.fromEntries(Object.entries(data.participants).map(([id,{pending,...p}])=>[id,copy(p)]));},
      async profileByName(name,userId){const entry=Object.entries(data.participants).find(([,p])=>p.userId===userId&&p.name.toLowerCase()===name.toLowerCase());return entry?{id:entry[0]}:null;},
      async agentProfiles({after,limit,cutoff,active,query}){return Object.entries(data.participants).filter(([,p])=>p.name&&(!active||!p.left&&p.seen>cutoff)&&`${p.name} ${p.task}`.toLowerCase().includes(query.toLowerCase())).sort(([a,p],[b,q])=>q.seen-p.seen||a.localeCompare(b)).slice(after,after+limit).map(([,p])=>copy(p));},
      async directory({after,limit,cutoff}){const all=Object.entries(data.participants).filter(([,p])=>p.seen>cutoff).sort(([a,p],[b,q])=>q.seen-p.seen||a.localeCompare(b));return {total:all.length,agents:all.slice(after,after+limit).map(([id,p])=>({id,participant:{...copy(p),pending:p.pending?{...copy(p.pending),count:p.pending.messages.length}:null}}))};},
      async agents(){return copy(data.agents);},
      async topics(){const topics=new Map();for(const m of data.messages){const value=topics.get(m.topic)??{topic:m.topic,first:m.id,posts:0};value.posts++;value.latest={id:m.id,timestamp:m.timestamp,name:m.name};topics.set(m.topic,value);}return [...topics.values()];},
      async unread({after,through,topics,mention,userId,agent,name,limit}){return copy(messages({after,through,limit:Infinity}).filter(m=>(topics.includes(m.topic)||m.mentions?.includes(mention)||m.system&&m.threadId===undefined)&&!(m.author===userId&&(m.agent===agent||m.name.toLowerCase()===name.toLowerCase()&&(m.agent===boardIdentity(m.author,m.name)||data.participants[m.agent]?.name.toLowerCase()===name.toLowerCase())))).slice(0,limit));},
      async publication({userId,agent,name,requestId,registered}){return copy(data.messages.find(m=>m.author===userId&&m.requestId===requestId&&(m.agent===agent||registered&&m.name.toLowerCase()===name.toLowerCase()&&m.agent===boardIdentity(m.author,m.name)))??null);},
      async putParticipant(id,value){data.participants[id]=copy(value);data.participantsPresent=true;},async removeParticipant(id){delete data.participants[id];},
      async putAgent(id,value){data.agents[id]=copy(value);},async removeAgent(id){delete data.agents[id];},
      async append(input){const value={...copy(input),id:++data.head};data.messages.push(value);return copy(value);},
      async addUsage(inputBytes,outputBytes){data.usage.calls++;data.usage.inputBytes+=inputBytes;data.usage.outputBytes+=outputBytes;},
    };
  }
  function transaction(tenant,run){const result=pending.then(async()=>{const data=copy(tenants.get(tenant)??empty());const value=await run(reader(data));tenants.set(tenant,data);return value;});pending=result.catch(()=>{});return result;}
  return {namespace:'cli-fixture',board:{transaction,read:(tenant,run)=>pending.then(()=>run(reader(copy(tenants.get(tenant)??empty())))),async search(tenant,_owner,args){
    await pending;const data=tenants.get(tenant)??empty();
    const rows=data.messages.filter(m=>(args.thread===undefined||m.id===args.thread||m.threadId===args.thread)&&(!args.topics.length||args.topics.includes(m.topic))&&(!args.agents.length||args.agents.includes(m.name))&&(!args.query||m.text.includes(args.query))&&(args.after===undefined||m.id>args.after)&&(args.before===undefined||m.id<args.before));
    rows.sort((a,b)=>args.sort==='oldest'?a.id-b.id:b.id-a.id);
    return {messages:copy(rows.slice(0,args.limit)),next:null,total:rows.length,through:data.head};
  }}};
}
