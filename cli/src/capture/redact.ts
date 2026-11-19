import {CliError} from '../oauth.ts';

import {SECRET_MASK, maskPatterns, literal, secretName} from '../../../src/sessions/credential-patterns.mts';
export {SECRET_MASK};
// The wire event format allows 128 levels; leave room for the batch envelope
// and decoded tool JSON without reducing the existing event-format limit.
export const MAX_REDACTION_DEPTH = 256;

export function redactText(text:string,depth=0):string {
  if(depth>MAX_REDACTION_DEPTH)throw new CliError('CAPTURE_REDACTION_TOO_DEEP','Capture content exceeds the supported masking depth; retained locally');
  // Tool arguments/results often contain serialized JSON with escaped values.
  // Decode that layer before matching; preserve the original formatting if safe.
  if(/^\s*[\[{]/.test(text)) {
    let parsed:unknown;
    try {parsed=JSON.parse(text);}catch {}
    if(parsed && typeof parsed==='object') {
      try {
        const masked=redactValue(parsed,depth+1);
        if(JSON.stringify(masked)!==JSON.stringify(parsed))return JSON.stringify(masked);
      }catch(error){
        // An encoded result can be deeper than the event envelope. Withhold
        // that value, not neighbouring events, and never fall back to raw text.
        if(error instanceof CliError && error.code==='CAPTURE_REDACTION_TOO_DEEP')return SECRET_MASK;
        throw error;
      }
    }
  }
  return maskPatterns(text);
}

export function redactValue(value:any,depth=0):any {
  if(depth>MAX_REDACTION_DEPTH)throw new CliError('CAPTURE_REDACTION_TOO_DEEP','Capture content exceeds the supported masking depth; retained locally');
  if(typeof value==='string')return redactText(value,depth);
  if(Array.isArray(value))return value.map(item=>redactValue(item,depth+1));
  if(!value || typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>[
    redactText(key,depth+1),
    typeof entry==='string' && secretName.test(key) && literal(entry) ? SECRET_MASK : redactValue(entry,depth+1),
  ]));
}

/** Scan decoded attachment bytes too. UTF-8 text is masked normally; if a binary
 * contains a recognizable ASCII credential, withhold it instead of corrupting it.
 * This does not OCR images, unpack archives, or decrypt opaque content.
 */
export function redactAttachment(bytes:Buffer):Buffer|null {
  const text=bytes.toString('utf8');
  if(!text.includes('\0') && Buffer.from(text).equals(bytes))return Buffer.from(redactText(text));
  return maskPatterns(bytes.toString('latin1'))===bytes.toString('latin1')?bytes:null;
}
