import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractDocumentText} from '../src/connectors/document-text.mjs';

function pdf(pages) {
 const objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(' ')}] >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 for(const [i,text] of pages.entries()){
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
  const content=`BT /F1 12 Tf 40 740 Td (${text.replace(/[\\()]/g,'\\$&')}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
 }
 let source='%PDF-1.7\n';const offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const start=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 return Buffer.from(source);
}
test('text files retain complete Unicode content far beyond a preview',async()=>{
 const text='# Full document\n'+'Repeated content 🌍\n'.repeat(1000)+'End-of-file searchable marker';
 const result=await extractDocumentText(Buffer.from(text),{mediaType:'text/markdown'});
 assert.equal(result.status,'extracted');assert.equal(result.parts[0].text,text);assert.equal(result.sourceBytes,Buffer.byteLength(text));assert.match(result.sourceSha256,/^[a-f0-9]{64}$/);
});
test('HTML preserves inline text, table cells, entities and image alternative text without executing scripts',async()=>{
 const html='<html><body><h1>Canvas title</h1><p>do <b>not</b> lose words &amp; entities</p><table><tr><td>First cell</td><td>Last cell</td></tr></table><img alt="Architecture diagram"><script>HIDDEN_EXECUTABLE</script></body></html>';
 const result=await extractDocumentText(Buffer.from(html),{mediaType:'text/html; charset=utf-8'});const text=result.parts.map(p=>p.text).join('\n');
 for(const fragment of ['Canvas title','do not lose words & entities','First cell','Last cell','Architecture diagram'])assert.ok(text.includes(fragment),fragment);
 assert.ok(!text.includes('HIDDEN_EXECUTABLE'));
 assert.match(text,/First cell\s+Last cell/);
});
test('every PDF page text layer is extracted, including the final page',async()=>{
 const result=await extractDocumentText(pdf(['First page searchable text','Final page completion marker']),{mediaType:'application/pdf'});
 assert.equal(result.pages,2);assert.equal(result.pagesWithText,2);assert.equal(result.status,'extracted');
 assert.ok(result.parts.find(p=>p.path==='pages.1.text').text.includes('First page searchable text'));
 assert.ok(result.parts.find(p=>p.path==='pages.2.text').text.includes('Final page completion marker'));
});
test('empty PDF text layers are explicit and unsupported/corrupt inputs never report success',async()=>{
 const result=await extractDocumentText(pdf(['']),{mediaType:'application/pdf'});assert.equal(result.status,'no-text-layer');assert.equal(result.pages,1);
 await assert.rejects(extractDocumentText(Buffer.from('not a PDF'),{mediaType:'application/pdf'}),/extraction failed/);
 await assert.rejects(extractDocumentText(Buffer.from('binary'),{mediaType:'application/octet-stream'}),/extraction failed/);
 const controller=new AbortController();controller.abort();await assert.rejects(extractDocumentText(Buffer.from('text'),{mediaType:'text/plain',signal:controller.signal}));
});

test('PDF font fragments join inside words while separate positioned labels retain spaces',async()=>{
 const {pdfText}=await import('../src/connectors/document-text-layout.mjs');
 const item=(str,x,width)=>({str,width,height:12,transform:[12,0,0,12,x,100]});
 assert.equal(pdfText([item('work',0,24),item('flow',24,20)]),'workflow');
 assert.equal(pdfText([item('15m',0,18),item('1h',24,12),item('6h',42,12)]),'15m 1h 6h');
 assert.equal(pdfText([item('15m',80,18),item('1h',50,12),item('6h',10,12)]),'15m 1h 6h');
 assert.equal(pdfText([{...item('first line',0,40),hasEOL:true},item('second line',0,45)]),'first line\nsecond line');
});
