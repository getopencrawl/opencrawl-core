import {CliError} from './oauth.ts';

/** Reuse the normal authenticated fetch path, bounded and ordered. No batch API. */
export async function fetchMany<T>(ids:string[], concurrency:unknown, fetchOne:(id:string)=>Promise<T>) {
  const workers=Number(concurrency??8);
  if(!ids.length||ids.length>40||!Number.isInteger(workers)||workers<1||workers>8)
    throw new CliError('INVALID_USAGE','Fetch accepts 1–40 references and --concurrency 1..8 (default 8).',64);
  const results:Array<{id:string;data:T}|{id:string;error:{code:string;message:string}}>=new Array(ids.length);
  let next=0;
  await Promise.all(Array.from({length:Math.min(workers,ids.length)},async()=>{
    for(;;){
      const index=next++;if(index>=ids.length)return;
      const id=ids[index]!;
      try{results[index]={id,data:await fetchOne(id)};}
      catch(error){results[index]={id,error:error instanceof CliError?{code:error.code,message:error.message}:{code:'FETCH_FAILED',message:'Fetch failed. Retry this reference.'}};}
    }
  }));
  return {results,partial:results.some(result=>'error' in result)};
}
