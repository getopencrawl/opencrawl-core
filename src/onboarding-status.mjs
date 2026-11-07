import {sessionScope} from './sessions/ingest.mjs';

/** Durable per-user setup milestones, not a claim that credentials remain valid forever. */
export function createOnboardingStatus({store, prefix = 'capture-v1', now = () => new Date()}) {
  if (!store?.put || !store?.get) throw new Error('Onboarding requires durable storage');
  const key = (principal, kind) => `${prefix}/${sessionScope(principal)}/onboarding/${kind}.json`;
  async function record(principal, kind, details = {}) {
    const value = {observedAt: now().toISOString(), ...details};
    await store.put(key(principal, kind), Buffer.from(JSON.stringify(value)), 'application/json');
    return value;
  }
  return {
    cli: principal => record(principal, 'cli'),
    async mcp(principal, clientInfo) {
      const previous = !clientInfo ? await store.get(key(principal, 'mcp')) : null;
      const client = clientInfo ? mcpClientName(clientInfo.name) : previous ? JSON.parse(previous.toString()).client : null;
      return record(principal, 'mcp', {client});
    },
    mcpTest: principal => record(principal, 'mcpTest'),
    session: (principal, batch) => {
      if (!['claude-code', 'codex'].includes(batch.harness)) throw new Error('Unknown session harness');
      if (!batch.events?.some(event => event.kind === 'message')) return;
      if (batch.captureMode === 'history') return record(principal, 'history', {state:'received', harness:batch.harness});
      return record(principal, 'session', {harness: batch.harness});
    },
    async complete(principal) {
      const status = await this.read(principal);
      if (!['cli','mcpTest','session'].every(kind => typeof status[kind]?.observedAt === 'string' && Number.isFinite(Date.parse(status[kind].observedAt)))) throw Object.assign(new Error('Complete agent setup first'), {status:409});
      return status.completed || record(principal, 'completed');
    },
    async read(principal) {
      sessionScope(principal);
      if (principal.captureAccess === 'write') throw Object.assign(new Error('Capture credentials cannot read onboarding status'), {status: 403});
      const values = await Promise.all(['cli','mcp','mcpTest','session','history','completed'].map(async kind => {
        const bytes = await store.get(key(principal, kind));
        return bytes ? JSON.parse(bytes.toString()) : null;
      }));
      return {cli: values[0], mcp: values[1], mcpTest: values[2], session: values[3], history: values[4], completed: values[5]};
    },
  };
}

// Self-reported display metadata. Unknown values never become arbitrary UI labels.
export function mcpClientName(name) {
  if (typeof name !== 'string' || name.length > 200) return null;
  const value = name.toLowerCase().replace(/[ _-]/g, '');
  if (['claude','claudeai','claudedesktop','claudecode'].includes(value)) return 'Claude';
  if (['chatgpt','openai','chatgptdeveloper'].includes(value)) return 'ChatGPT';
  if (['codex','codexcli','openaicodex'].includes(value)) return 'Codex';
  if (value === 'cursor') return 'Cursor';
  return null;
}
