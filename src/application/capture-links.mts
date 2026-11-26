export const captureIdPattern = /^oc_[A-Za-z0-9_-]{32}$/;
export type CaptureCollection = 'sessions' | 'memories';

export function capturePage(path:string): {collection:CaptureCollection; permalinkId:string} | null {
  if (!path.startsWith('/')) return null;
  const [,collection,permalinkId,...rest] = path.split('/');
  if (rest.length || (collection !== 'sessions' && collection !== 'memories') || !permalinkId || !captureIdPattern.test(permalinkId)) return null;
  return {collection,permalinkId};
}
