/** Conditional storage fixture shared by ingestion and worker tests. */
export function memorySessionStore() {
 const data=new Map(),versions=new Map();
 const write=(key,value)=>{data.set(key,Buffer.from(value));versions.set(key,(versions.get(key)||0)+1);};
 return {data,
  put:async(key,value)=>{write(key,value);},
  get:async(key,{maxBytes=Infinity}={})=>{const value=data.get(key)||null;if(value&&value.length>maxBytes)throw new Error('Object exceeds read limit');return value;},
  delete:async key=>{data.delete(key);versions.delete(key);},
  readVersion:async(key,{maxBytes=Infinity}={})=>{const value=data.get(key)||null;if(value&&value.length>maxBytes)throw new Error('Object exceeds read limit');return {data:value,version:value?versions.get(key):null};},
  compareAndSet:async(key,version,value)=>{if((data.has(key)?versions.get(key):null)!==version)return false;write(key,value);return true;},
  listPage:async(prefix,{continuationToken,maxKeys=1000}={})=>{const keys=[...data.keys()].filter(key=>key.startsWith(prefix)&&(!continuationToken||key>continuationToken)).sort();return {keys:keys.slice(0,maxKeys),nextToken:keys.length>maxKeys?keys[maxKeys-1]:null};},
 };
}
