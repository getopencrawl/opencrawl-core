import {readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';

export const mainBranchRef = 'refs/heads/main';
export const amendmentsRefPrefix = 'refs/heads/intents/amendments/';
const amendmentIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isAllowedBranchRef(ref: string): boolean {
  if (ref === mainBranchRef) return true;
  if (!ref.startsWith(amendmentsRefPrefix)) return false;
  const id = ref.slice(amendmentsRefPrefix.length);
  return amendmentIdPattern.test(id) && !id.includes('..') && !id.endsWith('.lock');
}

export function amendmentIdFromRef(ref: string): string | null {
  if (!ref.startsWith(amendmentsRefPrefix) || !isAllowedBranchRef(ref)) return null;
  return ref.slice(amendmentsRefPrefix.length);
}

export function reflogPathForRef(dir: string, ref: string): string {
  if (!isAllowedBranchRef(ref)) throw new Error('Invalid shared Git branch ref: ' + ref);
  return join(dir, 'logs', ...ref.split('/'));
}

export async function collectAllowedReflogs(
  dir: string
): Promise<Array<{ref: string; path: string; size: number}>> {
  const mainPath = reflogPathForRef(dir, mainBranchRef);
  const results: Array<{ref: string; path: string; size: number}> = [
    {ref: mainBranchRef, path: mainPath, size: (await stat(mainPath)).size}
  ];
  const amendmentsDir = join(dir, 'logs', 'refs', 'heads', 'intents', 'amendments');
  let entries;
  try {
    entries = await readdir(amendmentsDir, {withFileTypes: true});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const ref = amendmentsRefPrefix + entry.name;
    if (!isAllowedBranchRef(ref)) continue;
    const path = join(amendmentsDir, entry.name);
    results.push({ref, path, size: (await stat(path)).size});
  }
  return results;
}
