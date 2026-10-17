/** Read only one bounded Blob slice at a time; never materialize a video-sized array. */
export async function* mediaChunks(blob: Blob, size=96*1024) {
  if(!Number.isSafeInteger(size)||size<1||size>256*1024)throw new Error('Invalid chunk size');
  for(let offset=0,index=0;offset<blob.size;offset+=size,index++) {
    const bytes=new Uint8Array(await blob.slice(offset,Math.min(blob.size,offset+size)).arrayBuffer());
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    yield {index,chunk:btoa(binary),bytes:bytes.length};
  }
}
