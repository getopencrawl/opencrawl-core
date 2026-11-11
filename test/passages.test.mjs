import {test} from 'node:test';
import assert from 'node:assert/strict';
import {passages} from '../dist/src/search/passages.mjs';
test('passages reconstruct exact source across paragraph, log, Unicode and oversized-line boundaries',()=>{
  for(const text of ['', 'short', ('First paragraph.\n\nSecond paragraph with detail.\n').repeat(500),'😀'.repeat(10000),'x'.repeat(18000),('row\tvalue\n').repeat(3000)]){
    const chunks=passages(text);assert.equal(chunks.map(p=>p.text).join(''),text);
    let at=0;for(const c of chunks){assert.equal(c.start,at);assert.equal(c.text,text.slice(c.start,c.end));assert.ok(c.text.length<=6000);assert.ok(!/[\uD800-\uDBFF]$/.test(c.text));at=c.end;}
    assert.equal(at,text.length);
  }
});
test('short fenced blocks remain intact and splitting is deterministic',()=>{
  const code='```ts\n'+('const x = 1;\n').repeat(180)+'```\n';
  const text='Introduction.\n\n'.repeat(60)+code+'\nClosing paragraphs.\n'.repeat(300);
  const chunks=passages(text);assert.ok(chunks.some(c=>c.text.includes(code)));assert.deepEqual(chunks,passages(text));
});
test('embedded shorter fences and apparent closers with trailing text stay inside the code block',()=>{
  for(const marker of ['````','~~~~'])for(const apparentCloser of [marker.slice(0,3),marker+' not a closing fence']){
    const code=marker+'markdown\n'+('before\n').repeat(180)+apparentCloser+'\n\n'+('after\n').repeat(220)+marker+'\n';
    const text='Introduction.\n\n'.repeat(60)+code+'\nClosing paragraphs.\n'.repeat(300);
    const chunks=passages(text);
    assert.equal(chunks.map(c=>c.text).join(''),text);
    assert.ok(chunks.some(c=>c.text.includes(code)));
  }
});
