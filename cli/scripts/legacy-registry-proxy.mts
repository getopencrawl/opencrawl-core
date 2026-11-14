// Test-only HTTPS proxy: exercise an unmodified published updater against the
// candidate artifacts without changing its hard-coded registry or public tags.
import http from 'node:http';
import https from 'node:https';
import {connect} from 'node:net';
import {readFileSync,writeFileSync} from 'node:fs';
const [inventoryFile,certificate,key,receipt]=process.argv.slice(2) as [string,string,string,string];
const inventory=JSON.parse(readFileSync(inventoryFile,'utf8')) as Record<string,{metadata:Record<string,unknown>;file:string;version:string}>;
const requests:Array<{path:string;npm:boolean;event?:string}>=[];
function record(path:string,event:string){requests.push({path,npm:false,event});writeFileSync(receipt,JSON.stringify(requests));}
const registry=https.createServer({cert:readFileSync(certificate),key:readFileSync(key)},(request,response)=>{
  const path=decodeURIComponent(request.url??'');
  requests.push({path,npm:(request.headers['user-agent']??'').startsWith('npm/')});
  writeFileSync(receipt,JSON.stringify(requests));
  for(const [name,item] of Object.entries(inventory)){
    if(path===`/${name}/candidate.tgz`){response.end(request.method==='HEAD'?undefined:readFileSync(item.file));return;}
    if(path===`/${name}/${item.version}`||path===`/${name}/next`){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(item.metadata));return;}
  }
  response.writeHead(404).end();
});
await new Promise<void>(resolve=>registry.listen(0,'127.0.0.1',resolve));
const proxy=http.createServer((_request,response)=>response.writeHead(403).end());
proxy.on('connect',(request,socket,head)=>{
  record(request.url??'','connect');
  if(request.url!=='registry.npmjs.org:443'){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  // Keep HTTP CONNECT and TLS on separate sockets; the TLS server must accept
  // its own connection instead of inheriting an upgraded HTTP parser's socket.
  const upstream=connect({host:'127.0.0.1',port:(registry.address() as {port:number}).port},()=>{
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if(head.length)upstream.write(head);
    socket.pipe(upstream);upstream.pipe(socket);
  });
  socket.once('data',data=>record(String(data.length),'client-hello-bytes'));
  upstream.on('error',error=>{record((error as NodeJS.ErrnoException).code??error.message,'upstream-error');socket.destroy();});
  socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
registry.on('tlsClientError',error=>record((error as NodeJS.ErrnoException).code??error.message,'tls-error'));
registry.on('secureConnection',socket=>record(socket.getProtocol()??'unknown','tls-connected'));
proxy.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:(proxy.address() as {port:number}).port,registryPort:(registry.address() as {port:number}).port})));
process.on('SIGTERM',()=>{writeFileSync(receipt,JSON.stringify(requests));process.exit(0);});
