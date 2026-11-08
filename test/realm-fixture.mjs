import {realmDocument} from '../dist/src/search/realm.mjs';
/** Fake engine responses in the persisted envelope, with complete engine metadata. */
export function realmResponse(corpus,body) {
  const hit=h=>h.found===false?{...h,_id:corpus+':'+h._id}:{...h,_id:corpus+':'+h._id,_source:realmDocument(corpus,h._id,h._source)};
  const result={...body};
  if(body.hits)Object.assign(result,{timed_out:body.timed_out??false,_shards:body._shards||{failed:0},hits:{...body.hits,hits:(body.hits.hits||[]).map(hit)}});
  if(body.docs)result.docs=body.docs.map(hit);
  return Response.json(result);
}
