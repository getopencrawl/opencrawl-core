import {z} from 'zod';

/** Reporting windows on Usage. Days are UTC calendar days ending today. */
export const usageRange = z.enum(['7d', '30d', 'all']);
export type UsageRange = z.infer<typeof usageRange>;
export const rangeInput = z.strictObject({range: usageRange});
export const rangeDays = (range: UsageRange) => range === '7d' ? 7 : range === '30d' ? 30 : null;

/** count is null on a day before measurement began: not tracked, which is not zero. */
export interface DailyCount {date: string; count: number | null}

/** Session tokens that count toward usage. source says whether they come from the usage meter or the index. */
export interface TokenUsage {source: 'meter' | 'index'; range: UsageRange; total: number; daily: DailyCount[]}
export interface TokenSession {userId: string; harness: string | null; sessionId: string | null; tokens: number; lastAt: string | null}
export const tokenSessionsRequest = z.strictObject({range: usageRange, offset: z.number().int().min(0).max(1000).optional()});
export type TokenSessionsRequest = z.infer<typeof tokenSessionsRequest>;
export interface TokenSessionPage {rows: TokenSession[]; next: number | null}
