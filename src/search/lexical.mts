/** Every corpus shares the same realm and scoring fields. No stemming, query
 * expansion, semantic model or per-source score normalization is involved. */
export function lexicalQuery(query: string, match: string) {
  if(!query.trim())return {match_all:{}};
  return {multi_match:{query,fields:['title^2','text'],...(match==='phrase'?{type:'phrase'}:{type:'cross_fields',operator:match==='all'?'and':'or'})}};
}
