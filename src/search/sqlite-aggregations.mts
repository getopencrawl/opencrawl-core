import type {DatabaseSync} from 'node:sqlite';
import {and, count, field, integer, keys, literal, object, QueryCompiler, readHits, unsupported} from './sqlite-query.mjs';
import type {Score, Sql} from './sqlite-query.mjs';

/** Aggregations used by the product's board, library and usage views. SQL does
 * the filtering/grouping; no whole-corpus materialization in application memory. */
export function aggregate(db: DatabaseSync, fts: string, where: Sql, score: Score, input: unknown, budget = {buckets: 10000}, depth = 0): Record<string, unknown> {
  if (depth > 12) return unsupported('aggregation depth');
  const result: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(object(input))) {
    const spec = object(raw), types = Object.keys(spec).filter(k => k !== 'aggs');
    if (types.length !== 1) return unsupported('aggregation');
    const type = types[0], option = spec[type];
    const children = (filter: Sql) => spec.aggs ? aggregate(db, fts, filter, score, spec.aggs, budget, depth + 1) : {};
    if (type === 'filter') {
      const filter = and(where, new QueryCompiler(fts).query(option, false));
      result[name] = {doc_count: count(db, filter), ...children(filter)};
    } else if (type === 'top_hits') {
      const opts = object(option); keys(opts, ['size', 'sort', '_source']);
      const page = readHits(db, where, score, opts);
      result[name] = {hits: {hits: page.hits, total: {value: page.total, relation: 'eq'}}};
    } else if (['min', 'max', 'cardinality', 'value_count'].includes(type)) {
      const opts = object(option); keys(opts, ['field', 'precision_threshold']); const f = field(opts.field);
      const value = f.date ? 'epoch(j.value)' : 'j.value';
      const expression = type === 'cardinality' ? 'count(DISTINCT ' + value + ')' : type === 'value_count' ? 'count(' + value + ')' : type + '(' + value + ')';
      const row = db.prepare(`SELECT ${expression} AS value FROM documents d, json_each(d.document, '${f.path}') j WHERE ${where.sql}`).get(...where.args)!;
      result[name] = {value: row.value, ...(f.date && row.value !== null ? {value_as_string: new Date(Number(row.value)).toISOString()} : {})};
    } else if (type === 'terms' || type === 'multi_terms') {
      const opts = object(option); keys(opts, ['field', 'terms', 'size', 'order', 'shard_size', 'show_term_doc_count_error', 'min_doc_count', 'exclude']);
      if (opts.min_doc_count !== undefined && opts.min_doc_count !== 1) unsupported('terms min_doc_count');
      const excluded = opts.exclude === undefined ? [] : opts.exclude === '' ? [''] : Array.isArray(opts.exclude) && opts.exclude.every(v => typeof v === 'string') ? opts.exclude : unsupported('terms exclude (only exact values supported)');
      const names = type === 'terms' ? [opts.field] : Array.isArray(opts.terms) ? opts.terms.map(x => {const t = object(x); keys(t, ['field']); return t.field;}) : unsupported('multi_terms');
      if (!names.length || names.length > 8) return unsupported('aggregation fields');
      const fields = names.map(field), size = integer(opts.size, 10), joins = fields.map((f, i) => `json_each(d.document, '${f.path}') j${i}`).join(',');
      const keyColumns = fields.map((_, i) => `j${i}.value AS k${i}`), group = fields.map((_, i) => `k${i}`).join(',');
      const childSpecs = spec.aggs ? object(spec.aggs) : {};
      const orderInput = opts.order ?? [{_count: 'desc'}, {_key: 'asc'}], orders = Array.isArray(orderInput) ? orderInput : [orderInput];
      const ordering: string[] = [];
      for (const rawOrder of orders) {
        const order = object(rawOrder);
        for (const [metric, direction] of Object.entries(order)) {
          if (direction !== 'asc' && direction !== 'desc') return unsupported('bucket order');
          if (metric === '_count') ordering.push('n ' + direction);
          else if (metric === '_key') ordering.push(...fields.map((_, i) => 'k' + i + ' ' + direction));
          else {
            const sub = object(childSpecs[metric]), metricType = Object.keys(sub)[0];
            if (!['max', 'min'].includes(metricType) || Object.keys(sub).length !== 1) return unsupported('bucket metric order');
            const f = field(object(sub[metricType]).field);
            ordering.push(metricType + '(' + f.sql + ') ' + direction);
          }
        }
      }
      ordering.push(...fields.map((_, i) => 'k' + i + ' ASC'));
      const present = fields.map((_, i) => `j${i}.value IS NOT NULL`).join(' AND ');
      if (type === 'multi_terms' && excluded.length) unsupported('multi_terms exclude');
      const exclusion = excluded.length ? ' AND j0.value NOT IN (' + excluded.map(() => '?').join(',') + ')' : '';
      const args = [...where.args, ...excluded];
      const sql = `SELECT ${keyColumns.join(',')}, count(DISTINCT d.rowid) AS n FROM documents d, ${joins} WHERE ${where.sql} AND ${present}${exclusion} GROUP BY ${group}`;
      const total = Number(db.prepare(`SELECT coalesce(sum(n),0) AS n FROM (${sql})`).get(...args)!.n);
      const rows = db.prepare(sql + ' ORDER BY ' + ordering.join(',') + ' LIMIT ?').all(...args, size);
      if ((budget.buckets -= rows.length) < 0) return unsupported('too many aggregation buckets');
      const buckets = rows.map(row => {
        const values = fields.map((_, i) => row['k' + i]);
        const filter = and(where, new QueryCompiler(fts).query({bool: {filter: names.map((f, i) => ({term: {[String(f)]: values[i]}}))}}, false));
        return {key: type === 'terms' ? values[0] : values, doc_count: Number(row.n), doc_count_error_upper_bound: 0, ...children(filter)};
      });
      result[name] = {buckets, doc_count_error_upper_bound: 0, sum_other_doc_count: total - rows.reduce((n, row) => n + Number(row.n), 0)};
    } else if (type === 'date_histogram') {
      const opts = object(option); keys(opts, ['field', 'calendar_interval', 'format', 'min_doc_count', 'extended_bounds']);
      if (opts.calendar_interval !== 'day' || opts.format !== undefined && opts.format !== 'yyyy-MM-dd' || opts.min_doc_count !== undefined && opts.min_doc_count !== 0) return unsupported('date histogram options');
      const f = field(opts.field); if (!f.date) return unsupported('date histogram field');
      const day = `CAST(${f.sql} / 86400000 AS INTEGER) * 86400000`;
      const rows = db.prepare(`SELECT ${day} AS day, count(*) AS n FROM documents d WHERE ${where.sql} AND ${f.sql} IS NOT NULL GROUP BY day ORDER BY day`).all(...where.args);
      const counts = new Map(rows.map(row => [Number(row.day), Number(row.n)]));
      const bounds = opts.extended_bounds === undefined ? {} : object(opts.extended_bounds); keys(bounds, ['min', 'max']);
      const timestamp = (v: unknown) => {const n = typeof v === 'number' ? v : Date.parse(String(v)); if (!Number.isFinite(n)) return unsupported('histogram bounds'); return Math.floor(n / 86400000) * 86400000;};
      const first = Math.min(...(rows.length ? [Number(rows[0].day)] : []), ...(bounds.min === undefined ? [] : [timestamp(bounds.min)]));
      const last = Math.max(...(rows.length ? [Number(rows.at(-1)!.day)] : []), ...(bounds.max === undefined ? [] : [timestamp(bounds.max)]));
      const buckets = [];
      if (Number.isFinite(first) && Number.isFinite(last)) for (let day = first; day <= last; day += 86400000) {
        if (--budget.buckets < 0) return unsupported('too many histogram buckets');
        const filter = and(where, {sql: `${f.sql} >= ? AND ${f.sql} < ?`, args: [day, day + 86400000]});
        buckets.push({key: day, key_as_string: new Date(day).toISOString().slice(0, 10), doc_count: counts.get(day) ?? 0, ...children(filter)});
      }
      result[name] = {buckets};
    } else return unsupported('aggregation ' + type);
  }
  return result;
}
