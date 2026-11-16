import {createSqliteEngine} from '../../dist/src/search/sqlite-engine.mjs';
process.on('message',async({id,command})=>{
 if(command.operation==='ensureIndex')return process.send({id,result:{environment:Object.keys(process.env),flags:process.execArgv}});
 const realm=createSqliteEngine(command.realm);
 await realm.collection(command.corpus).bulk(...command.args);
 // Simulate a committed write whose acknowledgement never reaches its parent.
 // Only the executor deadline can settle this fixture.
});
