import {hkdfSync} from 'node:crypto';
import {createSessionIngest, type SessionIngestOptions} from '../sessions/ingest.mjs';
import {createSessionLibrary, type SessionLibraryOptions} from '../sessions/library.mjs';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import {createRecordingPolicy} from '../state/recording.mjs';
import {createDevinRecording, type DevinRecordingJob} from './devin-recording.mjs';

/** The API and the worker must share the same credential envelope, storage
 * routing and deletion barrier for each installation. */
export function devinRecordingRuntime(options: {
  database: ApplicationDatabase; secret: string | Uint8Array; audience: string;
  sessions: SessionIngestOptions & SessionLibraryOptions;
  ingest?: ReturnType<typeof createSessionIngest>['putBatch'];
  schedule(job: DevinRecordingJob): Promise<unknown>;
}) {
  const {database, secret, audience, sessions, schedule} = options;
  if (secret.length < 32 || !sessions.scheduleIndexing || !sessions.scheduleDeletion)
    throw new Error('Devin recording requires encrypted storage, indexing and deletion.');
  const key = Buffer.from(hkdfSync('sha256',secret,database.namespace,'devin-api-recording-v1',32));
  const library = createSessionLibrary(sessions);
  return createDevinRecording({database, key, audience, schedule, recording:createRecordingPolicy(database),
    ingest:options.ingest ?? createSessionIngest(sessions).putBatch,
    incognito:(owner,sessionId) => library.requestDeletion(owner,{harness:'devin',sessionId},{beforeFirstCapture:true})});
}
