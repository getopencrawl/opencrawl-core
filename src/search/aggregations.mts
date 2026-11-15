import {realmMapping} from './mapping.mjs';
import type {Mapping} from './types.mjs';

/** A metric (not a bucket) counting documents containing one exact keyword.
 * Keeps large bounded group reports below the engine's nested-bucket limit. */
export function termCount(input: unknown): {field: string; value: string} {
  const fail = () => Object.assign(new Error('Invalid term_count aggregation'), {status: 400});
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.field !== 'string' || typeof value.value !== 'string'
    || value.value.length > 4000 || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(value.field)) throw fail();
  let mapping: Mapping | undefined = realmMapping;
  for (const part of value.field.split('.')) mapping = mapping?.properties?.[part];
  if (mapping?.type !== 'keyword' || mapping.index === false || mapping.doc_values === false) throw fail();
  return {field: value.field, value: value.value};
}

/** Engine scripts stay in this adapter; callers supply only a keyword predicate. */
export function openSearchAggregations(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 12) throw Object.assign(new Error('Invalid aggregation'), {status: 400});
  return Object.fromEntries(Object.entries(input).map(([name, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('Invalid aggregation'), {status: 400});
    const spec = raw as Record<string, unknown>;
    if ('term_count' in spec) {
      if (Object.keys(spec).length !== 1) throw Object.assign(new Error('Invalid term_count aggregation'), {status: 400});
      const params = termCount(spec.term_count);
      return [name, {sum: {script: {lang: 'painless',
        source: 'if (doc.containsKey(params.field)) { for (def value : doc[params.field]) { if (value == params.value) return 1; } } return 0;', params}}}];
    }
    return [name, {...spec, ...(spec.aggs ? {aggs: openSearchAggregations(spec.aggs, depth + 1)} : {})}];
  }));
}
