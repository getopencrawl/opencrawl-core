import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

interface Input {format:number;origin:string;connectOrigin:string;organization:string;email:string;password:string;setupToken:string}
const input=JSON.parse(readFileSync('/dev-state/seed-input.json','utf8')) as Input;
if(input.format!==1||input.organization!==process.env.OPENCRAWL_ORGANIZATION_ID||input.connectOrigin!=='http://app:8092')throw new Error('Development bootstrap scope mismatch');
const cookies=new Map<string,string>();
async function request(path:string,fields?:Record<string,string>){
  const response=await fetch(input.connectOrigin+path,{method:fields?'POST':'GET',redirect:'manual',headers:{host:new URL(input.origin).host,
    cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(fields?{origin:input.origin,'content-type':'application/x-www-form-urlencoded'}:{})},
    body:fields?new URLSearchParams(fields):undefined,signal:AbortSignal.timeout(30000)});
  for(const line of response.headers.getSetCookie()){const [pair]=line.split(';'),i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
  return response;
}
let login=await request('/auth/login',{email:input.email,password:input.password});
let created=false;
if(login.status===401){
  const signup=await request('/auth/signup',{setup:input.setupToken,email:input.email,password:input.password,name:'Developer',workspace:'OpenCrawl development'});
  assert.equal(signup.status,303,'Could not create the development account; existing passwords are never reset');
  created=true;login=await request('/auth/login',{email:input.email,password:input.password});
}
assert.equal(login.status,303,'Generated local login failed');
const response=await request('/api/console/bootstrap');assert.equal(response.status,200);
const bootstrap=await response.json() as {workspace:{email:string;role:string};onboarding:{completed:boolean;next:string}};
assert.equal(bootstrap.workspace.email,input.email);assert.equal(bootstrap.workspace.role,'admin');
if(created){assert.equal(bootstrap.onboarding.completed,false);assert.equal(bootstrap.onboarding.next,'/onboarding');}
console.log(JSON.stringify({ok:true,accountCreated:created,onboarding:bootstrap.onboarding}));
