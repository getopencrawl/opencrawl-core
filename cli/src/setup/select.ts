export type SelectionItem={id:string;label:string;selected:boolean;detail?:string;needsReinstall?:boolean;disabled?:boolean};
export type SelectionScreen={title:string;description:string;items:SelectionItem[];noneLabel:string;phase:1|2|3;emptyMessage?:string};

/** Load the terminal renderer only for human setup, never capture hooks or JSON calls. */
export async function chooseSetupItems(screen:SelectionScreen):Promise<SelectionItem[]|null>{
 if(!screen.items.length){process.stderr.write('\n'+screen.title+'\n'+(screen.emptyMessage??'No available choices.')+'\n');return [];}
 const {runSelection}=await import('./select-view.tsx');
 return runSelection(screen);
}
