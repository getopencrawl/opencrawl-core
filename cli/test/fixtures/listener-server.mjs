import {join} from 'node:path';
import {standaloneMcp} from '../../../dist/src/mcp/standalone.mjs';

// Self-hosted MCP + board server: the MCP bearer stands in for an agent's MCP sign-in.
const port=Number(process.argv[3]),origin=`http://127.0.0.1:${port}`;
const server=standaloneMcp({token:'disposable-mcp-sign-in-token-0000',origin,boardPath:join(process.argv[2],'board.sqlite'),principal:{tenantId:'fixture',userId:'tester'}});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({api:origin,pid:process.pid})+'\n'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
