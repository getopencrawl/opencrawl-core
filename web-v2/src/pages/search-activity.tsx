import {consoleResourceKey,useConsoleResource} from '../data.tsx';
import {Button,DailyBarChart,LoadingState,MetricGrid,Notice,Section} from '../design/components.js';
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

/** One billable count on a tab: its number, its bars by day, then its rows. */
function ActivityTab({adapter,scope,range,names,kind}:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames;kind:'agent'|'proactive'}){
  const {data,error,loading,reload}=useCallTotals(adapter,scope,range);
  const edits=kind==='proactive';
  const label=edits?'Proactive context edits':'Agent searches';
  const value=(totals:CallTotals)=>edits?totals.nonSilent:totals.agentSearches;
  const request:HistoryRequest={kind,range,...edits?{edits:true as const}:{}};
  return <>
    {error&&<Notice tone="warning" actions={<Button onClick={reload}>Try again</Button>}>{label} couldn’t update.</Notice>}
    {loading&&!data&&<LoadingState label={'Loading '+label.toLowerCase()}/>}
    {data&&<>
      <MetricGrid items={[{label,value:compact(value(data)),title:count(value(data))}]}/>
      <Section className="report-panel" headingLevel={3} title={edits?'Proactive context edits per day':'Agent searches per day'}>
        <DailyBarChart days={(data.daily??[]).map(day=>({date:day.date,value:edits?day.nonSilent:day.agentSearches}))} label={label+' per day'}
          unit={n=>edits?plural(n,'edit'):plural(n,'search','searches')}/>
      </Section>
    </>}
    <Section className="report-panel" headingLevel={3} title={edits?'Edits':'Searches'}>
      <PagedList<SearchActivityRow,NonNullable<HistoryRequest['before']>> resetKey={JSON.stringify([scope,request])} label={edits?'Proactive context edits':'Agent searches'}
        className="usage-search-history" empty={edits?'No proactive context edits in this period.':'No agent searches in this period.'}
        load={async(before,signal)=>scoped(scope,await adapter.searchHistory({...request,...before?{before}:{}},signal))}
        head={<tr><th scope="col">Time</th>{edits&&<th scope="col">Triggering message</th>}<th scope="col">{edits?'Search':'Query'}</th>{edits&&<th scope="col">Results</th>}<th scope="col">From</th><th scope="col">Session</th></tr>}
        row={row=><tr key={row.id}>
          <td>{time(row.at)}</td>
          {edits&&<td>{row.message??<span className="report-email">Message unavailable</span>}</td>}
          <td>{row.queries.length?row.queries.join('\n'):<span className="report-email">No query text</span>}</td>
          {edits&&<td>{row.returned==null?'Unavailable':count(row.returned)}</td>}
          <td><From userId={row.userId} harness={row.harness} names={names}/></td>
          <td><SessionLink userId={row.userId} harness={row.harness} sessionId={row.sessionId}/></td>
        </tr>}/>
      <p className="report-note">Lists show the last 30 days at most, from sessions you can see. The count includes every {edits?'edit':'search'}.</p>
    </Section>
  </>;
}

export const SearchesTab=(props:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames})=><ActivityTab {...props} kind="agent"/>;
export const ProactiveTab=(props:{adapter:ActivityAdapter;scope:string;range:UsageRange;names:MemberNames})=><ActivityTab {...props} kind="proactive"/>;
