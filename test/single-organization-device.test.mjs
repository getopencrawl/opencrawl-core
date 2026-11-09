import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {singleOrganizationDevice} from '../dist/src/identity/single-organization-device.mjs';
const settings={url:'https://self.example',clientId:'client_owned',organizationId:'org_owned'};
const user={id:'user_one',email:'one@example.test',emailVerified:true};
function fixture(){
 const calls=[], state={organizationId:'org_owned',members:[{userId:user.id,organizationId:'org_owned',status:'active'}],deviceStatus:200,deviceBody:{refresh_token:'device-refresh'}};
 const workos={userManagement:{getUser:async()=>user,listOrganizationMemberships:async input=>{calls.push(['membership',input]);return {data:state.members};},authenticateWithRefreshToken:async input=>{calls.push(['refresh',input]);return {organizationId:state.organizationId,user,accessToken:'scoped-access',refreshToken:'scoped-refresh'};}}};
 const handler=singleOrganizationDevice(settings,workos,async(url,init)=>{calls.push(['device',url,new URLSearchParams(init.body).get('client_id')]);return Response.json(state.deviceBody,{status:state.deviceStatus});});
 const request=async(input={client_id:'client_owned',grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:'device'},headers={})=>{
  let status,body;const received={};const req=Object.assign(Readable.from([new URLSearchParams(input).toString()]),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...headers}});
  await handler(req,{setHeader:(key,value)=>received[key]=value,writeHead:code=>status=code,end:value=>body=JSON.parse(value)});return {status,body,headers:received};
 };return {request,state,calls};
}
test('device and refresh grants request only the configured organization before returning credentials',async()=>{
 const f=fixture();const response=await f.request();assert.equal(response.status,200);assert.equal(response.headers['Cache-Control'],'no-store');
 assert.deepEqual(response.body,{access_token:'scoped-access',refresh_token:'scoped-refresh',token_type:'Bearer'});
 assert.deepEqual(f.calls.find(([name])=>name==='refresh')[1],{clientId:'client_owned',refreshToken:'device-refresh',organizationId:'org_owned'});
 f.calls.length=0;assert.equal((await f.request({client_id:'client_owned',grant_type:'refresh_token',refresh_token:'saved-refresh'})).status,200);
 assert.equal(f.calls.some(([name])=>name==='device'),false);assert.equal(f.calls[0][1].organizationId,'org_owned');
});
test('device exchange refuses caller-selected scopes, wrong clients, browser requests and revoked membership',async()=>{
 const f=fixture();for(const input of [{client_id:'client_other',grant_type:'refresh_token',refresh_token:'secret'},
  {client_id:'client_owned',grant_type:'refresh_token',refresh_token:'secret',organization_id:'org_foreign'},
  [['client_id','client_owned'],['grant_type','refresh_token'],['refresh_token','one'],['refresh_token','two']]])assert.equal((await f.request(input)).status,400);
 assert.equal((await f.request(undefined,{origin:'https://self.example'})).status,403);assert.equal(f.calls.length,0);
 f.state.organizationId='org_foreign';assert.equal((await f.request()).status,403);
 f.state.organizationId='org_owned';f.state.members=[];assert.equal((await f.request()).status,403);
});
test('device polling preserves pending and slowdown signals without exposing provider payloads',async()=>{
 const f=fixture();f.state.deviceStatus=400;f.state.deviceBody={error:'authorization_pending',secret:'never-return'};
 assert.deepEqual((await f.request()).body,{error:'authorization_pending'});assert.equal(f.calls.some(([name])=>name==='refresh'),false);
 f.state.deviceStatus=429;assert.deepEqual((await f.request()).body,{error:'slow_down'});
 f.state.deviceStatus=503;f.state.deviceBody={error:'upstream detail with secrets'};assert.deepEqual((await f.request()).body,{error:'temporarily_unavailable'});
});
