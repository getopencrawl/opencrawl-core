import type {IntegrationRecord} from './types.mjs';
/** Airbyte S3 configuration shared by normal provisioning and the held rebind. */
export function landingDestinationConfiguration(record: IntegrationRecord, region: string) {
  if (!record?.s3Bucket || !record?.s3Prefix || !region) {
    throw new Error('Incomplete Airbyte landing configuration');
  }
  return {
    destinationType: 's3',
    s3_bucket_name: record.s3Bucket,
    s3_bucket_region: region,
    s3_bucket_path: record.s3Prefix,
    s3_path_format: 'stream=${STREAM_NAME}/date=${YEAR}-${MONTH}-${DAY}/sync=${SYNC_ID}/',
    file_name_pattern: '{timestamp}_{part_number}{format_extension}',
    format: {format_type: 'JSONL', flattening: 'No flattening', compression: {compression_type: 'GZIP'}},
  };
}
