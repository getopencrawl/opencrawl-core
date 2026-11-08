import type {DefaultTreeAdapterTypes} from 'parse5';
import type {TextPart} from './types.mjs';
interface StructureNode {type?: string; role?: string; id?: string; alt?: unknown; actualText?: unknown; children?: StructureNode[]}
import {parentPort, workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {pdfText} from './document-text-layout.mjs';

const parts: (TextPart & {sha256: string})[] = []; let textBytes = 0;
function add(path: string, text: unknown) {
  if (text === undefined || text === null || text === '') return;
  if (typeof text !== 'string') throw new Error('Invalid extracted text');
  textBytes += Buffer.byteLength(text);
  if (textBytes > 16 * 1024 * 1024 || parts.length >= 20000) throw new Error('Extracted document exceeds supported size');
  parts.push({path, text, sha256: createHash('sha256').update(text).digest('hex')});
}
async function extract() {
  const {bytes, mediaType} = workerData as {bytes: Uint8Array; mediaType: string};
  const pdf = Buffer.from(bytes.subarray(0,5)).toString() === '%PDF-';
  if (pdf || mediaType === 'application/pdf') {
    if (!pdf) throw new Error('PDF media type does not match content');
    const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const options = {data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, enableXfa: false, verbosity: 0};
    const task = getDocument(options);
    try {
      const document = await task.promise;
      if (document.numPages > 1000) throw new Error('PDF exceeds supported page count');
      const metadata = await document.getMetadata();
      for (const name of ['Title','Author','Subject','Keywords']) add('metadata.' + name, (metadata.info as Record<string, unknown> | undefined)?.[name]);
      let pagesWithText = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent({disableNormalization: false});
        const text = pdfText(content.items);
        if (text.trim()) {
          add('pages.' + pageNumber + '.text', text); pagesWithText++;
          const joined=text.replace(/([\p{L}\p{N}])-\s*\n\s*(?=[\p{L}\p{N}])/gu,'$1');
          if(joined!==text)add('pages.' + pageNumber + '.dehyphenated',joined);
        }
        const annotations = await page.getAnnotations({intent:'display'});
        for (const [i, annotation] of annotations.entries()) {
          for (const [name, value] of Object.entries({contents:annotation.contentsObj?.str,title:annotation.titleObj?.str,fieldValue:annotation.fieldValue})) {
            if (typeof value === 'string') add(`pages.${pageNumber}.annotations.${i}.${name}`, value);
            else if (Array.isArray(value)) for (const [j, entry] of value.entries()) if (typeof entry === 'string') add(`pages.${pageNumber}.annotations.${i}.${name}.${j}`, entry);
          }
        }
        const tree = await page.getStructTree();
        function structure(node: StructureNode | null,path: string,depth=0) {
          if (!node) return;
          if (depth>64) throw new Error('PDF structure exceeds supported depth');
          add(path+'.alt',node.alt);add(path+'.actualText',node.actualText);
          for (const [i,child] of (node.children||[]).entries()) structure(child,path+'.'+i,depth+1);
        }
        structure(tree,`pages.${pageNumber}.structure`);
        page.cleanup();
      }
      return {format:'pdf',pages:document.numPages,pagesWithText,parts,status:parts.length?'extracted':'no-text-layer'};
    } finally {await task.destroy();}
  }
  const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    const {parse} = await import('parse5');
    const document = parse(text,{scriptingEnabled:false});let nodes=0;
    const fragments: string[]=[];
    function walk(node: DefaultTreeAdapterTypes.Node,depth=0) {
      if(++nodes>200000||depth>128)throw new Error('HTML exceeds supported complexity');
      const tagName = 'tagName' in node ? node.tagName : '';
      if(['script','style','template'].includes(tagName))return;
      if(node.nodeName==='#text' && 'value' in node)fragments.push(node.value);
      if('tagName' in node && node.tagName==='img'){const alt=node.attrs?.find(a=>a.name==='alt')?.value;if(alt)fragments.push(alt);}
      const block=['p','div','h1','h2','h3','h4','h5','h6','li','tr','td','th','br','section','article','pre'].includes(tagName);
      if(block)fragments.push('\n');
      for(const child of 'childNodes' in node ? node.childNodes : [])walk(child,depth+1);
      if(block)fragments.push('\n');
    }
    walk(document);add('html.text',fragments.join(''));
    return {format:'html',parts,status:parts.some(p=>p.text.trim())?'extracted':'no-text-layer'};
  }
  const unlabeledText=mediaType==='application/octet-stream'&&!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text);
  if(unlabeledText||mediaType.startsWith('text/')||['application/json','application/xml','application/yaml'].includes(mediaType)) {
    add('text',text);return {format:'text',parts,status:text.trim()?'extracted':'no-text-layer'};
  }
  throw new Error('Unsupported document media type');
}
try {parentPort!.postMessage(await extract());}
catch {parentPort!.postMessage({error:'Document text extraction failed; source retained for inspection'});}
