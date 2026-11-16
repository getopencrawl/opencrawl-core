import {createSqliteEngine} from './sqlite-engine.mjs';
import type {SqliteCommand,SqliteError,SqliteReply} from './sqlite-protocol.mjs';

// This entrypoint is private to the bounded parent pool. It never accepts SQL,
// runtime credentials or arbitrary method names. Each request opens/closes its DB.
if(!process.send)throw new Error('SQLite worker requires its parent IPC channel');
let busy=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async(message:{id:number;command:SqliteCommand})=>{
 if(busy||!Number.isSafeInteger(message?.id))return process.exit(1);
 busy=true;
 let reply:SqliteReply;
 try{
  const command=message.command,realm=createSqliteEngine(command.realm);let result:unknown;
  if(command.operation==='ensureIndex')result=await realm.ensureIndex();
  else if(command.operation==='refresh')result=await realm.refresh(...command.args);
  else{
   const collection=realm.collection(command.corpus);
   switch(command.operation){
    case 'search':result=await collection.search(...command.args);break;
    case 'mget':result=await collection.mget(...command.args);break;
    case 'bulk':result=await collection.bulk(...command.args);break;
    case 'delete':result=await collection.delete(...command.args);break;
    case 'byQuery':result=await collection.byQuery(...command.args);break;
    case 'update':result=await collection.update(...command.args);break;
    default:throw new Error('Invalid SQLite worker operation');
   }
  }
  reply={id:message.id,result};
 }catch(caught){
  const value=caught as Partial<SqliteError>,error:SqliteError={message:typeof value?.message==='string'?value.message:'SQLite operation failed'};
  if(typeof value?.status==='number')error.status=value.status;
  if(typeof value?.permanent==='boolean')error.permanent=value.permanent;
  if(typeof value?.code==='string')error.code=value.code;
  if(value?.writeOutcome==='not-applied')error.writeOutcome='not-applied';
  reply={id:message.id,error};
 }
 busy=false;
 process.send!(reply,undefined,undefined,(error:Error|null)=>{if(error)process.exit(1);});
});
