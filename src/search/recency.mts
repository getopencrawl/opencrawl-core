import type {Passage} from './types.mjs';
import {z} from 'zod';

// A bounded adjustment within each source's authorized lexical candidate window.
// Older evidence keeps its full lexical score; freshness only adds a small bonus.
export const RECENCY_WEIGHT = 0.2;
export const RECENCY_HALF_LIFE_DAYS = 7;
const DAY = 86_400_000;
const sourceDate = z.iso.datetime({offset: true});

export function originalTime(source: string, hit: Passage): number {
  const raw = source === 'memories' ? hit.modifiedAt : hit.timestamp;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  // Slack stores original message time as epoch seconds, including fractions.
  if (/^\d{10}(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  if (!sourceDate.safeParse(raw).success) return NaN;
  return Date.parse(raw);
}

export function recencyRank(source: string, hits: Passage[], now: number): Passage[] {
  return hits.map((hit, index) => {
    const score = typeof hit.score === 'number' && Number.isFinite(hit.score) && hit.score > 0 ? hit.score : 0;
    const at = originalTime(source, hit), age = now - at;
    // Missing, malformed and future dates are neutral. Never use capture,
    // indexing, snapshot generation or extraction time as a substitute.
    const bonus = Number.isFinite(age) && age >= 0 ? RECENCY_WEIGHT * 2 ** (-age / (RECENCY_HALF_LIFE_DAYS * DAY)) : 0;
    return {hit, index, score: score * (1 + bonus)};
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(({hit}) => hit);
}
