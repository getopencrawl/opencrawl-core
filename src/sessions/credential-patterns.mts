export const SECRET_MASK = '[REDACTED]';
// Credential-shaped rules adapted from Gitleaks v8.30.0 (MIT):
// https://github.com/gitleaks/gitleaks/blob/v8.30.0/config/gitleaks.toml
// See THIRD_PARTY_NOTICES.txt. Deliberately omit entropy/length-only rules,
// public client IDs and generic hexadecimal strings: UUIDs and hashes are useful.
// No network verification, model, environment lookup or runtime rule download.
const credentials:RegExp[] = [
  /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----|$)/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82})\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,255}/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{20,}/g,
  // Cursor worker credentials can appear as bare command-line arguments.
  /\bctxt(?:\\*_)+secret(?:\\*_)+[A-Za-z0-9_\\-]+/gi,
  /\bcrsr_[a-f0-9]{64}\b/g,
  /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
  /\b(?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,}/g,
  /\bxox[baprse]-[A-Za-z0-9-]{20,}/g,
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g,
  /(?:https?:\/\/)?hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/+_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/g,
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /\bkey-[a-f0-9]{32}\b/g,
  /\b(?:hvs|hvb)\.[A-Za-z0-9_-]{20,}/g,
  /\b(?:dop_v1_|doo_v1_|dor_v1_)[a-f0-9]{64}\b/g,
  /\b(?:hf_[A-Za-z0-9]{34}|AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}={0,2}/g,
  // OpenCrawl's own capture credentials and agent access tokens.
  /\boc[ac]1_[a-f0-9]{64}\b/g,
];

// Context permits otherwise opaque credentials, including a UUID deliberately
// used as a password. A bare UUID, trace ID, commit hash or ordinary token count
// never matches. Preserve shell/template references and existing mask markers.
export const secretName = /^(?:(?:[a-z][a-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret(?:[_-]?(?:key|access[_-]?key))?|client[_-]?secret|password|passwd|token)|authorization|x-api-key|x-amz-(?:signature|security-token))$/i;
export function literal(value:string) {
  return value.length>=4 && value!==SECRET_MASK && !/^(?:\$|%[A-Z_]+%|\{\{|<|process\.env\.|(?:os\.)?environ\b|import\.meta\.env\.)/.test(value) && !/^(?:true|false|null|undefined)$/i.test(value);
}

export function maskPatterns(text:string):string {
  for(const pattern of credentials)text=text.replace(pattern,SECRET_MASK);
  text=text.replace(/(\b(?:Bearer|Basic)[ \t]+)([A-Za-z0-9._~+\/-]{8,}=*)/gi,(_all,prefix,value)=>prefix+(literal(value)?SECRET_MASK:value));
  text=text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi,(_all,prefix,_password,end)=>prefix+SECRET_MASK+end);
  // Quoted JSON/env/shell assignments and URL query parameters. No generic
  // "long random string" fallback. Values stop at delimiters, not the next line.
  return text.replace(/(\b([A-Za-z][A-Za-z0-9_-]*)["']?[ \t]*(?:=|:)[ \t]*)(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^\s"'`,;&<>\[\]{}]+))/g,
    (all,prefix,name,double,single,bare)=>{
      const value=double??single??bare;
      if(!secretName.test(name)||!literal(value)||/^(?:Bearer|Basic)$/i.test(value))return all;
      const quote=double!==undefined?'"':single!==undefined?"'":'';
      return prefix+quote+SECRET_MASK+quote;
    });
}

