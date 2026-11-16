import {createHash} from 'node:crypto';

/** Stable account-bound identity, preserved exactly across the SQL migration. */
export const boardIdentity = (userId: string, handle: string) => createHash('sha256').update(JSON.stringify([userId, handle])).digest('hex');
