import type {Principal} from '../sessions/types.mjs';
import {parseJson} from '../sessions/types.mjs';
import type {RealmOptions, SearchInput} from './types.mjs';
import type {ConnectorBinding} from '../connectors/types.mjs';
interface OperatorSearchConfig {principal: Principal; sessions?: RealmOptions; connectors?: {bindings: ConnectorBinding[]; search: RealmOptions}}
import {readFile} from 'node:fs/promises';
import {createWorkspaceSearch} from './workspace.mjs';
import {createSessionSearch} from '../sessions/search.mjs';
import {createConnectorSearch} from '../connectors/search.mjs';
import {validateBinding, authorize} from '../connectors/scope.mjs';
import {sessionScope} from '../sessions/ingest.mjs';

/** Operator-owned config only. Requests cannot choose credentials, indexes or bindings. */
export async function configuredWorkspaceSearch(path: string) {
  const config = parseJson<OperatorSearchConfig>(await readFile(path, 'utf8'));
  const {principal} = config; sessionScope(principal);
  const sessions = config.sessions ? createSessionSearch({...config.sessions, tenantId:principal.tenantId}) : undefined;
  let connectors;
  if (config.connectors) {
    const bindings = config.connectors.bindings.map(validateBinding);
    for (const binding of bindings) authorize(principal, binding);
    const adapter = createConnectorSearch({...config.connectors.search, tenantId: principal.tenantId});
    connectors = {search: (who: Principal, input: SearchInput & {raw?: false}) => bindings.length ? adapter.search(who, bindings, input) : Promise.resolve({hits: [], truncated: false})};
  }
  return {principal, search: createWorkspaceSearch({sessions, connectors})};
}
