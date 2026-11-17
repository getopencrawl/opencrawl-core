import {test,expect} from 'bun:test';
import {PassThrough} from 'node:stream';
import {connectWorkload,readEnrollmentCode,type EnrollmentFetch} from '../src/workload-enrollment.ts';
import {withEnvironmentTokenOrigin} from '../src/environment-token.ts';

const code='a'.repeat(64),api='https://workload.example',org='org-11111111111141118111111111111111';
async function mode(run:()=>Promise<void>){
  const saved={...process.env};process.env.OPENCRAWL_AUTH='devin-cloud';delete process.env.OPENCRAWL_TOKEN;delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  try{await run();}finally{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
}
const result={connected:true,organizationId:org,tenantId:'org_fixture'};

test('enrollment reads one bounded code without waiting for stdin to close or echoing rejected content',async()=>{
  const input=new PassThrough(),reading=readEnrollmentCode(input);input.write(code+'\n');expect(await reading).toBe(code);
  for(const value of ['private-invalid',code+'\n'+code,'x'.repeat(129)]){
    const input=new PassThrough(),reading=readEnrollmentCode(input);input.end(value);
    await expect(reading).rejects.toMatchObject({code:'INVALID_SETUP_CODE',message:'Supply one current setup code on stdin.'});
  }
  await expect(readEnrollmentCode(new PassThrough(),5)).rejects.toHaveProperty('code','INVALID_SETUP_CODE');
});

test('connect uses only the selected provider endpoint and refreshes one rejected token',()=>mode(async()=>{
  const seen:Array<{url:string,init:RequestInit}>=[],mints:Array<string|undefined>=[];
  const connected=await connectWorkload(api,code,{mint:async(_api,rejected)=>{mints.push(rejected);return rejected?'fresh-identity':'initial-identity';},fetcher:(async(url,init)=>{
    seen.push({url:String(url),init:init!});return seen.length===1?new Response('must not print',{status:401}):Response.json(result);
  }) as EnrollmentFetch});
  expect(connected).toEqual({provider:'devin',...result});expect(mints).toEqual([undefined,'initial-identity']);
  expect(seen.map(row=>row.url)).toEqual([api+'/api/devin/connect',api+'/api/devin/connect']);
  expect(seen.every(row=>row.init.redirect==='error'&&row.init.body===JSON.stringify({code}))).toBe(true);
  expect(seen[1]!.init.headers).toEqual({authorization:'Bearer fresh-identity','content-type':'application/json'});
  process.env.OPENCRAWL_AUTH='replicas-workspace';
  await connectWorkload(api,code,{mint:async()=> 'replicas-identity',fetcher:(async url=>{expect(String(url)).toBe(api+'/api/replicas/connect');return Response.json({...result,organizationId:'11111111-1111-4111-8111-111111111111'});}) as EnrollmentFetch});
}));

test('enrollment rejects human credentials and unknown modes before minting or network',()=>mode(async()=>{
  let calls=0;const options={mint:async()=>{calls++;return 'unused';},fetcher:(async()=>{calls++;return Response.json(result);}) as EnrollmentFetch};
  process.env.OPENCRAWL_TOKEN='must-not-use';await expect(connectWorkload(api,code,options)).rejects.toHaveProperty('code','AUTH_MODE_CONFLICT');delete process.env.OPENCRAWL_TOKEN;
  delete process.env.OPENCRAWL_AUTH;await expect(connectWorkload(api,code,options)).rejects.toHaveProperty('code','WORKLOAD_IDENTITY_REQUIRED');
  process.env.OPENCRAWL_AUTH='unknown';await expect(connectWorkload(api,code,options)).rejects.toHaveProperty('code','INVALID_AUTH_MODE');expect(calls).toBe(0);
}));

test('connection failures and malformed responses never echo credentials or claim success',()=>mode(async()=>{
  for(const status of [400,401,403,409,429,503,302]){
    let calls=0;
    const error=await connectWorkload(api,code,{mint:async()=> 'secret-token',fetcher:(async()=>{calls++;return new Response('secret-token '+code,{status,headers:{location:'https://foreign.example'}});}) as EnrollmentFetch}).catch(error=>error);
    expect(error).toBeInstanceOf(Error);expect(error.message).not.toContain(code);expect(error.message).not.toContain('secret-token');
    expect(calls).toBe(status===401?2:1);
  }
  for(const body of [{...result,connected:false},{...result,tenantId:'invalid\nsecret'},'secret-token',null,{...result,extra:'x'.repeat(5000)}])
    await expect(connectWorkload(api,code,{mint:async()=> 'secret-token',fetcher:(async()=>Response.json(body)) as EnrollmentFetch})).rejects.toHaveProperty('code','WORKLOAD_PROTOCOL_ERROR');
  await expect(connectWorkload(api,code,{mint:async()=> 'secret-token',fetcher:(async()=>{throw Error(code);}) as EnrollmentFetch})).rejects.toMatchObject({code:'WORKLOAD_CONNECT_UNAVAILABLE',message:'The cloud connection could not be confirmed. Retry the same setup code from this session.'});
}));
