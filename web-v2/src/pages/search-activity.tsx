import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {Button,DailyBarChart,LoadingState,Notice,Section} from '../design/components.js';
import {Link} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
import type {HistoryRequest,SearchActivityRow} from '../../../src/application/search-activity.mjs';
import type {UsageRange} from '../../../src/application/usage-range.mjs';
import {compact,count,harnessName,plural} from './usage-model.ts';
import {PagedList} from './usage-list.tsx';

const refresh={autoRefreshMilliseconds:60_000,staleMilliseconds:60_000};
const dateFormat=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
export type ActivityAdapter=Required<Pick<ConsoleDataAdapter,'callTotals'|'searchHistory'>>;
/** Display names by user ID; anyone outside the list shows as a workspace member. */
export type MemberNames=ReadonlyMap<string,string>;

export function scoped<T extends {cacheScope:string}>(scope:string,result:T){
  if(scope!==result.cacheScope)throw Object.assign(new Error('Your workspace changed. Reload this page.'),{status:403});
  return result;
}

export function useCallTotals(adapter:ActivityAdapter,scope:string,range:UsageRange){
  return useConsoleResource([...consoleResourceKey(adapter,'call-totals'),range],async signal=>scoped(scope,await adapter.callTotals(range,signal)),refresh);
}

export function From({userId,harness,names}:{userId:string;harness:string|null;names:MemberNames}){
  return <>{names.get(userId)??'Workspace member'}{harness&&<span className="report-email">{harnessName(harness)}</span>}</>;
}

export function SessionLink({userId,harness,sessionId,label}:{userId:string;harness:string|null;sessionId:string|null;label?:string}){
  if(!sessionId||!harness)return <span className="report-email">Not recorded</span>;
  return <Link to={'/sessions?'+new URLSearchParams({user:userId,harness,id:sessionId})}>{label ?? <code>{sessionId.slice(0,8)}</code>}</Link>;
}

const time=(at:string)=><time dateTime={at} title={at}>{dateFormat.format(new Date(at))}</time>;


const withheldText={private:'Private session',session_deleted:'Deleted with its session',expired:'Search text no longer kept',unrecorded:'Recorded before search text was kept'} as const;
function Withheld({reason}:{reason:keyof typeof withheldText}){return <span className="report-email">{withheldText[reason]}</span>;}
function Charge({charge}:{charge:NonNullable<SearchActivityRow['charge']>}){
  if(charge.reason==='charged')return <strong>{plural(charge.credits,'credit')}</strong>;
  return <>Free<span className="report-email">{charge.reason==='failed'?'Search failed':'No results'}</span></>;
}
export function ProactiveTab({adapter,scope,range,names}:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames}){
  const {data,error,loading,reload}=useCallTotals(adapter,scope,range);
  const billed=data?.charged===true;
  return <>
    {error&&<Notice tone="warning" actions={<Button onClick={reload}>Try again</Button>}>Proactive context edits couldn’t update.</Notice>}
    {loading&&!data&&<LoadingState spinner label="Loading proactive context edits…"/>}
    {data&&<Section className="report-panel" headingLevel={3} title="Proactive context edits"
      description="Proactive searches that ran and returned at least one result. OpenCrawl runs these on its own when an agent gets a new prompt; ones that find nothing are not counted."
      actions={<span className="report-chart-total" title={count(data.nonSilent)}>{compact(data.nonSilent)}</span>}>
      <DailyBarChart days={(data.daily??[]).map(day=>({date:day.date,value:day.nonSilent}))} label="Proactive context edits per day" unit={n=>plural(n,'edit')}/>
    </Section>}
    <Section className="report-panel" headingLevel={3} title="Edits">
      {billed&&data.rates&&<p className="report-note usage-charge-summary">{plural(data.nonSilent,'edit')} charged × {plural(data.rates.proactive,'credit')} = {plural(data.nonSilent*data.rates.proactive,'credit')}.</p>}
      <PagedList<SearchActivityRow,NonNullable<HistoryRequest['before']>> cacheKey={[...consoleResourceKey(adapter,'usage-search-lines'),'proactive',range]} label="Proactive context edits"
        className="usage-search-history" empty="No proactive context edits in this period."
        load={async(before,signal)=>scoped(scope,await adapter.searchHistory({kind:'proactive',range,edits:true,before},signal))}
        head={<tr><th scope="col">Time</th><th scope="col">Triggering message</th><th scope="col">Search</th>
          <th scope="col">Results</th><th scope="col">From</th><th scope="col">Session</th>{billed&&<th scope="col">Charge</th>}</tr>}
        row={row=><tr key={row.id}>
          <td>{time(row.at)}</td>
          <td>{row.withheld?<Withheld reason={row.withheld}/>:row.message??<span className="report-email">Message unavailable</span>}</td>
          <td>{row.withheld?null:row.queries.length?row.queries.join('\n'):<span className="report-email">No query text</span>}</td>
          <td>{row.returned==null?<span className="report-email">{row.charge?.reason==='failed'?'None':'Not recorded'}</span>:count(row.returned)}</td>
          <td>{row.userId?<From userId={row.userId} harness={row.harness} names={names}/>:<span className="report-email">Not recorded</span>}</td>
          <td><SessionLink userId={row.userId} harness={row.harness} sessionId={row.sessionId}/></td>
          {billed&&<td>{row.charge?<Charge charge={row.charge}/>:null}</td>}
        </tr>}/>
      <p className="report-note">{billed
        ?'Every edit that was charged is listed. A check that finds nothing is free and is not listed. Search text from a session you can’t open is hidden; the row and its charge are still shown.'
        :'The total counts every edit. The list shows those from sessions you can see, for the last 30 days at most.'}</p>
    </Section>
  </>;
}
