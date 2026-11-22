import {dlopen, FFIType} from 'bun:ffi';

// Both native calls exchange two existing directories as one filesystem operation.
// A filesystem without exchange support keeps serving the original directory.
export function exchangePluginDirectories(live:string, staged:string) {
  const left=Buffer.from(live+'\0'),right=Buffer.from(staged+'\0');
  if(process.platform==='darwin'){
    const lib=dlopen('/usr/lib/libSystem.B.dylib',{renamex_np:{args:[FFIType.ptr,FFIType.ptr,FFIType.u32],returns:FFIType.i32}});
    try{return lib.symbols.renamex_np(left,right,2)===0;}finally{lib.close();}
  }
  if(process.platform==='linux'){
    const lib=dlopen('libc.so.6',{renameat2:{args:[FFIType.i32,FFIType.ptr,FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i32}});
    try{return lib.symbols.renameat2(-100,left,-100,right,2)===0;}finally{lib.close();}
  }
  return false;
}
