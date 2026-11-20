import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {writers,fixtureToken} from '../../../test/fixtures/shared-files-http.mjs';
import {createSharedFilesHandler,sharedFilesAuthorization} from '../../../dist/src/files/git-http.mjs';
import {fileRepositories} from '../../../dist/src/files/store.mjs';
const store = fileRepositories(process.argv[2], 'files-test');
const original = store.open;
store.open = async tenant => {
  try { return await original(tenant); }
  catch (error) { console.error('Could not open the fixture repository:', error); throw error; }
};
await store.ready();
const git=createSharedFilesHandler({store});
const enabled=join(process.argv[2],'enabled');
const server=createServer(async(req,res)=>{
  const auth=sharedFilesAuthorization(req.headers.authorization);
  const who=Object.keys(writers).find(name=>auth==='Bearer '+fixtureToken(name));
  if(!who)return res.writeHead(401,{'WWW-Authenticate':'Basic realm="OpenCrawl shared files"'}).end();
  const principal=writers[who];
  if(req.url==='/api/setup' && req.method==='GET')return res.writeHead(200,{'Content-Type':'application/json'}).end(
    JSON.stringify({schemaVersion:1,data:{scope:principal,installations:[],firstWin:null}}));
  if(!existsSync(enabled))return res.writeHead(404).end();
  await git(req,res,principal,async()=>{});
});
server.listen(0,'127.0.0.1',()=>process.stdout.write('http://127.0.0.1:'+server.address().port+'\n'));
process.once('SIGTERM',()=>{server.closeAllConnections();server.close();});
