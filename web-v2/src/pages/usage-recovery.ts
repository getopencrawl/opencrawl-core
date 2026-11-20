import type {UsageReport} from './types.ts';
import type {UsageSection, UsageSource} from '../../../src/application/reports.mjs';

const dependencies: Record<UsageSection, readonly UsageSource[]> = {
  workspace: ['organization'], agents: ['sessions'], overlap: ['overlap'],
  // A connector count failure still returns the current source list and sync states.
  ingestion: ['integrations'], members: ['members', 'sessions', 'integrations', 'onboarding'],
  value: [], capture: ['capture'],
};

export function usageSectionFailed(report: Pick<UsageReport, 'failedSources'>, section: UsageSection) {
  return dependencies[section].some(source => report.failedSources?.includes(source));
}

/** Called only within the current authenticated query cache; never crosses scopes. */
type UsageMeasurements = Partial<UsageReport> & Pick<UsageReport, 'days' | 'generatedAt'>;
export function reconcileUsage<T extends UsageMeasurements>(previous: T | undefined, next: T): T {
  const staleSections: Partial<Record<UsageSection, string>> = {};
  const result = {...next, staleSections};
  if (!previous || previous.days !== next.days) return result;
  const cached = previous;
  function retain<K extends UsageSection>(section: K) {
    if (!usageSectionFailed(next, section) || cached[section] == null) return;
    if (usageSectionFailed(cached, section) && !cached.staleSections?.[section]) return;
    const measurements: UsageMeasurements = result;
    measurements[section] = cached[section];
    staleSections[section] = cached.staleSections?.[section] ?? cached.generatedAt;
  }
  for (const section of Object.keys(dependencies) as UsageSection[]) retain(section);
  return result;
}
