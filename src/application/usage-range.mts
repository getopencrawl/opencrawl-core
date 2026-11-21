import {z} from 'zod';

/** Reporting windows on Usage. Days are UTC calendar days ending today. */
export const usageRange = z.enum(['7d', '30d', 'all']);
export type UsageRange = z.infer<typeof usageRange>;
export const rangeInput = z.strictObject({range: usageRange});
export const rangeDays = (range: UsageRange) => range === '7d' ? 7 : range === '30d' ? 30 : null;

/** count is null on a day before measurement began: not tracked, which is not zero. */
export interface DailyCount {date: string; count: number | null}

/**
 * Tokens that count toward usage. From a meter: stored tokens, total = stored now and daily = the level each day.
 * From the index: captured session tokens, total and daily summed by the day each event happened.
 */
export interface TokenUsage {source: 'meter' | 'index'; range: UsageRange; total: number; daily: DailyCount[];
  /** Tokens in the total that are memory files, not sessions, when the meter counts them. */
  memories?: number}
export interface TokenSession {userId: string; harness: string | null; sessionId: string | null; tokens: number; lastAt: string | null}
export const tokenSessionsRequest = z.strictObject({range: usageRange, offset: z.number().int().min(0).max(1000).optional()});
export type TokenSessionsRequest = z.infer<typeof tokenSessionsRequest>;
export interface TokenSessionPage {rows: TokenSession[]; next: number | null}
