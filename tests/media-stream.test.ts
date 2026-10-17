// @vitest-environment node
import {expect,it} from 'vitest';
import {Blob as NativeBlob} from 'node:buffer';
import {mediaChunks} from '../src/core/media-stream';
it('大视频只逐块读取，恢复原始字节且顺序不丢失',async()=>{
  const bytes=Uint8Array.from({length:5*1024*1024+123},(_,i)=>i%251);const blob=new NativeBlob([bytes]);let largest=0,slices=0;
  const bounded={size:blob.size,arrayBuffer:()=>{throw new Error('whole-file read forbidden');},slice:(start:number,end:number)=>{largest=Math.max(largest,end-start);slices++;return blob.slice(start,end);}} as unknown as Blob;
  const actual:Buffer[]=[];let index=0;for await(const part of mediaChunks(bounded)){expect(part.index).toBe(index++);actual.push(Buffer.from(part.chunk,'base64'));}
  expect(largest).toBeLessThanOrEqual(96*1024);expect(slices).toBeGreaterThan(50);expect(Buffer.concat(actual).equals(Buffer.from(bytes))).toBe(true);
});
