import {applicationDatabase} from './settings.mjs';
import {sessionStorage} from '../sessions/storage.mjs';
import {requireScopedState} from './scoped.mjs';
import {createOnboardingRepository} from './onboarding.mjs';

if(import.meta.main){
  const [command,...rest]=process.argv.slice(2);
  if(!['status','migrate','verify','restore'].includes(command) || rest.length)throw Error('Specify status, migrate, verify or restore');
  const database=applicationDatabase(), {store,prefix}=sessionStorage();
  try{
    await requireScopedState(database);
    const receipts=createOnboardingRepository(database,store,prefix);
    console.log(JSON.stringify(await receipts[command as 'status'|'migrate'|'verify'|'restore']()));
  }finally{await database.close();}
}
