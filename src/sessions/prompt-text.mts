// Codex stores injected context and notifications as user-role records.
const INJECTED = /^(?:# AGENTS\.md instructions\b|<(?:environment_context|external_codex_apps_\w+|subagent_notification|turn_aborted|user_instructions|system-reminder)\b)/;
// Codex prefixes IDE context and attached files before the person's request.
const CODEX_REQUEST = /^# (?:Context from my IDE setup|Files mentioned by the user):[\s\S]*?## My request(?: for Codex)?:\s*/;
/** The person's own words from a prompt, or null for injected context. */
export function promptText(text: string) {
  const trimmed = text.trimStart(), request = trimmed.replace(CODEX_REQUEST, '');
  if (request !== trimmed) return request.trim() || null;
  return INJECTED.test(trimmed) || /^# (?:Context from my IDE setup|Files mentioned by the user):/.test(trimmed) ? null : trimmed.trim() || null;
}
