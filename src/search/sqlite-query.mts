import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import type {IndexHit, Mapping, QueryBody, SearchDocument} from './types.mjs';
import {realmMapping} from './mapping.mjs';

export interface Sql {sql: string; args: SQLInputValue[]}
export const literal = (sql: string): Sql => ({sql, args: []});
export const join = (parts: Sql[], separator: string): Sql => ({sql: parts.map(p => p.sql).join(separator), args: parts.flatMap(p => p.args)});
export const and = (...parts: Sql[]): Sql => {const p = join(parts, ' AND '); return {...p, sql: '(' + p.sql + ')'};};
export const unsupported = (detail: string): never => {throw Object.assign(new Error('Unsupported SQLite search operation: ' + detail), {status: 400});};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported('expected object');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(key);
}
export function integer(value: unknown, fallback: number, max = 10000): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return unsupported('invalid size');
  return value;
}
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const param = (value: unknown): SQLInputValue => {
  if (typeof value === 'boolean') return Number(value);
  if (value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  return unsupported('invalid scalar');
};
export function field(name: unknown): {sql: string; path: string; date: boolean} {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) return unsupported('invalid field');
  let mapping: Mapping = realmMapping;
  for (const part of name.split('.')) {
    const next = mapping.properties?.[part];
    if (!next || next.index === false || next.enabled === false) return unsupported('unindexed field ' + name);
    mapping = next;
  }
  if (!mapping.type || mapping.type === 'object') return unsupported('non-scalar field ' + name);
  const path = '$.' + name;
  const sql = `json_extract(d.document, '${path}')`;
  return {sql: mapping.type === 'date' ? `epoch(${sql})` : sql, path, date: mapping.type === 'date'};
}
function dateParam(value: unknown): SQLInputValue {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return unsupported('invalid date');
  return Date.parse(value);
}

/** `tables` holds one scored FTS pass per scoring text clause; `sql` sums, for
 * the document row `d`, the passes that matched it. SQLite's automatic index
 * over each pass serves these row lookups. */
export interface Score {tables: Sql; sql: string}

/** Deliberately bounded query vocabulary, compatible with the existing realm
 * callers. Values are bound parameters; arbitrary SQL/FTS syntax is never input. */
