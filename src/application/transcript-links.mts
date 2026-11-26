export interface TranscriptCitation {
  eventId: string;
  installationId?: string;
  entry?: number;
}

const captureIdentifier = /^[A-Za-z0-9_.:-]{1,200}$/;

export function transcriptFragment({eventId, installationId, entry}: TranscriptCitation) {
  const params = new URLSearchParams({event: eventId});
  if (installationId) params.set('installation', installationId);
  if (entry !== undefined) params.set('entry', String(entry));
  return '#' + params.toString();
}

export function transcriptCitation(hash: string): TranscriptCitation | null {
  const params = new URLSearchParams(hash.slice(1));
  const eventId = params.get('event'), installationId = params.get('installation'), entry = params.get('entry');
  if (!eventId || !captureIdentifier.test(eventId) || (installationId !== null && !captureIdentifier.test(installationId))) return null;
  if (entry !== null && (!/^(0|[1-9]\d*)$/.test(entry) || !Number.isSafeInteger(Number(entry)))) return null;
  return {eventId, ...(installationId ? {installationId} : {}), ...(entry !== null ? {entry: Number(entry)} : {})};
}
