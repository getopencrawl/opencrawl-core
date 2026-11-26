export interface FileLink {workspace: string; revision: string; path?: string}
export type FileView = {workspace:string; commit: string; parents: string[]; title: string; author: string; time: string} & (
  {kind:'commit'; files:string[]; truncated:boolean}
  | {kind:'file'; path:string; bytes:number; text:string|null; large:boolean});

export function filePath({workspace,revision,path}:FileLink) {
  return path===undefined ? '/commits/'+workspace+'/'+revision : '/files/'+workspace+'/'+revision+'/'+path.split('/').map(encodeURIComponent).join('/');
}
export function filePage(pathname:string):FileLink|null {
  const [,kind,workspace,revision,...encoded]=pathname.split('/');
  if(!pathname.startsWith('/') || (kind!=='commits' && kind!=='files') || !workspace || !/^[\w-]{12}$/.test(workspace)
    || !revision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return null;
  if(kind==='commits') return encoded.length?null:{workspace,revision};
  if(!encoded.length || pathname.length>8192) return null;
  try {
    const segments=encoded.map(decodeURIComponent);
    if(segments.some(segment=>!segment||segment==='.'||segment==='..'||segment.includes('/')||segment.includes('\0')))return null;
    return {workspace,revision,path:segments.join('/')};
  } catch {return null;}
}
