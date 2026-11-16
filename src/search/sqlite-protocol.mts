import type {Corpus,RealmOptions,SearchCollection,SearchRealm} from './types.mjs';
export type CollectionOperation='search'|'mget'|'bulk'|'delete'|'byQuery'|'update';
type RealmOperation='ensureIndex'|'refresh';
type CommandOperation={
 [K in CollectionOperation]:{operation:K;corpus:Corpus;args:Parameters<SearchCollection[K]>}
}[CollectionOperation]|{
 [K in RealmOperation]:{operation:K;args:Parameters<SearchRealm[K]>}
}[RealmOperation];
export type SqliteCommand=CommandOperation&{realm:Pick<RealmOptions,'endpoint'|'tenantId'|'index'>};
export interface SqliteError {message:string;status?:number;permanent?:boolean;code?:string;writeOutcome?:'not-applied'}
export type SqliteReply={id:number;result:unknown}|{id:number;error:SqliteError};
