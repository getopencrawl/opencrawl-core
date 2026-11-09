import type {Mapping} from './types.mjs';
export const connectorMapping = {dynamic: 'strict', properties: {
  ...Object.fromEntries(['tenantId', 'connectionId', 'workspaceId', 'provider', 'kind', 'sourceId', 'channelId', 'threadTs', 'timestamp', 'authorId', 'contentHash', 'parentId', 'parentKind', 'resourceVersion', 'relatedId', 'discussionId', 'repository', 'state', 'speakers', 'startTime', 'endTime', 'fileId', 'extractionStatus', 'partPath'].map(key => [key, {type: 'keyword'}])),
  title: {type: 'text'}, text: {type: 'text'}, extractedAt: {type: 'long'}, deleted: {type: 'boolean'}, publicChannel: {type: 'boolean'},
  sourceAuthority:{type:'integer'}, normalizerVersion:{type:'integer'}, available: {type:'boolean'}, partStart:{type:'integer'}, partEnd:{type:'integer'}, partOverlap:{type:'integer'},
  componentCount: {type: 'integer'}, versionAt: {type: 'long'}, sequence: {type: 'integer'}, chunkCount: {type: 'integer'}, heading: {type: 'text'},
  summary: {type: 'text', index: false}, url: {type: 'keyword', index: false, doc_values: false},
  sourceKey: {type: 'keyword', index: false, doc_values: false},
}};

export const sessionIndexMapping={dynamic:'strict',properties:{
  tenantId:{type:'keyword'},userId:{type:'keyword'},installationId:{type:'keyword'},sessionId:{type:'keyword'},
  harness:{type:'keyword'},origin:{type:'keyword'},eventId:{type:'keyword'},kind:{type:'keyword'},role:{type:'keyword'},
  timestamp:{type:'date',ignore_malformed:true},receivedAt:{type:'date'},sequence:{type:'long'},chunk:{type:'integer'},
  text:{type:'text'},sourceKey:{type:'keyword',index:false,doc_values:false},
  nativeId:{type:'keyword'},parentId:{type:'keyword'},turnId:{type:'keyword'},toolCallId:{type:'keyword'},
  toolNames:{type:'keyword'},attachments:{type:'object',enabled:false},host:{type:'keyword',ignore_above:256},
  private:{type:'boolean'},
}};

export const boardIndexMapping = {dynamic: 'strict', properties: {
  boardId: {type: 'keyword'}, tenantId: {type: 'keyword'}, id: {type: 'integer'},
  timestamp: {type: 'date'}, day: {type: 'keyword'},
  topic: {type: 'keyword', fields: {text: {type: 'text'}}},
  agent: {type: 'keyword'}, author: {type: 'keyword'}, name: {type: 'keyword'}, text: {type: 'text'},
}};

const metadata = (mapping: {properties: Record<string, Mapping>}) => ({type:'object', dynamic:'strict', properties:Object.fromEntries(
  Object.entries(mapping.properties).filter(([key]) => !['tenantId','text','title','sourceKey'].includes(key)))});
export const memoryMapping={dynamic:'strict',properties:{
  ...Object.fromEntries(['userId','installationId','harness','host','snapshotId','kind','path','project','sourceSessionId'].map(k=>[k,{type:'keyword'}])),
  generation:{type:'long'},chunk:{type:'integer'},receivedAt:{type:'date'},modifiedAt:{type:'date'},private:{type:'boolean'},
}};
export const realmMapping = {dynamic:'strict', properties:{
  schema:{type:'integer'}, tenantId:{type:'keyword'}, corpus:{type:'keyword'}, id:{type:'keyword'},
  source:{type:'keyword'}, kind:{type:'keyword'}, timestamp:{type:'date'}, author:{type:'keyword'},
  text:{type:'text',fields:{english:{type:'text',analyzer:'english'}}}, title:{type:'text'}, sourceKey:{type:'keyword',index:false,doc_values:false},
  connector:metadata(connectorMapping), session:metadata(sessionIndexMapping), board:metadata(boardIndexMapping),memory:{type:'object',...memoryMapping},
}};
