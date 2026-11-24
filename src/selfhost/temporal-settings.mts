import {createHash} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import {readFileSync} from 'node:fs';
import type {connectorClient} from '../connectors/temporal/client.mjs';
import type {WorkerConnectionOptions} from '../connectors/temporal/types.mjs';
type ConnectionOptions=NonNullable<Parameters<typeof connectorClient>[0]['connectionOptions']> & NonNullable<WorkerConnectionOptions['connectionOptions']>;

/** One operator-owned connection contract for API schedulers and native workers. */
export function selfhostTemporalSettings(env:NodeJS.ProcessEnv=process.env):{
  address:string; namespace:string; connectionOptions:ConnectionOptions;
} {
  const address=env.TEMPORAL_ADDRESS?.trim(),namespace=env.TEMPORAL_NAMESPACE?.trim();
  if(!address||!namespace)throw new Error('Configure TEMPORAL_ADDRESS and TEMPORAL_NAMESPACE');
  const mode=env.TEMPORAL_TLS_ENABLED??'false';
  if(!['true','false'].includes(mode))throw new Error('TEMPORAL_TLS_ENABLED must be true or false');
  const ca=env.TEMPORAL_TLS_CA_PATH,cert=env.TEMPORAL_TLS_CERT_PATH,key=env.TEMPORAL_TLS_KEY_PATH;
  if(Boolean(cert)!==Boolean(key))throw new Error('Set both TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH');
  if(env.TEMPORAL_API_KEY&&env.TEMPORAL_API_KEY_PATH)throw new Error('Set only one Temporal API key source');
  const apiKey=env.TEMPORAL_API_KEY_PATH?readFileSync(env.TEMPORAL_API_KEY_PATH,'utf8').trim():env.TEMPORAL_API_KEY?.trim();
  if((ca||cert||key||env.TEMPORAL_TLS_SERVER_NAME||apiKey)&&mode!=='true')throw new Error('Temporal credentials and certificates require TEMPORAL_TLS_ENABLED=true');
  if((env.TEMPORAL_API_KEY_PATH||env.TEMPORAL_API_KEY)&&!apiKey)throw new Error('Temporal API key is empty');
  const connectionOptions:ConnectionOptions={};
  if(mode==='true')connectionOptions.tls={
    ...(ca?{serverRootCACertificate:readFileSync(ca)}:{}),
    ...(cert&&key?{clientCertPair:{crt:readFileSync(cert),key:readFileSync(key)}}:{}),
    ...(env.TEMPORAL_TLS_SERVER_NAME?{serverNameOverride:env.TEMPORAL_TLS_SERVER_NAME}:{}),
  };
  if(apiKey){connectionOptions.apiKey=apiKey;connectionOptions.metadata={'temporal-namespace':namespace};}
  return {address,namespace,connectionOptions};
}

/** Other installations may share this operator's external Temporal namespace. */
export function selfhostTeamQueue(database:Pick<ApplicationDatabase,'namespace'|'sourceIdentity'>) {
  const source=database.sourceIdentity;
  if (!source?.organizationId) throw Error('Team worker requires a bound installation');
  const identity=JSON.stringify([database.namespace,source.organizationId,source.bucket,source.prefix]);
  return 'team-member-v1-'+createHash('sha256').update(identity).digest('hex');
}
