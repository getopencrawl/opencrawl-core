import {Button, EmptyState, LoadingState, Page, Section} from '../design/components.tsx';
import {Link, Navigate, useLocation} from '../router.tsx';
import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {filePath} from '../../../src/application/file-links.mjs';
import type {ConsoleDataAdapter} from './types.ts';

export function WorkspaceFilesPage({adapter}:{adapter:ConsoleDataAdapter}) {
  const {pathname}=useLocation();
  const {data,error,reload}=useConsoleResource([...consoleResourceKey(adapter,'file-view'),pathname],signal=>adapter.fileView!(pathname,signal), {enabled:Boolean(adapter.fileView)});
  if(error||!adapter.fileView) return <Page title="Workspace files"><EmptyState title="Revision unavailable" description={error||'Workspace files are unavailable.'} action={adapter.fileView&&<Button onClick={()=>void reload()}>Try again</Button>}/></Page>;
  if(!data) return <Page title="Workspace files"><LoadingState label="Loading revision"/></Page>;
  const revision={workspace:data.workspace,revision:data.commit};
  const commit=filePath(revision);
  if(pathname==='/files')return <Navigate replace to={commit}/>;
  return <Page title={data.kind==='file'?data.path:data.title||'Commit'} description={[data.author,data.time].filter(Boolean).join(', ')}>
    <p>Commit <Link to={commit}><code>{data.commit}</code></Link></p>
    {data.kind==='file'
      ? <Section title="File content">{data.text===null?<p>{data.large?'File exceeds the preview limit.':'Binary file.'} {data.bytes.toLocaleString()} bytes.</p>:<pre className="oc-file-content"><code>{data.text}</code></pre>}</Section>
      : <><Section title="Files at this revision">{data.files.length?<ul>{data.files.map(path=><li key={path}><Link to={filePath({...revision,path})}>{path}</Link></li>)}</ul>:<p>No files at this revision.</p>}{data.truncated&&<p>Showing the first {data.files.length} files.</p>}</Section>
        {data.parents.length>0&&<Section title="Parent commits"><ul>{data.parents.map(parent=><li key={parent}><Link to={filePath({...revision,revision:parent})}><code>{parent}</code></Link></li>)}</ul></Section>}</>}
  </Page>;
}
