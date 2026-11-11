import type {WorkspaceHit} from './presentation.mjs';
export const facetNames=['source','kind','author','harness','provider','repository','project','path','role','sessionId'] as const;
export type FacetName=typeof facetNames[number];
export function facetValue(hit: WorkspaceHit, name: FacetName): string | undefined {
  const p=hit.provenance;
  const value=name==='source'?hit.source:name==='author'?p.userId||p.authorId:p[name];
  return typeof value==='string'&&value?value:undefined;
}
/** Only authorized hits reach here. Counts describe the bounded candidate window,
 * not the corpus, and never include hidden connector parents/channels. */
export function candidateFacets(hits: WorkspaceHit[], names: FacetName[]) {
  return Object.fromEntries(names.map(name=>{
    const counts=new Map<string,number>();
    for(const hit of hits){const value=facetValue(hit,name);if(value)counts.set(value,(counts.get(value)||0)+1);}
    const sorted=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    return [name,{values:sorted.slice(0,20).map(([value,count])=>({value,count})),other:sorted.slice(20).reduce((n,v)=>n+v[1],0)}];
  }));
}
