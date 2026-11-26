export const usageTabs = ['overview', 'searches', 'proactive', 'team', 'activity', 'sources'] as const;
export type UsageTab = typeof usageTabs[number];

export function usagePath(tab: UsageTab) {
  return tab === 'overview' ? '/usage' : '/usage/' + tab;
}

export const usagePaths = usageTabs.map(usagePath);
