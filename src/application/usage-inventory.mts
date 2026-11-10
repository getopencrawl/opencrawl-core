/** Exact indexed entity kinds, separate from provider ingestion stream counts. */
export interface IndexedSourceInventory {
  indexed: number | null;
  indexedSpecies?: Array<{name: string; count: number}>;
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * A terms aggregation can omit kinds. Keep the measured total, but publish a
 * breakdown only when its mutually exclusive kind buckets account for all of it.
 * null means unavailable; a measured zero has an explicit empty breakdown.
 */
export function indexedSourceInventory(value: unknown): IndexedSourceInventory {
  if (!object(value) || !count(value.total)) return {indexed: null};
  const indexed = value.total;
  if (!object(value.kinds)) return {indexed};
  const indexedSpecies: Array<{name: string; count: number}> = [];
  let sum = 0;
  for (const [name, amount] of Object.entries(value.kinds)) {
    if (!name || !count(amount)) return {indexed};
    sum += amount;
    if (!Number.isSafeInteger(sum)) return {indexed};
    if (amount > 0) indexedSpecies.push({name, count: amount});
  }
  if (sum !== indexed) return {indexed};
  indexedSpecies.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
  return {indexed, indexedSpecies};
}
