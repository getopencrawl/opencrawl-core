import {createHash} from 'node:crypto';
import {Client, type Pool} from 'pg';

const channel = 'opencrawl_board_direct';
export const wakeKey = (namespace:string, tenant:string) =>
  createHash('sha256').update(JSON.stringify([namespace, tenant])).digest('hex');

export interface BoardWake {
  wait(ms:number): Promise<void>;
  close(): void;
}

// One LISTEN connection serves overlapping waits. The notification contains
// only a scope hash. The ordinary authorized query selects every actual message.
export function directPostListener(pool: Pool) {
  function connect() {
    const client = new Client(pool.options);
    const scopes = new Map<string, Set<() => void>>();
    function disconnected() {
      if (active?.client === client) active = undefined;
      for (const waiters of scopes.values()) for (const wake of waiters) wake();
    }
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', ({channel: name, payload}) => {
      if (name === channel && payload) for (const wake of scopes.get(payload) ?? []) wake();
    });
    const ready = client.connect().then(() => client.query('LISTEN opencrawl_board_direct'));
    return {client, scopes, ready};
  }
  let active: ReturnType<typeof connect> | undefined;
  return async function listen(key:string): Promise<BoardWake> {
    const connection = active ??= connect();
    const waiters = connection.scopes.get(key) ?? new Set<() => void>();
    connection.scopes.set(key, waiters);
    let signal = Promise.withResolvers<void>();
    const wake = () => signal.resolve();
    waiters.add(wake);
    function close() {
      if (!waiters.delete(wake)) return;
      wake();
      if (!waiters.size) connection.scopes.delete(key);
      if (!connection.scopes.size) {
        if (active === connection) active = undefined;
        void connection.client.end().catch(() => {});
      }
    }
    try { await connection.ready; }
    catch (error) { close(); throw error; }
    return {
      async wait(ms) {
        const timer = setTimeout(wake, ms);
        try { await signal.promise; } finally {
          clearTimeout(timer);
          signal = Promise.withResolvers<void>();
        }
      },
      close
    };
  };
}
