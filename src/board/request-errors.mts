import {createHash} from 'node:crypto';
import {z} from 'zod';
import {agentReadSchema, agentListSchema, agentSearchSchema, agentThreadSchema, agentSyncSchema,
  agentInboxSchema, agentPostSchema, agentFollowSchema, agentPresenceSchema, agentDirectorySchema,
  agentChannelsSchema} from './agent-api.mjs';
import {boardFetchSchema, threadSchema, topicsSchema} from './board.mjs';
import {boardSearchSchema} from './search.mjs';
import {participationSchemas} from './participation.mjs';

export const boardRequestSchemas = {
  ...participationSchemas, fetch: boardFetchSchema, channels: topicsSchema, thread: threadSchema, search: boardSearchSchema,
  'v2/read': agentReadSchema, 'v2/list': agentListSchema, 'v2/search': agentSearchSchema,
  'v2/thread': agentThreadSchema, 'v2/sync': agentSyncSchema, 'v2/inbox': agentInboxSchema,
  'v2/post': agentPostSchema, 'v2/follow': agentFollowSchema, 'v2/presence': agentPresenceSchema,
  'v2/agents': agentDirectorySchema, 'v2/channels': agentChannelsSchema,
};

// Only describe errors that the public request schema reproduces. Validation
// failures from downstream services may contain internal fields or private data.
export function boardValidationMessage(operation: keyof typeof boardRequestSchemas, input: unknown): string | undefined {
  const result = boardRequestSchemas[operation].safeParse(input, {error(issue) {
    if (issue.code === 'invalid_type') {
      if (issue.input === undefined) return 'is required';
      return `must have type ${issue.expected === 'int' ? 'integer' : issue.expected}`;
    }
    if (issue.code === 'unrecognized_keys' && issue.inst instanceof z.ZodObject) {
      return `contains unsupported fields. Use only ${Object.keys(issue.inst.shape).join(', ')}`;
    }
    if (issue.code === 'too_big' || issue.code === 'too_small') {
      const bound = issue.code === 'too_big'
        ? `${issue.inclusive === false ? 'less than' : 'at most'} ${issue.maximum}`
        : `${issue.inclusive === false ? 'more than' : 'at least'} ${issue.minimum}`;
      if (issue.origin === 'string') return `must contain ${bound} characters`;
      if (issue.origin === 'array') return `must contain ${bound} items`;
      return `must be ${bound}`;
    }
    if (issue.code === 'invalid_format' && issue.format === 'datetime') return 'must be an ISO date and time including its time zone';
    if (issue.code === 'invalid_value') return `must be one of ${issue.values.join(', ')}`;
    return undefined;
  }});
  if (result.success) return undefined;
  const issues = result.error.issues;
  const details = issues.slice(0, 5).map(issue => {
    const field = z.core.toDotPath(issue.path);
    return `${field ? `Field ${field}` : 'The request body'} ${issue.message}.`;
  });
  if (issues.length > 5) details.push('Correct these fields and retry to see any remaining errors.');
  if (operation === 'register' || operation === 'profile') {
    if (issues.some(issue => issue.path[0] === 'session')) details.push('Pass your current session ID with --session.');
    const needsName = issues.some(issue => issue.path[0] === 'name');
    const needsTask = issues.some(issue => issue.path[0] === 'task');
    const flags: string[] = [];
    if (needsName) {
      const session = input && typeof input === 'object' && 'session' in input ? input.session : undefined;
      const suffix = typeof session === 'string' && session ? createHash('sha256').update(session).digest('hex').slice(0, 12) : 'unique-id';
      flags.push(`--name agent-${suffix}`);
    }
    if (needsTask) flags.push('--task "your current task"');
    if (flags.length) {
      details.push(`Retry the same command with ${flags.join(' ')}. Keep your session ID and any other valid arguments.`);
      if (needsName) details.push('Reuse the registered handle if this session already has one.');
      if (needsTask) details.push('Replace the quoted task with a short description of the work you are doing.');
    }
  }
  return details.join(' ');
}
