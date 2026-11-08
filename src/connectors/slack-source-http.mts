import type {SlackFile, SlackApiData, SlackQuery} from './types.mjs';
const MAX=20*1024*1024;
export async function boundedResponseBytes(response: Response,maxBytes=MAX) {
 const declared=Number(response.headers.get('content-length'));
 if(declared>maxBytes)throw new Error('Slack response exceeds byte limit');
 const chunks: Uint8Array[]=[];let length=0;
 for await(const chunk of response.body!){length+=chunk.length;if(length>maxBytes){throw new Error('Slack response exceeds byte limit');}chunks.push(chunk);}
 return Buffer.concat(chunks);
}
export function slackDownloadUrl(file: SlackFile) {
 if(file.is_external||(file.size ?? 0)>MAX)throw Object.assign(new Error('Unsupported Slack file download'),{permanent:true});
 let url;try{url=new URL((file.url_private_download||file.url_private)!);}catch{throw new Error('Missing Slack file download');}
 if(url.protocol!=='https:'||url.hostname!=='files.slack.com'||url.port||url.username||url.password)throw Object.assign(new Error('Invalid Slack file host'),{permanent:true});
 return url;
}
export function documentMediaType(file: SlackFile,bytes: Buffer,contentType: string | null) {
 if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
 const type=(contentType||'').split(';')[0].trim().toLowerCase();
 if(file.filetype==='quip') {
  if(type!=='text/html')throw new Error('Canvas download did not return HTML');
  return 'text/html';
 }
 return file.mimetype==='application/octet-stream'&&type&&type!=='application/octet-stream'?type:(file.mimetype||type||'application/octet-stream');
}
/** Customer-operated reference adapter. The caller supplies its own Slack token;
 * core never requires a managed account, proxy, or hosted credential service. */
export function createSlackHttpSource({token,workspaceId,fetch:send=globalThis.fetch}: {token?: string; workspaceId: string; fetch?: typeof globalThis.fetch}) {
 if(typeof token!=='string'||!token||!/^T[A-Z0-9]{1,100}$/.test(workspaceId||''))throw new Error('Slack token and explicit workspace required');
 let verifiedUntil=0;
 async function verifyWorkspace(){
  if(verifiedUntil>Date.now())return;
  const response=await send('https://slack.com/api/auth.test',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});
  const bytes=await boundedResponseBytes(response,1024*1024);let data: SlackApiData;try{data=JSON.parse(bytes.toString()) as SlackApiData;}catch{throw new Error('Invalid Slack identity response');}
  if(!response.ok||data?.ok!==true||data.team_id!==workspaceId)throw Object.assign(new Error('Slack token workspace mismatch'),{permanent:true});
  verifiedUntil=Date.now()+60000;
 }
 return {
  async request(method: string,query: SlackQuery) {
   if(!['conversations.list','conversations.info','conversations.history','conversations.replies','files.list','files.info'].includes(method))throw new Error('Unsupported source method');
   await verifyWorkspace();
   const url=new URL('https://slack.com/api/'+method);for(const[k,v]of Object.entries(query))if(v!==undefined)url.searchParams.set(k,String(v));
   const response=await send(url,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});
   const bytes=await boundedResponseBytes(response,5*1024*1024);let data: SlackApiData;try{data=JSON.parse(bytes.toString()) as SlackApiData;}catch{throw new Error('Invalid Slack API response');}
   return {status:response.status,headers:Object.fromEntries(response.headers),data};
  },
  async download(file: SlackFile) {
   const url=slackDownloadUrl(file);await verifyWorkspace();
   const response=await send(url,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw new Error('Slack download failed ('+response.status+')');
   const bytes=await boundedResponseBytes(response);
   if(file.filetype!=='quip'&&Number.isSafeInteger(file.size)&&bytes.length!==file.size)throw new Error('Slack download size mismatch');
   return {bytes,mediaType:documentMediaType(file,bytes,response.headers.get('content-type'))};
  },
 };
}
