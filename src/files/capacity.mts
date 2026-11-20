import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstat, mkdir, opendir, readdir, rename, rm, statfs, unlink} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {failure} from './git.mjs';

const MiB = 1024 * 1024;
export const defaultPushBytes = 64 * MiB;
export const defaultRepositoryBytes = 1024 * MiB;
export const defaultMinFreeBytes = 256 * MiB;
// Ref lock, reflog append, indexes' fixed headers and directory allocation.
const metadataReserve = 128 * 1024;
const quarantine = /^(?:tmp_objdir-)?incoming-[a-zA-Z0-9]+$/;

export interface Budget {
  pushBytes: number;
  repositoryBytes: number;
  minFreeBytes: number;
}

export function capacityLimits(env: NodeJS.ProcessEnv): Budget {
  const read = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive integer for ' + key);
    return value;
  };
  return {
    pushBytes: read('OPENCRAWL_FILES_MAX_PUSH_BYTES', defaultPushBytes),
    repositoryBytes: read('OPENCRAWL_FILES_MAX_REPOSITORY_BYTES', defaultRepositoryBytes),
    minFreeBytes: read('OPENCRAWL_FILES_MIN_FREE_BYTES', defaultMinFreeBytes)
  };
}

// BEGIN IMMEDIATE uses OS byte-range locks. These files stay empty: no SQLite
// tables, journals, durable leases, clocks, PIDs or stale lock-file deletion.
function tryLock(path: string) {
  const db = new DatabaseSync(path, {timeout: 0});
  try {
    db.exec('BEGIN IMMEDIATE');
    return db;
  } catch (e) {
    db.close();
    if ((e as {errcode?: number}).errcode === 5) return null;
    throw e;
  }
}

async function acquire(path: string) {
  for (let retry = 0; retry < 100; retry++) {
    const lock = tryLock(path);
    if (lock) return lock;
    await delay(10 + Math.random() * 10);
  }
  throw failure(429, 'Git storage admission is busy; retry shortly');
}

async function diskUse(path: string): Promise<number> {
  const entry = await lstat(path);
  // Charge both sparse apparent length and actual blocks. Include directory
  // records and a minimum inode charge, even on filesystems without st_blocks.
  let bytes = Math.max(entry.size, (entry.blocks || 0) * 512, 512);
  if (!entry.isDirectory()) return bytes;
  const dir = await opendir(path);
  for await (const child of dir) bytes += await diskUse(join(path, child.name));
  return bytes;
}

async function freeBytes(path: string) {
  const fs = await statfs(path, {bigint: true});
  return Number(fs.bsize * fs.bavail);
}
async function incoming(dir: string) {
  const objects = join(dir, 'objects');
  return (await readdir(objects)).filter((name) => quarantine.test(name)).map((name) => join(objects, name));
}

async function reserve(root: string, availableForRepo: number, limits: Budget, readFree = freeBytes) {
  const area = join(root, '.receive-capacity');
  await mkdir(area, {recursive: true, mode: 0o700});
  const gate = await acquire(join(area, 'admission.lock'));
  try {
    let outstanding = 0;
    for (const name of await readdir(area)) {
      const record = /^(\d+)-[a-f0-9-]{36}\.reserve$/.exec(name);
      if (!record) continue;
      const file = join(area, name);
      const idle = tryLock(file);
      if (idle) {
        idle.close();
        await unlink(file);
      } else outstanding += Number(record[1]);
    }
    const room = Math.min(availableForRepo, (await readFree(root)) - limits.minFreeBytes - outstanding);
    // Keep packs packed. Besides the wire pack, Git can append existing thin
    // delta bases, write the index and reverse index, and round to disk blocks.
    const budget = Math.min(room, 8 * (limits.pushBytes + metadataReserve) + metadataReserve);
    const maxPack = Math.min(limits.pushBytes, Math.floor((budget - metadataReserve) / 8) - metadataReserve);
    if (maxPack < 1) throw failure(507, 'Shared Git storage has insufficient space for this push');
    const bytes = 8 * (maxPack + metadataReserve) + metadataReserve;
    const reservation = tryLock(join(area, bytes + '-' + randomUUID() + '.reserve'));
    if (!reservation) throw failure(503, 'Unable to reserve Git storage');
    return {reservation, maxPack, bytes};
  } finally {
    gate.close();
  }
}

