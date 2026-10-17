import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Blob as NativeBlob} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import sharp from 'sharp';
import {FillAdapter} from '../src/platforms/fill-adapter';
import {nativeFillEditor} from '../src/platforms/native-fill-editor';
import {fillProfile} from '../src/platforms/fill-profiles';
import {newDraft} from '../src/core/model';
import {db,saveDraft,enqueue,updateTask} from '../src/core/repository';

const bytesHash=async(b:Uint8Array)=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',Uint8Array.from(b)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const png=async(values:number[],compressionLevel=0)=>new Uint8Array(await sharp(Buffer.from(values),{raw:{width:values.length/4,height:1,channels:4}}).png({compressionLevel}).toBuffer());
const pixelIdentity=async(bytes:Uint8Array)=>{const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});return `pixels-sha256:${info.width}:${info.height}:${await bytesHash(data)}`;};
function installPixelDecoder(){
 vi.stubGlobal('createImageBitmap',vi.fn(async(blob:Blob)=>{const {data,info}=await sharp(new Uint8Array(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({resolveWithObject:true});return {width:info.width,height:info.height,rgba:new Uint8ClampedArray(data),close:vi.fn()};}));
 vi.stubGlobal('OffscreenCanvas',class{rgba=new Uint8ClampedArray();constructor(public width:number,public height:number){}getContext(){return {drawImage:(b:any)=>{this.rgba=b.rgba;},getImageData:()=>({data:this.rgba})};}});
}
beforeEach(async()=>{vi.stubGlobal('crypto',webcrypto);const d=await db();for(const name of d.objectStoreNames)await d.clear(name);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();document.body.innerHTML='';});
async function setup(){
 const originals=await Promise.all([png([250,12,33,255,10,20,30,255]),png([1,2,3,255,4,5,6,255])]);
 const refs=originals.map((b,i)=>({id:crypto.randomUUID(),name:`original-${i}.png`,kind:'image' as const,mime:'image/png' as const,bytes:b.length}));
 const source=newDraft('post'),d=await db();for(const [i,ref] of refs.entries())await d.put('media',{...ref,draftId:source.id,blob:new NativeBlob([originals[i]!],{type:'image/png'}) as unknown as Blob});
 const draft=await saveDraft({...source,markdown:'本任务正文',media:refs},0),queued=await enqueue(draft,'x','','pixel-proof',false,'fill');
 const task=await updateTask(queued.id,['queued'],{status:'preparing',tabId:7,proof:{bodyDigest:'body',mediaHashes:[],uploadedMediaIds:refs.map(r=>r.id)}});
 const reencoded=await Promise.all(originals.map(b=>sharp(b).png({compressionLevel:9}).toBuffer()));expect(reencoded[1]).not.toEqual(Buffer.from(originals[1]!));
 const images=await Promise.all(reencoded.map(async b=>'blob-sha256:'+await bytesHash(b))),pixels=await Promise.all(originals.map(pixelIdentity));
 const a=new FillAdapter('x'),native=vi.spyOn(a as any,'native').mockImplementation(async(_tab:any,_profile:any,_action:any,payload:any)=>({images:payload.verifyImagePixels?pixels:images,uploadBusy:false,imageItems:2}));
 installPixelDecoder();return {task,refs,a,native,images,pixels};
}
it('X本任务有序上传的无损重编码接受完整像素证明，原字节相同直接通过',async()=>{
 const {task,refs,a,native}=await setup();await(a as any).verifyUploadedImage(task,7,refs[1]!.id);expect(native.mock.calls.some(c=>(c[3] as any).verifyImagePixels)).toBe(true);expect(createImageBitmap).toHaveBeenCalledWith(expect.anything(),{colorSpaceConversion:'none'});
 native.mockReset();const stored=await(await db()).get('media',refs[1]!.id);native.mockResolvedValue({images:['blob-sha256:'+await bytesHash(new Uint8Array(await stored!.blob.arrayBuffer()))]});await(a as any).verifyUploadedImage(task,7,refs[1]!.id);expect(native).toHaveBeenCalledTimes(1);
});
it.each(['different-pixels','resized','reordered','changed-during-check'] as const)('X完整像素或顺序证据失败必须阻止：%s',async reason=>{
 const {task,refs,a,native,images,pixels}=await setup();let reads=0;
 native.mockImplementation(async(_tab:any,_profile:any,_action:any,payload:any)=>{reads++;const actual=[...pixels];if(reason==='different-pixels')actual[1]=await pixelIdentity(await png([250,12,33,255,10,20,31,255]));if(reason==='resized')actual[1]=actual[1]!.replace(':2:1:',':1:2:');if(reason==='reordered')actual.reverse();return {images:payload.verifyImagePixels?actual:reason==='changed-during-check'&&reads===3?[...images].reverse():images,uploadBusy:false,imageItems:2};});
 await expect((a as any).verifyUploadedImage(task,7,refs[1]!.id)).rejects.toMatchObject({code:'MEDIA_IDENTITY',retrySafe:false});
});
it.each(['unowned','extra-owned','wrong-order','submitted','wrong-tab'] as const)('X只在完整本任务上传前缀可证明时接受编码变化：%s',async reason=>{
 const {task,refs,a,native}=await setup();const proof={...task.proof!,uploadedMediaIds:reason==='unowned'?[refs[1]!.id]:reason==='extra-owned'?[...refs.map(r=>r.id),'foreign']:reason==='wrong-order'?[...refs.map(r=>r.id)].reverse():refs.map(r=>r.id)};
 await updateTask(task.id,['preparing'],{proof,...(reason==='submitted'?{publicationAttemptedAt:1}:{}),...(reason==='wrong-tab'?{tabId:9}:{})});
 await expect((a as any).verifyUploadedImage(task,7,refs[1]!.id)).rejects.toMatchObject({code:'MEDIA_IDENTITY',retrySafe:false});expect(native).toHaveBeenCalledTimes(1);
});
it.each(['blob','data'] as const)('X原生%s预览提供原尺寸全部RGBA证明，损失单像素不会相同',async protocol=>{
 const original=await png([255,0,0,255,0,255,0,255]),reencoded=new Uint8Array(await sharp(original).png({compressionLevel:9}).toBuffer());
 vi.stubGlobal('location',{origin:'https://x.com'});const src=protocol==='blob'?'blob:https://x.com/preview':'data:image/png;base64,'+Buffer.from(reencoded).toString('base64');document.body.innerHTML=`<form><div class="body" contenteditable="true">正文</div><img src="${src}"></form>`;vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as any);
 let content=reencoded;vi.stubGlobal('fetch',vi.fn(async()=>({blob:async()=>new NativeBlob([content],{type:'image/png'})})));installPixelDecoder();const profile={...fillProfile('x','post')!,body:'.body',scope:'form',imagesSelector:'img'};const payload={title:'',text:'正文',video:false,expectedImages:1,verifyImagePixels:true};
 expect((await nativeFillEditor(profile,'read',payload)).images).toEqual([await pixelIdentity(original)]);content=await png([254,0,0,255,0,255,0,255]);expect((await nativeFillEditor(profile,'read',payload)).images).not.toEqual([await pixelIdentity(original)]);
});
it('X完整填写流程只交付一次每张原图并保存与有序预览绑定的证明',async()=>{
 const {task,refs,a,native,images,pixels}=await setup();await updateTask(task.id,['preparing'],{proof:{bodyDigest:'body',mediaHashes:[],uploadedMediaIds:[]}});const fresh=(await(await db()).get('tasks',task.id))!;let delivered=0;
 const state=async(pixel=false)=>({images:(pixel?pixels:images).slice(0,delivered),imageItems:delivered,uploadBusy:false,editorFound:true,bodyMatched:true,body:task.snapshot.markdown,title:'',login:'connected'});
 native.mockImplementation(async(_tab:any,_profile:any,_action:any,payload:any)=>state(payload.verifyImagePixels));
 vi.spyOn(a as any,'observe').mockImplementation(async()=>{const read=await state();return {...read,bodyDigest:'body',mediaCount:delivered,mediaHashes:await Promise.all(read.images.map(async s=>bytesHash(new TextEncoder().encode(s))))};});
 const upload=vi.spyOn(a as any,'upload').mockImplementation(async(_t:any,_tab:any,media:any)=>{expect(media.id).toBe(refs[delivered]!.id);delivered++;await updateTask(task.id,['preparing'],{proof:{bodyDigest:'body',mediaHashes:[],uploadedMediaIds:refs.slice(0,delivered).map(r=>r.id)}});});
 const result=await a.fillEditor(fresh,7);expect(result.mediaCount).toBe(2);expect(upload).toHaveBeenCalledTimes(2);expect((await(await db()).get('tasks',task.id))!.proof!.uploadedMediaIds).toEqual(refs.map(r=>r.id));
});
it('X未能解码的额外预览项仍计入图片总数，不能过滤后冒认本任务',async()=>{
 vi.stubGlobal('location',{origin:'https://x.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">正文</div><img src="https://cdn.test/task.png"><img src="http://other.test/unknown.png"></form>';vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as any);const p={...fillProfile('x','post')!,body:'.body',scope:'form',imagesSelector:'img'};const read=await nativeFillEditor(p,'read',{title:'',text:'正文',video:false,expectedImages:1});expect(read.images).toEqual(['https://cdn.test/task.png']);expect(read.imageItems).toBe(2);
});

it('X仅接受公开编码链重算后的精确JPEG字节，顺序与原始PNG均绑定',async()=>{
 const {task,refs,a,native,images}=await setup();
 native.mockImplementation(async(_tab:any,_profile:any,_action:any,payload:any)=>{
  if(payload.verifyImagePixels)return {images:['different','different'],uploadBusy:false,imageItems:2};
  if(payload.verifyXOriginals){const proofs=await Promise.all(payload.verifyXOriginals.map(async(original:any,index:number)=>{const stored=await(await db()).get('media',refs[index]!.id);expect(Buffer.from(original.base64,'base64')).toEqual(Buffer.from(await stored!.blob.arrayBuffer()));expect(original.digest).toBe(await bytesHash(new Uint8Array(await stored!.blob.arrayBuffer())));const actual=images[index]!.split(':').at(-1);return `x-jpeg85-sha256:${original.digest}:${actual}:${actual}`;}));return {images:proofs,uploadBusy:false,imageItems:2};}
  return {images,uploadBusy:false,imageItems:2};
 });
 await(a as any).verifyUploadedImage(task,7,refs[1]!.id);expect(native.mock.calls.some(c=>(c[3] as any).verifyXOriginals)).toBe(true);
});
it.each(['wrong-original','different-encoding','reordered','busy','preview-changed'] as const)('X确定JPEG转换拒绝不完整证明：%s',async reason=>{
 const {task,refs,a,native,images}=await setup();let converted=false;
 native.mockImplementation(async(_tab:any,_profile:any,_action:any,payload:any)=>{
  if(payload.verifyImagePixels)return {images:['different','different'],uploadBusy:false,imageItems:2};
  if(payload.verifyXOriginals){converted=true;const proof=payload.verifyXOriginals.map((original:any,index:number)=>{const actual=images[index]!.split(':').at(-1);return `x-jpeg85-sha256:${reason==='wrong-original'?'foreign':original.digest}:${reason==='different-encoding'?'wrong':actual}:${actual}`;});if(reason==='reordered')proof.reverse();return {images:proof,uploadBusy:reason==='busy',imageItems:2};}
  return {images:converted&&reason==='preview-changed'?[...images].reverse():images,uploadBusy:false,imageItems:2};
 });
 await expect((a as any).verifyUploadedImage(task,7,refs[1]!.id)).rejects.toMatchObject({code:'MEDIA_IDENTITY',retrySafe:false});
});
it('X原生确定转换使用白底、原尺寸、唯一0.85质量并比较全部JPEG字节',async()=>{
 const original=await png([255,0,0,128,0,255,0,255]),encoded=new Uint8Array(await sharp(original).flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer()),digest=await bytesHash(original),encodedHash=await bytesHash(encoded);
 vi.stubGlobal('location',{origin:'https://x.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">正文</div><img src="blob:https://x.com/preview"></form>';vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as any);
 const NativeURL=URL;vi.stubGlobal('URL',class extends NativeURL{static override createObjectURL=vi.fn(()=> 'blob:https://x.com/original');static override revokeObjectURL=vi.fn();});
 vi.stubGlobal('Image',class{naturalWidth=2;naturalHeight=1;onload?:()=>void;onerror?:()=>void;set src(_value:string){queueMicrotask(()=>this.onload?.());}decode=async()=>{};});
 const context={fillStyle:'',fillRect:vi.fn(),drawImage:vi.fn()};const canvas={width:0,height:0,getContext:vi.fn(()=>context),toDataURL:vi.fn(()=>`data:image/jpeg;base64,${Buffer.from(encoded).toString('base64')}`)};
 const create=document.createElement.bind(document);vi.spyOn(document,'createElement').mockImplementation(((name:string,...args:any[])=>name==='canvas'?canvas:create(name,...args)) as any);
 vi.stubGlobal('fetch',vi.fn(async()=>({blob:async()=>new NativeBlob([encoded],{type:'image/jpeg'})})));
 const profile={...fillProfile('x','post')!,body:'.body',scope:'form',imagesSelector:'img'};
 const result=await nativeFillEditor(profile,'read',{title:'',text:'正文',video:false,expectedImages:1,verifyXOriginals:[{base64:Buffer.from(original).toString('base64'),digest}]});
 expect(result.images).toEqual([`x-jpeg85-sha256:${digest}:${encodedHash}:${encodedHash}`]);expect(canvas.width).toBe(2);expect(canvas.height).toBe(1);expect(context.fillStyle).toBe('#FFFFFF');expect(context.fillRect).toHaveBeenCalledWith(0,0,2,1);expect(context.drawImage).toHaveBeenCalledWith(expect.anything(),0,0,2,1);expect(canvas.toDataURL).toHaveBeenCalledExactlyOnceWith('image/jpeg',.85);expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
});
it('X恢复在原页只读核对全部有序媒体与正文，不补填、不重传或发布',async()=>{
 const {task,refs,a,native,images}=await setup();const recovered=await updateTask(task.id,['preparing'],{status:'unknown',operation:'publish',error:{code:'MEDIA_IDENTITY',message:'old',retrySafe:false}});
 vi.spyOn(a as any,'observe').mockResolvedValue({editorFound:true,bodyMatched:true,bodyDigest:'body',mediaCount:2,imageItems:2,mediaHashes:['first','second'],uploadBusy:false,title:''});
 const upload=vi.spyOn(a as any,'upload');vi.stubGlobal('chrome',{tabs:{get:vi.fn(async()=>({id:7,url:'https://x.com/compose/post'}))}});
 const result=await a.recoverEditor(recovered);expect(result.proof.uploadedMediaIds).toEqual(refs.map(m=>m.id));expect(result.evidence.notice).toContain('只读');expect(upload).not.toHaveBeenCalled();expect(native.mock.calls.every(c=>c[2]==='read')).toBe(true);expect(images.length).toBe(2);
});
it.each(['attempted','missing-prefix','wrong-order','body-changed','wrong-tab','last-image-only'] as const)('X只读恢复拒绝不安全条件：%s',async reason=>{
 const {task,refs,a,native,images}=await setup();const proof={...task.proof!,uploadedMediaIds:reason==='missing-prefix'?[refs[1]!.id]:reason==='wrong-order'?[...refs.map(m=>m.id)].reverse():refs.map(m=>m.id)};
 const recovered=await updateTask(task.id,['preparing'],{status:'unknown',operation:'publish',error:{code:'MEDIA_IDENTITY',message:'old',retrySafe:false},proof,...(reason==='attempted'?{publicationAttemptedAt:1}:{}),...(reason==='wrong-tab'?{tabId:9}:{})});
 vi.spyOn(a as any,'observe').mockResolvedValue({editorFound:true,bodyMatched:reason!=='body-changed',bodyDigest:'body',mediaCount:2,imageItems:2,mediaHashes:['first','second'],uploadBusy:false,title:''});
 if(reason==='wrong-tab')await updateTask(task.id,['unknown'],{tabId:7});
 if(reason==='last-image-only'){const stored=await(await db()).get('media',refs[1]!.id);const last='blob-sha256:'+await bytesHash(new Uint8Array(await stored!.blob.arrayBuffer()));native.mockResolvedValue({images:['blob-sha256:foreign',last],uploadBusy:false,imageItems:2});}
 await expect(a.recoverEditor(recovered)).rejects.toMatchObject({retrySafe:false});expect(native.mock.calls.every(c=>c[2]==='read')).toBe(true);
});
