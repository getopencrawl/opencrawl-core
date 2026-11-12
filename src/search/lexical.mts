/** Every corpus shares the same realm and scoring fields. No stemming, query
 * expansion, semantic model or per-source score normalization is involved. */
export function lexicalQuery(query: string, match: string) {
  if(!query.trim())return {match_all:{}};
  const required={multi_match:{query,fields:['title^2','text'],...(match==='phrase'?{type:'phrase'}:{type:'cross_fields',operator:match==='all'?'and':'or'})}};
  if(match==='phrase'||!/\S+\s+\S/u.test(query))return required;
  // Keep the literal matching set. Adjacent words provide an additional signal
  // for multi-word queries without requiring a phrase or expanding the terms.
  return {bool:{must:[required],should:[{multi_match:{query,fields:['title^2','text'],type:'phrase',boost:2}}]}};
}
