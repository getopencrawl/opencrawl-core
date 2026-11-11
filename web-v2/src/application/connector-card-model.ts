import type {SourceCard} from './api.ts';

export type ConnectorMetric = NonNullable<SourceCard['rows']>[number];

/** Connector metadata selects the useful headline. Unknown connectors fall back to
 * their highest valid count; equal counts keep catalog order. Never sum unlike units. */
export function headlineMetric(rows: readonly ConnectorMetric[] = [], preferred?: string): ConnectorMetric | undefined {
  const valid = rows.filter(row => Number.isFinite(row.count) && row.count >= 0);
  const explicit = preferred ? valid.find(row => row.label === preferred) : undefined;
  return explicit ?? valid.reduce<ConnectorMetric | undefined>((best, row) => !best || row.count > best.count ? row : best, undefined);
}

export const sourceConnected = (source: SourceCard): boolean => !['disconnected','setup-required','unavailable'].includes(source.state);
export function alphabeticalSources(sources: readonly SourceCard[]): SourceCard[] {
  return [...sources].sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true}));
}
