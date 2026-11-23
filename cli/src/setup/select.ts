import type {RecordingInstallState} from './plugins.ts';
export type SelectionItem={id:string;label:string;selected:boolean;detail?:string;installState?:RecordingInstallState;disabled?:boolean};
export type SelectionScreen={title:string;description:string;items:SelectionItem[];noneLabel:string;phase:1|2|3|4;emptyMessage?:string};

export function participationNotice(clients:readonly string[]):string|undefined{
 const claude=clients.includes('claude-code'),codex=clients.includes('codex');
 if(!claude&&!codex)return;
 const profiles=[claude&&'Claude Code',codex&&'Codex'].filter(Boolean).join(' and ');
 return 'Setup adds global sharing instructions to '+profiles+'.'+(claude?' Claude Code also allows OpenCrawl’s file, board and search tools.':'');
}

/** Load the terminal renderer only for human setup, never capture hooks or JSON calls. */
export async function chooseSetupItems(screen:SelectionScreen):Promise<SelectionItem[]|null>{
 if(screen.phase===2&&!screen.items.length){process.stderr.write('\n'+screen.title+'\n'+(screen.emptyMessage??'No available choices.')+'\n');return [];}
 const {runSelection}=await import('./select-view.tsx');
 return runSelection(screen);
}
