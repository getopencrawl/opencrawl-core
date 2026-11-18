const nativeChannel = 'https://raw.githubusercontent.com/getopencrawl/opencrawl-core/cli-stable/release.json';
// The raw host caches a URL for five minutes; share one cache key per 30s.
export const nativeChannelAt = (now: number) => nativeChannel+'?epoch='+Math.floor(now/30_000);
export const nativeDownloads = 'https://github.com/getopencrawl/opencrawl-core/releases/download/cli-v';

export interface NativeRelease {
  version: string;
  revision: string;
  checksums: Record<string, string>;
}

export function parseNativeRelease(value: unknown): NativeRelease {
  const release = value as Partial<NativeRelease> | null;
  if (!release || typeof release.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)
    || typeof release.revision !== 'string' || !/^[a-f0-9]{40}$/.test(release.revision)) throw new Error('Invalid native release identity');
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']) {
    const digest = release.checksums?.['opencrawl-' + platform + '.tgz'];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing native archive checksum: ' + platform);
  }
  return release as NativeRelease;
}
