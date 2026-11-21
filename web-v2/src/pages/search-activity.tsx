import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {Button,DailyBarChart,LoadingState,Notice,Section} from '../design/components.js';
import {Link} from '../router.js';
import type {ConsoleDataAdapter} from './types.js';
import type {CallTotals,HistoryRequest,SearchActivityRow} from '../../../src/application/search-activity.mjs';
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

export function SessionLink({userId,harness,sessionId}:{userId:string;harness:string|null;sessionId:string|null}){
  if(!sessionId||!harness)return <span className="report-email">Not recorded</span>;
  return <Link to={'/sessions?'+new URLSearchParams({user:userId,harness,id:sessionId})}><code>{sessionId.slice(0,8)}</code></Link>;
}

const time=(at:string)=><time dateTime={at} title={at}>{dateFormat.format(new Date(at))}</time>;


const withheldText={private:'Private session',session_deleted:'Deleted with its session',expired:'Search text no longer kept',unrecorded:'Recorded before search text was kept'} as const;
function Withheld({reason}:{reason:keyof typeof withheldText}){return <span className="report-email">{withheldText[reason]}</span>;}
function Charge({charge}:{charge:NonNullable<SearchActivityRow['charge']>}){
  if(charge.reason==='charged')return <strong>{plural(charge.credits,'credit')}</strong>;
  return <>Free<span className="report-email">{charge.reason==='failed'?'Search failed':'No results'}</span></>;
}
/** The arithmetic behind the charge for this range: charged rows times the rate, and what was free. */
function chargeSummary(totals:CallTotals,edits:boolean){
  const charged=edits?totals.nonSilent:totals.agentSearches,rate=edits?totals.rates!.proactive:totals.rates!.agent;
  const sum=`${plural(charged,edits?'edit':'search',edits?'edits':'searches')} charged × ${plural(rate,'credit')} = ${plural(charged*rate,'credit')}.`;
  const free=totals.uncharged;
  return edits||!free||free.noResults+free.failed===0?sum:`${sum} ${plural(free.noResults,'search','searches')} with no results and ${count(free.failed)} failed: free.`;
}

/** One billable count on a tab: its number, its bars by day, then its rows. */
function ActivityTab({adapter,scope,range,names,kind}:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames;kind:'agent'|'proactive'}){
  const {data,error,loading,reload}=useCallTotals(adapter,scope,range);
  const edits=kind==='proactive';
  const label=edits?'Proactive context edits':'Agent searches';
  const value=(totals:CallTotals)=>edits?totals.nonSilent:totals.agentSearches;
  const request:HistoryRequest={kind,range,...edits?{edits:true as const}:{}};
  const billed=data?.charged===true;
  return <>
    {error&&<Notice tone="warning" actions={<Button onClick={reload}>Try again</Button>}>{label} couldn’t update.</Notice>}
    {loading&&!data&&<LoadingState spinner label={'Loading '+label.toLowerCase()+'…'}/>}
    {data&&<Section className="report-panel" headingLevel={3} title={label}
      description={edits?'Proactive searches that ran and returned at least one result. OpenCrawl runs these on its own when an agent gets a new prompt; ones that find nothing are not counted.'
        :billed?'Searches your agents ran that returned at least one result. Searches with no results, or that failed, are listed below and are free.'
        :'Every search your agents ran through OpenCrawl.'} actions={<span className="report-chart-total" title={count(value(data))}>{compact(value(data))}</span>}>
      <DailyBarChart days={(data.daily??[]).map(day=>({date:day.date,value:edits?day.nonSilent:day.agentSearches}))} label={label+' per day'}
        unit={n=>edits?plural(n,'edit'):plural(n,'search','searches')}/>
    </Section>}
    <Section className="report-panel" headingLevel={3} title={edits?'Edits':'Searches'}>
      {data?.charged&&data.rates&&<p className="report-note usage-charge-summary">{chargeSummary(data,edits)}</p>}
      <PagedList<SearchActivityRow,NonNullable<HistoryRequest['before']>> cacheKey={[...consoleResourceKey(adapter,'usage-search-lines'),kind,range]} label={edits?'Proactive context edits':'Agent searches'}
        className="usage-search-history" empty={edits?'No proactive context edits in this period.':'No agent searches in this period.'}
        load={async(before,signal)=>scoped(scope,await adapter.searchHistory({...request,...before?{before}:{}},signal))}
        head={<tr><th scope="col">Time</th>{edits&&<th scope="col">Triggering message</th>}<th scope="col">{edits?'Search':'Query'}</th>
          {billed&&!edits&&<th scope="col">Searched</th>}{(edits||billed)&&<th scope="col">Results</th>}<th scope="col">From</th><th scope="col">Session</th>{billed&&<th scope="col">Charge</th>}</tr>}
        row={row=><tr key={row.id}>
          <td>{time(row.at)}</td>
          {edits&&<td>{row.withheld?<Withheld reason={row.withheld}/>:row.message??<span className="report-email">Message unavailable</span>}</td>}
          <td>{row.withheld?(edits?null:<Withheld reason={row.withheld}/>):row.queries.length?row.queries.join('\n'):<span className="report-email">No query text</span>}</td>
          {billed&&!edits&&<td>{row.operation||<span className="report-email">Not recorded</span>}</td>}
          {(edits||billed)&&<td>{row.returned==null?<span className="report-email">{row.charge?.reason==='failed'?'None':'Not recorded'}</span>:count(row.returned)}</td>}
          <td>{row.userId?<From userId={row.userId} harness={row.harness} names={names}/>:<span className="report-email">Not recorded</span>}</td>
          <td><SessionLink userId={row.userId} harness={row.harness} sessionId={row.sessionId}/></td>
          {billed&&<td>{row.charge?<Charge charge={row.charge}/>:null}</td>}
        </tr>}/>
      <p className="report-note">{billed
        ?(edits?'Every edit that was charged is listed. A check that finds nothing is free and is not listed.':'Every search is listed, charged or not. A search costs credits only when its results reach the agent.')+' Search text from a session you can’t open is hidden; the row and its charge are still shown.'
        :'The total counts every '+(edits?'edit':'search')+'. The list shows those from sessions you can see, for the last 30 days at most.'}</p>
    </Section>
  </>;
}

export const SearchesTab=(props:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames})=><ActivityTab {...props} kind="agent"/>;
export const ProactiveTab=(props:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames})=><ActivityTab {...props} kind="proactive"/>;
