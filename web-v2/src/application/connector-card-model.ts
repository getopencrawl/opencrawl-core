import type {SourceCard} from './api.ts';

export const sourceConnected = (source: SourceCard): boolean => !['disconnected','setup-required','unavailable'].includes(source.state);
export function alphabeticalSources(sources: readonly SourceCard[]): SourceCard[] {
  return [...sources].sort((a,b)=>a.name.localeCompare(b.name,'en',{sensitivity:'base',numeric:true}));
}