export async function admitPush(root: string, dir: string, limits: Budget, readFree = freeBytes) {
  // A single receive per repo across processes also lets us recover Git's
  // abandoned quarantine on retry without touching a live peer's work.
  const writer = tryLock(join(dir, 'opencrawl-receive.lock'));
  if (!writer) throw failure(429, 'Another agent is pushing to this network; retry shortly');
  let reservation: DatabaseSync | undefined;
  try {
    for (const path of await incoming(dir)) await rm(path, {recursive: true, force: true});
    const baseBytes = await diskUse(dir);
    if (baseBytes + metadataReserve >= limits.repositoryBytes)
      throw failure(507, 'This network has reached its shared Git storage quota');
    const allocated = await reserve(root, limits.repositoryBytes - baseBytes, limits, readFree);
    reservation = allocated.reservation;
    // RLIMIT_FSIZE also applies to the existing append-only reflog. Refuse
    // before Git starts if even its smallest platform limit cannot fit one
    // more authenticated entry and the explicit Git identity.
    const reflog = await lstat(join(dir, 'logs', 'refs', 'heads', 'main'));
    if (reflog.size + 32768 > allocated.maxPack + metadataReserve)
      throw failure(507, 'The shared Git storage budget cannot fit the next reflog entry');
    const check = async () => {
      let staging = 0;
      for (const path of await incoming(dir)) {
        try {
          staging += await diskUse(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (
        staging + metadataReserve > allocated.bytes ||
        staging + baseBytes + metadataReserve > limits.repositoryBytes
      )
        throw failure(507, 'This push exceeds the network shared Git storage quota');
      if ((await readFree(root)) < limits.minFreeBytes + metadataReserve)
        throw failure(507, 'The shared Git volume has reached its free-space reserve');
    };
    return {
      maxPack: allocated.maxPack,
      check,
      async release() {
        try {
          for (const path of await incoming(dir)) await rm(path, {recursive: true, force: true});
        } finally {
          reservation!.close();
          writer.close();
        }
      }
    };
  } catch (error) {
    reservation?.close();
    writer.close();
    throw error;
  }
}

// Seed creation and legacy import share the same volume ledger as pushes.
// Each workspace has a single fixed staging location recoverable after exit.
export async function stageRepository(
  root: string,
  dir: string,
  sourceBytes: number,
  limits: Budget,
  populate: (stage: string, nativeLimit: number) => Promise<void>
) {
  const requested = Math.max(1, sourceBytes);
  const allocation = await reserve(root, limits.repositoryBytes, {...limits, pushBytes: requested});
  try {
    if (allocation.maxPack < requested)
      throw failure(507, 'Shared Git storage has insufficient space to provision this workspace');
    const parent = dirname(dir);
    await mkdir(parent, {recursive: true, mode: 0o700});
    const stage = join(parent, '.init-' + basename(dir));
    const lock = await acquire(stage + '.lock');
    try {
      // Another process may have completed the same atomic initialization.
      try {
        await lstat(dir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rm(stage, {recursive: true, force: true});
      await mkdir(stage, {mode: 0o700});
      try {
        await populate(stage, allocation.maxPack);
        if (
          (await diskUse(stage)) + metadataReserve > Math.min(allocation.bytes, limits.repositoryBytes) ||
          (await freeBytes(root)) < limits.minFreeBytes + metadataReserve
        )
          throw failure(507, 'Shared Git storage has insufficient space to provision this workspace');
        await rename(stage, dir);
      } finally {
        await rm(stage, {recursive: true, force: true});
      }
    } finally {
      lock.close();
    }
  } finally {
    allocation.reservation.close();
  }
}
