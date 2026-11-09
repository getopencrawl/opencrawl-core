// Enables optional semantic retrieval on the bundled OpenSearch: registers and deploys OpenSearch's
// pretrained learned-sparse document encoder inside the cluster (no external API or key), then prints
// the model ID for OPENCRAWL_SEMANTIC_MODEL. Idempotent. Run from the deploy directory:
//   docker compose exec -T worker node deploy/semantic.mjs
// The model is downloaded once from artifacts.opensearch.org. Encoding runs on the OpenSearch node's
// CPU in the background; lexical search keeps serving while passages are encoded.
const endpoint = (process.env.OPENCRAWL_OPENSEARCH_URL || 'http://opensearch:9200').replace(/\/$/, '');
const MODEL = {name: 'amazon/neural-sparse/opensearch-neural-sparse-encoding-doc-v3-distill', version: '1.0.0', model_format: 'TORCH_SCRIPT'};
async function call(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(endpoint + path, {method, headers: {'content-type': 'application/json'}, body: body && JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  return data;
}
// Single-node self-host: allow ML inference on the data node within its memory limits.
await call('/_cluster/settings', {persistent: {'plugins.ml_commons.only_run_on_ml_node': false, 'plugins.ml_commons.native_memory_threshold': 95}}, 'PUT');
const existing = await call('/_plugins/_ml/models/_search', {size: 10, query: {bool: {filter: [{term: {'name.keyword': MODEL.name}}, {term: {model_state: 'DEPLOYED'}}]}}});
let modelId = existing.hits?.hits?.find(h => !h._source.chunk_number && h._source.model_state === 'DEPLOYED')?._id;
if (!modelId) {
  const {task_id: task} = await call('/_plugins/_ml/models/_register?deploy=true', MODEL);
  for (let i = 0; i < 120 && !modelId; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await call(`/_plugins/_ml/tasks/${task}`);
    if (status.state === 'FAILED') throw new Error('Model registration failed: ' + status.error);
    if (status.state === 'COMPLETED') modelId = status.model_id;
  }
  if (!modelId) throw new Error('Model registration did not finish within 10 minutes');
  await call(`/_plugins/_ml/models/${modelId}/_deploy`, {});
}
console.log(`Semantic model deployed: ${modelId}
Add to deploy/.env:  OPENCRAWL_SEMANTIC_MODEL=${modelId}
Then: docker compose up -d   (existing passages are encoded in the background)`);
