import type {Proxy, ProxyRequest, ProxyResponse} from './types.mjs';
import type {DriveAudience, DriveFile} from './google-drive-access.mjs';
import {DRIVE_API, DRIVE_POLICY, createDriveAccess, driveId, driveResponse} from './google-drive-access.mjs';
import {digest} from '../connectors/scope.mjs';
import {extractDocumentText} from '../connectors/document-text.mjs';

export const DRIVE_SOURCE_ENDPOINT = 'opencrawl://googledrive/workspace-documents';
export interface DriveDocumentRecord extends Record<string, unknown> {
  id: string; name: string; mimeType: string; version: string; modifiedTime: string;
  text: string; extractionStatus: 'extracted' | 'empty' | 'unsupported';
  access: {policy: typeof DRIVE_POLICY; tenantId: string; connectionId: string; fileId: string; audienceHash: string; permissionHash: string; checkedAt: number; contentHash: string};
}
interface SourceOptions {tenantId: string; connectionId: string; request: Proxy; audience: DriveAudience; now?: () => number; fetch?: typeof globalThis.fetch}
interface Cursor {version: 1; plan: string; scope: number; token?: string}
const MAX_BODY = 8 * 1024 * 1024;
const consumerDomains = new Set(['gmail.com', 'googlemail.com']);
const textTypes = new Set(['application/json', 'application/xml', 'application/yaml', 'application/pdf', 'application/xhtml+xml']);

/** Broker downloads carry no provider credentials; only signed AWS object URLs are accepted. */
async function bodyBytes(response: ProxyResponse<unknown>, send: typeof globalThis.fetch): Promise<Uint8Array> {
  if (response.status < 200 || response.status >= 300) throw new Error(`Drive content returned ${response.status}`);
  if (typeof response.data === 'string') {
    const bytes = Buffer.from(response.data);
    if (bytes.length > MAX_BODY) throw new Error('Drive body exceeds supported size');
    return bytes;
  }
  if (!response.binary_data?.url) throw new Error('Drive export has no supported content representation');
  const url = new URL(response.binary_data.url);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    !/^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname) ||
    !url.searchParams.has('X-Amz-Signature')) throw new Error('Unsupported Drive export download origin');
  const reply = await send(url, {redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!reply.ok || !reply.body || Number(reply.headers.get('content-length')) > MAX_BODY) throw new Error('Drive export download unavailable or oversized');
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of reply.body) {length += chunk.length; if (length > MAX_BODY) throw new Error('Drive export exceeds supported size'); chunks.push(chunk);}
  return Buffer.concat(chunks);
}

interface Sheet {properties?: {title?: string}; data?: Array<{startRow?: number; startColumn?: number; rowData?: Array<{values?: Array<{formattedValue?: string; note?: string; userEnteredValue?: {formulaValue?: string}}>}>}>}
async function content(request: Proxy, file: DriveFile, send: typeof globalThis.fetch) {
  let body: string;
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    const data = driveResponse(await request<{spreadsheetId: string; sheets: Sheet[]}>({endpoint: `https://sheets.googleapis.com/v4/spreadsheets/${file.id}`,
      query: {fields: 'spreadsheetId,sheets(properties(title),data(startRow,startColumn,rowData(values(formattedValue,note,userEnteredValue(formulaValue)))))'}}));
    if (data.spreadsheetId !== file.id || !Array.isArray(data.sheets)) throw new Error('Invalid Drive spreadsheet response');
    const lines: string[] = [];
    for (const sheet of data.sheets) {
      lines.push(`# ${sheet.properties?.title || 'Sheet'}`);
      for (const grid of sheet.data || []) for (const [row, record] of (grid.rowData || []).entries()) {
        const cells = (record.values || []).map((cell, col) => {
          const value = [cell.formattedValue, cell.userEnteredValue?.formulaValue, cell.note].filter(value => value !== undefined && value !== '');
          if (value.some(value => typeof value !== 'string')) throw new Error('Invalid Drive spreadsheet cell');
          return value.length ? `R${(grid.startRow || 0) + row + 1}C${(grid.startColumn || 0) + col + 1}: ${value.join('\n')}` : '';
        }).filter(Boolean);
        lines.push(...cells);
      }
    }
    body = lines.join('\n');
  } else {
    const exports: Record<string, string> = {'application/vnd.google-apps.document': 'text/markdown', 'application/vnd.google-apps.presentation': 'text/plain'};
    const exported = exports[file.mimeType], mediaType = exported || file.mimeType;
    if (!exported && !mediaType.startsWith('text/') && !textTypes.has(mediaType)) return {text: '', extractionStatus: 'unsupported' as const};
    if (!exported && (!/^\d+$/.test(file.size || '') || Number(file.size) > MAX_BODY)) throw new Error('Drive download size is unknown or exceeds supported size');
    const response = await request<unknown>({endpoint: `${DRIVE_API}/files/${file.id}${exported ? '/export' : ''}`,
      query: exported ? {mimeType: exported} : {alt: 'media', supportsAllDrives: true}});
    const bytes = await bodyBytes(response, send);
    if (!exported && bytes.length !== Number(file.size)) throw new Error('Drive download size mismatch');
    if (!bytes.length) return {text: '', extractionStatus: 'empty' as const};
    const extracted = await extractDocumentText(bytes, {mediaType, timeoutMs: 30000});
    body = extracted.parts.map(part => part.text).join('\n');
  }
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error('Drive extracted text exceeds supported size');
  return {text: body, extractionStatus: body.trim() ? 'extracted' as const : 'empty' as const};
}

