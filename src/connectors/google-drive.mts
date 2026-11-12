import type {AirbyteEnvelope, ConnectorBinding} from './types.mjs';
import type {DriveDocumentRecord} from '../integrations/google-drive-source.mjs';
import {DRIVE_POLICY, driveId} from '../integrations/google-drive-access.mjs';
import {digest, invalidRecord} from './scope.mjs';
import {resource, text, time} from './documents.mjs';

/** Legacy Drive rows have no workspace-wide permission proof and are never admitted. */
export function normalizeGoogleDrive(binding: ConnectorBinding, stream: string, envelope: AirbyteEnvelope<DriveDocumentRecord>, key: string) {
  if (binding.provider !== 'googledrive' || stream !== 'workspace_documents') invalidRecord('Unsupported Drive source stream');
  const data = envelope._airbyte_data, access = data?.access;
  driveId(data?.id);
  if (!access || access.policy !== DRIVE_POLICY || access.tenantId !== binding.tenantId || access.connectionId !== binding.connectionId || access.fileId !== data.id ||
    !Number.isSafeInteger(access.checkedAt) || access.checkedAt < 0 || access.checkedAt > envelope._airbyte_extracted_at + 60000 ||
    !/^[a-f0-9]{64}$/.test(access.audienceHash) || !/^[a-f0-9]{64}$/.test(access.permissionHash) || access.contentHash !== digest(data.text) ||
    !/^\d+$/.test(data.version) || typeof data.mimeType !== 'string' || !['extracted', 'empty', 'unsupported'].includes(data.extractionStatus)) invalidRecord('Missing or invalid Drive workspace permission receipt');
  const body = text(data.text), available = data.extractionStatus === 'extracted' || data.extractionStatus === 'empty';
  if (data.extractionStatus === 'unsupported' && body !== '') invalidRecord('Unsupported Drive body must not be indexed');
  return resource(binding, {kind: 'file', sourceId: data.id, title: available ? text(data.name) : '', body: available ? body : '', extractedAt: access.checkedAt, sourceKey: key,
    metadata: {fileId: data.id, available, extractionStatus: data.extractionStatus, versionAt: time(data.modifiedTime, access.checkedAt), normalizerVersion: 1,
      url: `https://drive.google.com/file/d/${data.id}/view`}});
}