export class QueryCompiler {
  scores: Sql[] = [];
  nodes = 0;
  constructor(readonly fts: string) {}
  query(value: unknown, scoring = true, depth = 0): Sql {
    if (++this.nodes > 10000 || depth > 32) return unsupported('query complexity');
    const q = object(value), names = Object.keys(q);
    if (names.length !== 1) return unsupported('query must have one operator');
    const name = names[0], input = q[name];
    if (name === 'match_all' || name === 'match_none') {keys(object(input), []); return literal(name === 'match_all' ? '1' : '0');}
    if (name === 'bool') {
      const b = object(input); keys(b, ['filter', 'must', 'must_not', 'should', 'minimum_should_match']);
      const parts = [
        ...list(b.filter).map(v => this.query(v, false, depth + 1)),
        ...list(b.must).map(v => this.query(v, scoring, depth + 1)),
        ...list(b.must_not).map(v => {const p = this.query(v, false, depth + 1); return {...p, sql: 'NOT (' + p.sql + ')'};}),
      ];
      const should = list(b.should).map(v => this.query(v, scoring, depth + 1));
      const minimum = integer(b.minimum_should_match, list(b.must).length || list(b.filter).length ? 0 : should.length ? 1 : 0, should.length);
      if (minimum) {const p = join(should.map(v => ({...v, sql: '(CASE WHEN ' + v.sql + ' THEN 1 ELSE 0 END)'})), ' + '); parts.push({...p, sql: '(' + p.sql + ') >= ' + minimum});}
      return parts.length ? and(...parts) : literal('1');
    }
    if (name === 'exists') {
      const v = object(input); keys(v, ['field']); const f = field(v.field);
      return literal(`EXISTS (SELECT 1 FROM json_each(d.document, '${f.path}') j WHERE j.value IS NOT NULL)`);
    }
    if (['term', 'terms', 'range', 'wildcard'].includes(name)) {
      const v = object(input); if (Object.keys(v).length !== 1) return unsupported('field query');
      const [key, val] = Object.entries(v)[0], f = field(key);
      const scalar = f.date ? 'epoch(j.value)' : 'j.value';
      const wrap = (p: Sql): Sql => ({...p, sql: `EXISTS (SELECT 1 FROM json_each(d.document, '${f.path}') j WHERE ${p.sql})`});
      if (name === 'range') {
        const bounds = object(val); keys(bounds, ['gt', 'gte', 'lt', 'lte']);
        const ops: Record<string, string> = {gt: '>', gte: '>=', lt: '<', lte: '<='};
        const parts = Object.entries(bounds).map(([op, value]) => ({sql: scalar + ' ' + ops[op] + ' ?', args: [f.date ? dateParam(value) : param(value)]}));
        if (!parts.length) return unsupported('empty range');
        return wrap(and(...parts));
      }
      if (name === 'wildcard') {
        if (typeof val !== 'string') return unsupported('wildcard');
        // GLOB is case-sensitive, as are the current keyword wildcard queries.
        return wrap({sql: "j.value GLOB ?", args: [val.replaceAll('[', '[[]')]});
      }
      const values = name === 'terms' ? val : [val];
      if (!Array.isArray(values) || values.length > 10000) return unsupported('terms');
      if (!values.length) return literal('0');
      return wrap({sql: scalar + ' IN (' + values.map(() => '?').join(',') + ')', args: values.map(f.date ? dateParam : param)});
    }
    if (name === 'multi_match' || name === 'match' || name === 'match_phrase') {
      let v: Record<string, unknown>, fields: string[];
      if (name === 'multi_match') {
        v = object(input); keys(v, ['query', 'fields', 'type', 'operator', 'boost']);
        if (!Array.isArray(v.fields) || !v.fields.every(f => typeof f === 'string')) return unsupported('text fields');
        fields = v.fields;
      } else {
        const entry = object(input); if (Object.keys(entry).length !== 1) return unsupported('match field');
        const [key, val] = Object.entries(entry)[0]; fields = [key]; v = typeof val === 'string' ? {query: val} : object(val);
        keys(v, ['query', 'operator', 'boost']);
      }
      if (typeof v.query !== 'string' || v.query.length > 4000 || v.operator !== undefined && !['and', 'or'].includes(String(v.operator))) return unsupported('text query');
      if (v.type !== undefined && !['cross_fields', 'phrase', 'best_fields'].includes(String(v.type))) return unsupported('text query type');
      const columns = fields.map(f => {
        const column = f === 'title' || f === 'title^2' ? 'title' : f === 'text' ? 'text' : f === 'board.topic.text^2' || f === 'board.topic.text' ? 'topic' : null;
        if (!column) return unsupported('text field ' + f); return column;
      });
      const tokens = v.query.match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu) ?? [];
      if (!tokens.length) return literal('0');
      const phrase = name === 'match_phrase' || v.type === 'phrase';
      const text = phrase ? '"' + tokens.join(' ') + '"' : tokens.map(t => '"' + t + '"').join(v.operator === 'and' ? ' AND ' : ' OR ');
      const expression = '{' + columns.join(' ') + '} : (' + text + ')';
      if (scoring) {
        const boost = v.boost ?? 1;
        if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0) return unsupported('boost');
        // MATERIALIZED is required. Otherwise SQLite pushes each candidate rowid
        // into this subquery and repeats the whole MATCH, with its statistics, per row.
        this.scores.push({sql: `c${this.scores.length} AS MATERIALIZED (SELECT rowid AS r, -bm25(${this.fts}, 2.0, 1.0, 2.0) * ${boost} AS s FROM ${this.fts} WHERE ${this.fts} MATCH ?)`, args: [expression]});
      }
      return {sql: `d.rowid IN (SELECT rowid FROM ${this.fts} WHERE ${this.fts} MATCH ?)`, args: [expression]};
    }
    return unsupported('query ' + name);
  }
  /** A clause adds its weighted BM25 to the rows it matches and nothing to the rest. */
  score(): Score {
    return {tables: join(this.scores, ', '), sql: this.scores.map((_, i) => `COALESCE((SELECT s FROM c${i} WHERE c${i}.r = d.rowid), 0)`).join(' + ') || '0'};
  }
}

