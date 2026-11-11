export const PASSAGE_VERSION=2;
export interface TextPassage {text:string; start:number; end:number}
/** Exact partition, with no overlap or lost whitespace. Prefer paragraph and
 * line boundaries; keep short fenced code blocks intact. Very long blocks
 * split at lines, then words, with a surrogate-safe hard bound. */
export function passages(text:string,target=3000,maximum=6000):TextPassage[] {
  if(!Number.isInteger(target)||!Number.isInteger(maximum)||target<100||maximum<target)throw new Error('Invalid passage bounds');
  if(!text)return [{text:'',start:0,end:0}];
  const boundaries:Array<{end:number;paragraph:boolean;inFence:boolean}>=[];
  let fence:string|null=null;
  for(const m of text.matchAll(/.*(?:\n|$)/g)) {
    if(!m[0])continue;
    const marker=/^\s{0,3}(`{3,}|~{3,})/.exec(m[0]);
    if(marker){if(!fence)fence=marker[1]![0]!;else if(marker[1]![0]===fence)fence=null;}
    boundaries.push({end:m.index+m[0].length,paragraph:/^\s*$/.test(m[0]),inFence:!!fence});
  }
  const result:TextPassage[]=[];let start=0,cursor=0;
  while(start<text.length) {
    if(text.length-start<=target){result.push({text:text.slice(start),start,end:text.length});break;}
    const hard=Math.min(text.length,start+maximum),ideal=start+target,minimum=start+Math.floor(target/3);
    while(cursor<boundaries.length&&boundaries[cursor]!.end<=start)cursor++;
    let end=0,best=Infinity;
    for(let i=cursor;i<boundaries.length&&boundaries[i]!.end<=hard;i++) {
      const b=boundaries[i]!;if(b.end<minimum||b.inFence)continue;
      const cost=Math.abs(b.end-ideal)+(b.paragraph?0:target/3);
      if(cost<best){end=b.end;best=cost;}
    }
    if(!end){
      // Oversized code/log lines must still fit; do not scan the whole tail.
      const window=text.slice(start,hard),line=window.lastIndexOf('\n',target),word=window.lastIndexOf(' ',target);
      end=start+(line>=target/3?line+1:word>=target/3?word+1:Math.min(target,window.length));
    }
    if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;
    result.push({text:text.slice(start,end),start,end});start=end;
  }
  return result;
}
