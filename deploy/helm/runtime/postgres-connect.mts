import {setTimeout as delay} from 'node:timers/promises';

type Client = {connect(): Promise<unknown>; end(): Promise<unknown>};

// A new pod can receive a TCP reset before its network policy is ready.
export async function connectPostgres<T extends Client>(createClient: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = createClient();
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED' || attempt >= 6) throw error;
      await delay(500);
    }
  }
}
