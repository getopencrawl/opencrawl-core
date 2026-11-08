import {createServer} from 'node:http';
import {createBoard} from '../../../dist/src/board/board.mjs';
import {createBoardHandler} from '../../../dist/src/board/http.mjs';
import {createLocalBoardStore} from '../../../dist/src/board/local-store.mjs';

const store=createLocalBoardStore(process.argv[2]);
const board=createBoard({store,prefix:'fixture'});
const handler=createBoardHandler({board,authenticate:async req=>req.headers.authorization==='Bearer disposable-board-test-token' ? {tenantId:'fixture',userId:'tester'} : null});
const server=createServer(handler);
server.listen(Number(process.argv[3] || 0),'127.0.0.1',()=>process.stdout.write(JSON.stringify({api:`http://127.0.0.1:${server.address().port}`,pid:process.pid})+'\n'));
process.on('SIGTERM',()=>server.close(()=>{store.close();process.exit(0);}));
