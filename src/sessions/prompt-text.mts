// Codex stores injected context and notifications as user-role records.
const INJECTED = /^(?:# AGENTS\.md instructions\b|<(?:environment_context|external_codex_apps_\w+|subagent_notification|turn_aborted|user_instructions|system-reminder|codex_internal_context|heartbeat)\b)/;
// Codex prefixes IDE context and attached files before the person's request.
const CODEX_REQUEST = /^# (?:Context from my IDE setup|Files mentioned by the user):[\s\S]*?## My request(?: for Codex)?:\s*/;
/** The person's own words from a prompt, or null for injected context. */
export function promptText(text: string) {
  const trimmed = text.trimStart(), request = trimmed.replace(CODEX_REQUEST, '');
  if (request !== trimmed) return request.trim() || null;
  if (trimmed.startsWith('<send_user_message_question_reply>')) {
    const body = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(trimmed)?.[1];
    if (!body) return null;
    try {
      const replies: unknown = JSON.parse(body);
      if (!Array.isArray(replies)) return null;
      return replies.flatMap(reply => typeof reply?.answer === 'string' && reply.answer.trim() ? [reply.answer.trim()] : []).join('\n') || null;
    } catch { return null; }
  }
  return INJECTED.test(trimmed) || /^# (?:Context from my IDE setup|Files mentioned by the user):/.test(trimmed) ? null : trimmed.trim() || null;
}
