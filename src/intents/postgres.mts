import {createHash} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal} from '../sessions/types.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';
import {fail} from '../errors.mjs';
import {groundIntentCorpus, visibleIntentCorpus, type IntentCorpus, type IntentPassage, type IntentSource} from './corpus.mjs';

type Publication = {runId: string; from: string; until: string};
type VisibleSources = (workspace: string, sources: readonly IntentSource[]) => Promise<ReadonlySet<string>>;

export function createIntentCorpusStore(db: ApplicationDatabase, origin: string, sharedSources: VisibleSources) {
  let prepared: Promise<void> | undefined;
  function ready() {
    prepared ??= db.ready().then(() => db.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl_intent_corpus_schema_1', 0))");
      await tx.query(`CREATE TABLE IF NOT EXISTS opencrawl_intent_corpus (
        namespace text NOT NULL, workspace text NOT NULL, run_id uuid NOT NULL,
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
        published_at timestamptz NOT NULL DEFAULT now(), digest text NOT NULL,
        conflicts jsonb NOT NULL, PRIMARY KEY (namespace,workspace)
      )`);
      await tx.query(`CREATE TABLE IF NOT EXISTS opencrawl_intent_records (
        namespace text NOT NULL, workspace text NOT NULL, kind text NOT NULL CHECK(kind IN ('intent','term','source')),
        key text NOT NULL, ordinal integer NOT NULL, value jsonb NOT NULL,
        PRIMARY KEY(namespace,workspace,kind,key),
        FOREIGN KEY(namespace,workspace) REFERENCES opencrawl_intent_corpus(namespace,workspace) ON DELETE CASCADE
      )`);
    })).catch(e => {prepared = undefined; throw e;});
    return prepared;
  }
  function scope(principal: Principal) {
    sessionScope(principal);
    if (principal.captureAccess !== undefined) fail(403, 'Workspace read access required');
    return [db.namespace, principal.tenantId];
  }
  return {
    async publishInitial(principal: Principal, publication: Publication, draft: unknown, passages: readonly IntentPassage[]) {
      const key = scope(principal);
      const from = Date.parse(publication.from), until = Date.parse(publication.until);
      if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until ||
          !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(publication.runId)) fail(400, 'Invalid intent publication');
      if (passages.some(p => p.tenantId !== principal.tenantId)) fail(403, 'Passage belongs to another workspace');
      const corpus = groundIntentCorpus(draft, passages, origin);
      if (corpus.sources.some(s => Date.parse(s.timestamp) < from || Date.parse(s.timestamp) >= until)) fail(400, 'Source falls outside the extraction window');
      const readable = await sharedSources(principal.tenantId, corpus.sources);
      if (corpus.sources.some(s => !readable.has(s.id))) fail(403, 'Sources must be shared with the workspace');
      const digest = createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
      await ready();
      return db.transaction(async tx => {
        const inserted = await tx.query(`INSERT INTO opencrawl_intent_corpus(namespace,workspace,run_id,starts_at,ends_at,digest,conflicts)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (namespace,workspace) DO NOTHING RETURNING run_id`,
        [...key, publication.runId, publication.from, publication.until, digest, JSON.stringify(corpus.conflicts)]);
        if (!inserted.rowCount) {
          const row = (await tx.query('SELECT run_id,digest,starts_at,ends_at FROM opencrawl_intent_corpus WHERE namespace=$1 AND workspace=$2', key)).rows[0];
          if (row?.run_id === publication.runId && row.digest === digest && Number(row.starts_at) === from && Number(row.ends_at) === until) return;
          fail(409, 'Workspace already has an initial intent corpus');
        }
        const rows = [
          ...corpus.intents.map((value, ordinal) => ({kind: 'intent', key: value.id, ordinal, value})),
          ...corpus.terms.map((value, ordinal) => ({kind: 'term', key: value.name, ordinal, value})),
          ...corpus.sources.map((value, ordinal) => ({kind: 'source', key: value.id, ordinal, value})),
        ];
        await tx.query(`INSERT INTO opencrawl_intent_records(namespace,workspace,kind,key,ordinal,value)
          SELECT $1,$2,r.kind,r.key,r.ordinal,r.value FROM jsonb_to_recordset($3::jsonb)
          AS r(kind text,key text,ordinal integer,value jsonb)`, [...key, JSON.stringify(rows)]);
      });
    },
    async read(principal: Principal): Promise<IntentCorpus | null> {
      const key = scope(principal);
      await ready();
      const result = await db.pool.query<{conflicts: IntentCorpus['conflicts']; intents: IntentCorpus['intents']; terms: IntentCorpus['terms']; sources: IntentSource[]}>(`
        SELECT c.conflicts,
          COALESCE(jsonb_agg(r.value ORDER BY r.ordinal) FILTER(WHERE r.kind='intent'),'[]') AS intents,
          COALESCE(jsonb_agg(r.value ORDER BY r.ordinal) FILTER(WHERE r.kind='term'),'[]') AS terms,
          COALESCE(jsonb_agg(r.value ORDER BY r.ordinal) FILTER(WHERE r.kind='source'),'[]') AS sources
        FROM opencrawl_intent_corpus c LEFT JOIN opencrawl_intent_records r USING(namespace,workspace)
        WHERE c.namespace=$1 AND c.workspace=$2 GROUP BY c.namespace,c.workspace,c.conflicts`, key);
      const corpus = result.rows[0];
      if (!corpus) return null;
      return visibleIntentCorpus(corpus, await sharedSources(principal.tenantId, corpus.sources));
    },
  };
}