interface Sort {expression: string; descending: boolean; first: boolean}
export function sorts(input: unknown): Sort[] {
  return list(input ?? ['_score', {id: 'asc'}]).map(value => {
    const entry = typeof value === 'string' ? {[value]: value === '_score' ? 'desc' : 'asc'} : object(value);
    if (Object.keys(entry).length !== 1) return unsupported('sort');
    const [name, option] = Object.entries(entry)[0], options = typeof option === 'string' ? {order: option} : object(option);
    keys(options, ['order', 'missing']);
    const direction = options.order ?? (name === '_score' ? 'desc' : 'asc');
    if (!['asc', 'desc'].includes(String(direction)) || options.missing !== undefined && !['_last', '_first'].includes(String(options.missing))) return unsupported('sort options');
    return {expression: name === '_score' ? 'score' : field(name).sql, descending: direction === 'desc', first: options.missing === '_first'};
  });
}

export const count = (db: DatabaseSync, where: Sql): number => Number(db.prepare('SELECT count(*) AS n FROM documents d WHERE ' + where.sql).get(...where.args)!.n);

/** One page and the exact number of matching documents. Ranking reads only row
 * IDs, scores and sort keys; stored documents are loaded for the returned rows. */
export function readHits(db: DatabaseSync, where: Sql, score: Score, body: QueryBody): {hits: IndexHit[]; total: number} {
  const order = sorts(body.sort), size = integer(body.size, 10), after = body.search_after;
  if (!order.length) unsupported('empty sort');
  const offset = integer(body.from, 0);
  const names = order.map((s, i) => s.expression === 'score' ? 'score' : 's' + i);
  let continuation = literal('1');
  if (after !== undefined) {
    if (!Array.isArray(after) || after.length !== order.length) return unsupported('search_after');
    const choices: Sql[] = [];
    for (let i = 0; i < order.length; i++) {
      const s = order[i], value = param(after[i]);
      const equal = order.slice(0, i).map((_, j) => ({sql: `${names[j]} IS ?`, args: [param(after[j])]}));
      const comparison = value === null ? literal(s.first ? `${names[i]} IS NOT NULL` : '0') : {sql: `(${names[i]} ${s.descending ? '<' : '>'} ?${s.first ? '' : ` OR ${names[i]} IS NULL`})`, args: [value]};
      choices.push(and(...equal, comparison));
    }
    continuation = join(choices, ' OR ');
  }
  if (!size) return {hits: [], total: count(db, where)};
  const ordering = order.map((s, i) => `${names[i]} ${s.descending ? 'DESC' : 'ASC'} NULLS ${s.first ? 'FIRST' : 'LAST'}`).join(',') + ',r';
  const columns = ['d.rowid AS r', score.sql + ' AS score', ...order.flatMap((s, i) => names[i] === 'score' ? [] : [s.expression + ' AS s' + i])].join(',');
  const tables = [...(score.tables.sql ? [score.tables.sql] : []), `matched AS MATERIALIZED (SELECT ${columns} FROM documents d WHERE ${where.sql})`].join(', ');
  // The count is the outer row, so the total arrives even when the page is empty.
  const rows = db.prepare(`WITH ${tables} SELECT t.total, p.* FROM (SELECT count(*) AS total FROM matched) t LEFT JOIN (SELECT * FROM matched WHERE ${continuation.sql} ORDER BY ${ordering} LIMIT ? OFFSET ?) p ON 1 ORDER BY ${ordering}`)
    .all(...score.tables.args, ...where.args, ...continuation.args, size, offset);
  const load = db.prepare('SELECT corpus, id, document FROM documents WHERE rowid=?');
  const hits = rows.filter(row => row.r !== null).map(row => {
    const stored = load.get(row.r)!;
    return {_id: String(stored.corpus) + ':' + String(stored.id), _source: JSON.parse(String(stored.document)) as SearchDocument, _score: Number(row.score), sort: names.map(name => row[name] as string | number | null)};
  });
  return {hits, total: Number(rows[0].total)};
}
