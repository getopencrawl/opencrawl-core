import {parseArgs} from 'node:util';
import {apiOrigin,CliError,DEFAULT_API_ORIGIN} from './oauth.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {configuredToken,workspaceIdentityEnabled} from './workspace-identity.ts';
import {readCaptureConfig} from './capture/runtime.ts';
import {accessToken} from './session.ts';
import {memoryReader} from './search.ts';
import {importMemories} from './import-memories.ts';
import type {identity} from './cli.ts';

const help='opencrawl memories scan|verify|import [--host HOST] [--harness CLIENT] [--installation ID] [--path EXACT_PATH ...] [--list] [--store ABSOLUTE_DIR] [--api ORIGIN] [--json]';
export async function personalMemoryCommand(argv:string[],identify:typeof identity) {
  const parsed=()=>parseArgs({args:argv,allowPositionals:true,options:{
    host:{type:'string'},harness:{type:'string'},installation:{type:'string'},path:{type:'string',multiple:true},
    store:{type:'string'},list:{type:'boolean'},api:{type:'string'},help:{type:'boolean'},json:{type:'boolean'},
  }});
  let args:ReturnType<typeof parsed>;
  try {args=parsed();} catch{throw new CliError('INVALID_USAGE',help,64);}
  if(args.values.help||!args.positionals.length)return {data:{help},human:help,exit:0};
  if(args.positionals.length!==1||!['scan','verify','import'].includes(args.positionals[0]!))throw new CliError('INVALID_USAGE',help,64);
  if(workspaceIdentityEnabled())throw new CliError('AUTH_REQUIRED','Memory import needs a personal OpenCrawl identity.',2);
  const explicit=args.values.api??process.env.OPENCRAWL_API_URL;
  const api=apiOrigin(explicit??readCaptureConfig()?.api??DEFAULT_API_ORIGIN);
  return withEnvironmentTokenOrigin(explicit,async()=>{
    const token=await configuredToken('OPENCRAWL_TOKEN',api) || await accessToken(api);
    const who=await identify(api,fetch,token);
    if(who.credential==='workspace-identity'||!who.workspace?.id||!who.user.id)throw new CliError('AUTH_REQUIRED','Select a personal OpenCrawl sign-in and workspace.',2);
    const data=await importMemories(args.positionals[0]!,{api,workspace:who.workspace.id,user:who.user.id},args.values,memoryReader(api,token));
    return {data,human:JSON.stringify(data,null,2),exit:data.complete?0:1};
  });
}
