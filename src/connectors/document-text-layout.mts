/** PDF text items can split one word across fonts/ligatures, or place separate
 * labels without literal whitespace. Preserve item text and use geometry only
 * to add the visible separation between adjacent items. */
interface PdfTextItem {type?: string; str?: string; transform?: number[]; height?: number; width?: number; hasEOL?: boolean}
export function pdfText(items: PdfTextItem[]) {
  let text='', previous;
  for(const item of items) {
    if(typeof item.str!=='string')continue;
    if(previous&&!/\s$/.test(text)&&!/^\s/.test(item.str)&&item.str) {
      const a=previous.transform,b=item.transform;
      if(Array.isArray(a)&&Array.isArray(b)&&a.length===6&&b.length===6) {
        const scale=Math.hypot(a[0],a[1])||1,ux=a[0]/scale,uy=a[1]/scale;
        const dx=b[4]-a[4],dy=b[5]-a[5],baseline=Math.abs(dx*uy-dy*ux);
        const height=Math.max(previous.height||0,item.height||0,Math.hypot(a[2],a[3]));
        const gap=dx*ux+dy*uy-(previous.width||0);
        if(baseline>height*0.5)text+='\n';
        else if(gap>Math.max(0.1,height*0.08)||dx*ux+dy*uy < -(item.width||0)-Math.max(0.1,height*0.08))text+=' ';
      }
    }
    text+=item.str;
    if(item.hasEOL)text+='\n';
    previous=item;
  }
  return text;
}