/** A virtual source endpoint, never a transparent Google API proxy. Reads and
 * exports are chosen here after checking current membership and file ACLs. */
export function createGoogleDriveSource({tenantId, connectionId, request, audience, now = Date.now, fetch: send = globalThis.fetch}: SourceOptions) {
  if (!/^org_[A-Za-z0-9]+$/.test(tenantId) || !/^int_[a-f0-9]{26}$/.test(connectionId)) throw new Error('Invalid Drive source scope');
  async function plan() {
    const drives: string[] = [], seen = new Set<string>(); let pageToken: string | undefined;
    do {
      const page = driveResponse(await request<{drives: Array<{id: string}>; nextPageToken?: string}>({endpoint: DRIVE_API + '/drives', query: {pageSize: 100, fields: 'nextPageToken,drives(id)', pageToken}}));
      if (!Array.isArray(page.drives)) throw new Error('Missing Drive container inventory');
      for (const drive of page.drives) {driveId(drive.id); drives.push(drive.id);}
      if (drives.length > 1000) throw new Error('Drive container inventory exceeds supported size');
      pageToken = page.nextPageToken;
      if (pageToken) {if (seen.has(pageToken)) throw new Error('Repeating Drive container cursor'); seen.add(pageToken);}
    } while (pageToken);
    const account = driveResponse(await request<{user?: {emailAddress?: string}}>({endpoint: DRIVE_API + '/about', query: {fields: 'user(emailAddress)'}}));
    const email = account.user?.emailAddress;
    if (typeof email !== 'string' || !email.includes('@')) throw new Error('Missing Drive account identity');
    return ['user', ...[...new Set(drives)].sort().map(id => 'drive:' + id), ...consumerDomains.has(email.toLowerCase().split('@')[1]) ? [] : ['domain']];
  }
  return {
    async read(input: ProxyRequest): Promise<ProxyResponse<{documents: DriveDocumentRecord[]; nextPageToken?: string; examined: number; excluded: number}>> {
      if (input.endpoint !== DRIVE_SOURCE_ENDPOINT || input.method !== undefined && input.method !== 'GET' || input.body !== undefined || Object.keys(input.headers || {}).length || Object.keys(input.query || {}).some(key => key !== 'pageToken')) throw Object.assign(new Error('Drive source request denied'), {status: 403});
      const scopes = await plan(), planHash = digest(scopes);
      let cursor: Cursor = {version: 1, plan: planHash, scope: 0};
      const token = input.query?.pageToken;
      if (token !== undefined && token !== '') {
        if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Drive source cursor');
        try {cursor = JSON.parse(Buffer.from(token, 'base64url').toString());} catch {throw new Error('Invalid Drive source cursor');}
        if (!cursor || cursor.version !== 1 || cursor.plan !== planHash || !Number.isSafeInteger(cursor.scope) || cursor.scope < 0 || cursor.scope >= scopes.length || cursor.token !== undefined && typeof cursor.token !== 'string') throw new Error('Drive source inventory changed or cursor is invalid');
      }
      const scope = scopes[cursor.scope], isDrive = scope.startsWith('drive:');
      const page = driveResponse(await request<{files: Array<{id: string}>; nextPageToken?: string; incompleteSearch?: boolean}>({endpoint: DRIVE_API + '/files',
        query: {corpora: isDrive ? 'drive' : scope, ...(isDrive ? {driveId: scope.slice(6)} : {}), supportsAllDrives: true, includeItemsFromAllDrives: true,
          pageSize: 1, pageToken: cursor.token, q: "trashed = false and mimeType != 'application/vnd.google-apps.folder' and mimeType != 'application/vnd.google-apps.shortcut'", fields: 'nextPageToken,incompleteSearch,files(id)'}}));
      if (page.incompleteSearch === true || !Array.isArray(page.files) || page.files.length > 1) throw new Error('Incomplete Drive source inventory');
      const access = createDriveAccess({request, audience, now}), documents: DriveDocumentRecord[] = [];
      for (const candidate of page.files) {
        driveId(candidate.id);
        const allowed = await access.inspect(candidate.id);
        if (!allowed) continue;
        const file = allowed.file;
        if (file.capabilities?.canDownload !== true) continue;
        const extracted = await content(request, file, send);
        // Check ACLs and source revision again before any body leaves this process.
        const current = await access.inspect(file.id);
        if (!current) continue;
        if (current.file.version !== file.version || current.permissionHash !== allowed.permissionHash) throw new Error('Drive file changed during extraction; retry the page');
        documents.push({id: file.id, name: file.name, mimeType: file.mimeType, version: file.version, modifiedTime: file.modifiedTime, ...extracted,
          access: {policy: DRIVE_POLICY, tenantId, connectionId, fileId: file.id, audienceHash: current.audienceHash, permissionHash: current.permissionHash, checkedAt: current.checkedAt, contentHash: digest(extracted.text)}});
      }
      await access.validateAudience();
      if (page.nextPageToken && (typeof page.nextPageToken !== 'string' || page.nextPageToken === cursor.token)) throw new Error('Non-advancing Drive file cursor');
      const next: Cursor | null = page.nextPageToken ? {...cursor, token: page.nextPageToken} : cursor.scope + 1 < scopes.length ? {version: 1, plan: planHash, scope: cursor.scope + 1} : null;
      return {status: 200, data: {documents, ...(next ? {nextPageToken: Buffer.from(JSON.stringify(next)).toString('base64url')} : {}), examined: page.files.length, excluded: page.files.length - documents.length}};
    },
  };
}
