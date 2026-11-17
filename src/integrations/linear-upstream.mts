import {readFileSync} from 'node:fs';
import type {ConnectorManifest} from './types.mjs';
import type {JsonObject, JsonValue} from '../sessions/types.mjs';

export const LINEAR_API = 'https://api.linear.app/graphql';
export const LINEAR_VERSION = '1.0.3';
const upstream = JSON.parse(readFileSync(new URL('./upstream/linear/manifest.json', import.meta.url), 'utf8')) as JsonObject;
const object = (value: JsonValue | undefined) => value as JsonObject;
const definitions = object(upstream.definitions);

/** Resolve upstream references without changing queries, fields, pagination or transforms. */
export function linearStream(name: string): JsonObject {
  const value = object(object(definitions.streams)[name]);
  if (!value) throw new Error('Unknown Linear stream');
  if (value.$ref === '#/definitions/base_issues_stream') return {...object(definitions.base_issues_stream), ...value};
  return value;
}
export const LINEAR_STREAMS = Object.keys(object(definitions.streams));
export function linearRecordPath(name: string): string[] {
  return [...object(object(object(linearStream(name).retriever).record_selector).extractor).field_path as string[]];
}
export const LINEAR_KINDS: Record<string, string> = {
  issues: 'issue', comments: 'comment', projects: 'project', project_updates: 'project_update',
  project_milestones: 'project_milestone', project_statuses: 'project_status', users: 'user', teams: 'team',
  cycles: 'cycle', issue_labels: 'issue_label', workflow_states: 'workflow_state', attachments: 'attachment',
  issue_relations: 'issue_relation', issue_history: 'issue_history', customers: 'customer',
  customer_needs: 'customer_need', customer_statuses: 'customer_status', customer_tiers: 'customer_tier',
  initiatives: 'initiative', initiative_to_projects: 'initiative_to_project',
};
export function linearStreamSettings() {
  return LINEAR_STREAMS.map(name => ({name, syncMode: linearStream(name).incremental_sync ? 'incremental_append' : 'full_refresh_append',
    ...(linearStream(name).incremental_sync ? {cursorField: ['updatedAt']} : {})}));
}
const canonical = (query: string) => query.replace(/\s+/g, ' ').trim();
export const LINEAR_QUERIES = new Map(LINEAR_STREAMS.map(name => {
  const requester = object(object(linearStream(name).retriever).requester);
  return [canonical(String(object(requester.request_body_json).query)), name];
}));
export function linearQueryStream(query: unknown): string | undefined {
  return typeof query === 'string' ? LINEAR_QUERIES.get(canonical(query)) : undefined;
}

/**
 * Airbyte's complete pinned source, with transport-only changes for operator OAuth.
 * All 20 streams, queries, schemas, transforms, cursors and rate-limit handling stay upstream.
 * The upstream manifest and license are shipped unchanged alongside this adapter.
 */
export function linearManifest(): ConnectorManifest {
  const manifest = structuredClone(upstream);
  const defs = object(manifest.definitions), requester = object(defs.base_requester);
  requester.url_base = "{{ config['credential_proxy_base_url'] }}";
  requester.authenticator = {type: 'ApiKeyAuthenticator', api_token: "{{ config['credential_proxy_api_key'] }}",
    inject_into: {type: 'RequestOption', inject_into: 'header', field_name: 'x-api-key'}};
  // Each upstream requester supplies its own path and request_headers, so adapt those leaves.
  function transport(value: JsonValue | undefined): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {value.forEach(transport); return;}
    if (value.$ref === '#/definitions/base_requester') {
      value.path = '/api/connector-proxy';
      value.request_headers = {...object(value.request_headers),
        'x-opencrawl-linear-account': "{{ config['connected_account_id'] }}",
        'x-opencrawl-linear-user': "{{ config['user_id'] }}"};
    }
    Object.values(value).forEach(transport);
  }
  transport(defs);
  const spec = object(manifest.spec), sourceSpec = object(spec.connection_specification), properties = object(sourceSpec.properties);
  // The upstream request budget branches on this marker, without any token fields.
  properties.credentials = {type: 'object', required: ['auth_type'], additionalProperties: false,
    properties: {auth_type: {type: 'string', const: 'OAuth2.0'}}};
  spec.connection_specification = {...sourceSpec, required: ['credential_proxy_base_url', 'credential_proxy_api_key', 'connected_account_id', 'user_id'],
    properties: {...properties, credential_proxy_base_url: {type: 'string'}, credential_proxy_api_key: {type: 'string', airbyte_secret: true},
      connected_account_id: {type: 'string'}, user_id: {type: 'string'}}};
  delete spec.advanced_auth;
  // Upstream's API-key/OAuth migration concerns credentials owned by its authenticator.
  delete spec.config_normalization_rules;
  return manifest as unknown as ConnectorManifest;
}
