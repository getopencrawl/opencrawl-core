import type {ApplicationDatabase,createApplicationDatabase} from '../../src/state/postgres.mjs';

export const postgresUrl:string|undefined;
export function applicationDatabaseFixture(
  context:{after(cleanup:()=>Promise<void>):unknown},
  options?:Partial<Parameters<typeof createApplicationDatabase>[0]>,
):Promise<ApplicationDatabase>;
