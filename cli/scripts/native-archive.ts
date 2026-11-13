/** Serialize explicitly: Bun 1.3.14's Bun.write(Archive) ignores compression. */
export async function nativeArchive(entries:Record<string,Uint8Array>){
  return new Bun.Archive(entries,{compress:'gzip'}).bytes();
}
