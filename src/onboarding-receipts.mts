export const onboardingKinds = ['cli', 'mcp', 'mcpTest', 'session', 'history', 'completed'] as const;
export type OnboardingKind = typeof onboardingKinds[number];
export interface OnboardingReceipt {observedAt: string; client?: string | null; harness?: string; state?: string}
export type ReceiptMap = Partial<Record<OnboardingKind, OnboardingReceipt>>;
export interface OnboardingRepository {
  read(scope: string, kinds: readonly OnboardingKind[]): Promise<ReceiptMap>;
  write(scope: string, kind: OnboardingKind, value: OnboardingReceipt): Promise<OnboardingReceipt>;
}

export function validateReceiptScope(scope: string) {
  if (!/^tenants\/[a-f0-9]{64}\/users\/[a-f0-9]{64}$/.test(scope)) throw Error('Invalid onboarding owner');
}

export function validateReceipt(input: unknown): OnboardingReceipt {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid onboarding receipt');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['observedAt','client','harness','state'].includes(key)) ||
      typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
      ('client' in value && value.client !== null && typeof value.client !== 'string') ||
      ('harness' in value && typeof value.harness !== 'string') || ('state' in value && typeof value.state !== 'string'))
    throw Error('Invalid onboarding receipt');
  return input as OnboardingReceipt;
}
