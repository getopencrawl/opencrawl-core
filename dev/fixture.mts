import {createServer} from 'node:http';
// Deliberately synthetic, public demo records. Only the private dev network sees
// this source; Airbyte, its real S3 destination and the normal indexer do the work.
export const notes = [
  {id:'opencrawl-dev-welcome',title:'Welcome to the OpenCrawl development workspace',
    summary_markdown:'The lunar otter checks the ingestion pipeline. This sample meeting was read from a local fixture by Airbyte, written to S3, and indexed by the normal OpenCrawl Temporal worker. Replace this sample with your own connected data when ready.',
    created_at:'2026-01-01T12:00:00Z',updated_at:'2026-01-01T12:00:00Z',url:'https://example.com/opencrawl-development-sample'},
  {id:'opencrawl-dev-boundary',title:'Development setup and production boundaries',
    summary_markdown:'The development installer generates local credentials and owns a private Airbyte cluster. Production deployments continue to supply their own infrastructure through the same existing interfaces. This is synthetic sample data, not a real Granola account.',
    created_at:'2026-01-01T12:01:00Z',updated_at:'2026-01-01T12:01:00Z',url:'https://example.com/opencrawl-development-boundary'},
];
createServer((req,res)=>{
  if(req.method!=='GET'||!['/notes','/health'].includes(req.url||'')){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify(req.url==='/health'?{ok:true}:{notes}));
}).listen(8080,'0.0.0.0');
