// @vitest-environment-options {"url":"https://member.bilibili.com/"}
import {beforeEach,expect,it,vi} from 'vitest';
import {nativeCoverEditor} from '../src/platforms/native-cover-editor';
import {nativeMediaInput,mediaRoots} from '../src/platforms/media-input';
import {FillAdapter} from '../src/platforms/fill-adapter';
import {db,saveDraft,enqueue,claimNextTask} from '../src/core/repository';
import {newDraft,type MediaRef} from '../src/core/model';
import {Blob as NativeBlob} from 'node:buffer';
const image=(kind:'image'|'cover'='cover'):MediaRef=>({id:crypto.randomUUID(),kind,name:'cover.png',mime:'image/png',bytes:8});
function visible(){for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;}
beforeEach(async()=>{const d=await db();for(const s of ['drafts','media','tasks'] as const)await d.clear(s);});
it('封面输入不能误选视频控件，模态确认不能触发外部发布',async()=>{
 document.body.innerHTML='<div class="bcc-upload-wrapper"><input id="video" type="file" accept="video/mp4"></div><div class="cover-main"><img src="https://cdn.test/old.png"></div><div class="bcc-dialog"><div class="bcc-upload-wrapper"><input id="cover" type="file" accept="image/png,image/jpeg"></div><div class="submit">完成</div></div><button id="publish">发布</button>';visible();
 expect(nativeMediaInput('bilibili',image()).id).toBe('cover');expect(nativeMediaInput('bilibili',{...image(),kind:'video',mime:'video/mp4'}).id).toBe('video');
 const publish=vi.fn();document.querySelector('#publish')!.addEventListener('click',publish);const confirm=vi.fn(()=>{document.querySelector('.cover-main img')!.setAttribute('src','https://cdn.test/new.png');document.querySelector('.bcc-dialog')!.remove();});document.querySelector('.submit')!.addEventListener('click',confirm);
 await nativeCoverEditor('bilibili','confirm');expect(confirm).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();expect((await nativeCoverEditor('bilibili','read')).identities).toEqual(['https://cdn.test/new.png']);
 await expect(nativeCoverEditor('kuaishou','open')).rejects.toThrow();
});
it('封面控件重复时拒绝选择，不拿第一个冒充正确控件',()=>{
 document.body.innerHTML='<div class="bcc-dialog"><div class="bcc-upload-wrapper"><input type="file" accept="image/png"><input type="file" accept="image/png"></div></div>';expect(()=>nativeMediaInput('bilibili',image())).toThrow('不唯一');
});
it('上传控件能遍历开放Shadow DOM，而不跨来源读取iframe',()=>{
 document.body.innerHTML='<div id="host"></div>';const shadow=document.querySelector('#host')!.attachShadow({mode:'open'});shadow.innerHTML='<input id="shadow-video" type="file" accept="video/mp4">';expect(mediaRoots()).toHaveLength(2);expect(nativeMediaInput('channels',{...image(),kind:'video',mime:'video/mp4'}).id).toBe('shadow-video');
});
it('已有视频时在任何上传前停止，不覆盖平台自动恢复的附件',async()=>{
 const media={...image(),kind:'video' as const,mime:'video/mp4' as const,name:'video.mp4'};const draft={...newDraft('video'),title:'标题',markdown:'说明',media:[media]};
 const task={id:'task',batchId:'batch',platform:'douyin' as const,targetId:'',snapshot:draft,status:'preparing' as const,createdAt:0,updatedAt:0,attemptId:'attempt',progress:''};const send=vi.fn();
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({url:'https://creator.douyin.com/creator-micro/content/upload'}),sendMessage:send},scripting:{executeScript:async()=>[{result:{login:'connected',title:'',body:'',hasVideoMedia:true}}]}});
 await expect(new FillAdapter('douyin').fillEditor(task,123)).rejects.toMatchObject({code:'MEDIA_IDENTITY',retrySafe:false});expect(send).not.toHaveBeenCalled();
});
it('视频先完成再填写封面，既有默认封面不能伪造本次封面证明（Mock）',async()=>{

 const cover=image();const video={...image(),kind:'video' as const,mime:'video/mp4' as const,name:'video.mp4'};const draft=await saveDraft({...newDraft('video'),title:'标题',markdown:'说明',media:[cover,video]},0);const d=await db();for(const m of draft.media)await d.put('media',{...m,draftId:draft.id,blob:new NativeBlob(['12345678']) as unknown as Blob});await enqueue(draft,'bilibili','','batch',true,'fill');const task=(await claimNextTask())!;
 const packed=new Uint8Array(40);packed.set(new TextEncoder().encode('12345678'),32);const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',packed))].map(v=>v.toString(16).padStart(2,'0')).join('');
 let current:MediaRef|undefined,videoUploaded=false,coverUploaded=false,coverConfirmed=false,dialog=false;const submitted:string[]=[];
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({url:'https://member.bilibili.com/platform/upload/video/frame'}),sendMessage:async(_id:number,p:any)=>{if(p.action==='begin')current=p.media;if(p.action==='commit'){submitted.push(current!.kind);if(current!.kind==='video')videoUploaded=true;else coverUploaded=true;}return {ok:true};}},scripting:{executeScript:async(p:any)=>{
 if(p.files)return [];
 if(p.func.name==='nativeCoverEditor'){const action=p.args[1];if(action==='open')dialog=true;if(action==='confirm'){if(!coverUploaded)throw new Error('not ready');coverConfirmed=true;dialog=false;}return [{result:{identities:[coverConfirmed?'https://cdn.test/new-cover.png':'https://cdn.test/default.png'],dialogOpen:dialog}}];}
 return [{result:{login:'connected',uploadInputReady:true,editorFound:videoUploaded,hasVideoMedia:false,title:p.args[1]==='fill'?'标题':'',body:p.args[1]==='fill'?'说明':'',bodyMatched:p.args[1]==='fill',images:[],videoReady:videoUploaded,videoIdentity:'native-video-chain256:8:'+digest}}];
 }}});
 const completion=new FillAdapter('bilibili').fillEditor(task,123);const r=await completion;expect(submitted).toEqual(['video','cover']);expect(r.mediaCount).toBe(2);expect(r.mediaHashes).toHaveLength(2);expect(coverConfirmed).toBe(true);expect((await d.get('tasks',task.id))?.proof?.uploadedMediaIds).toEqual([video.id,cover.id]);

});
it('封面面板在开放Shadow DOM内时仍限定确认范围',async()=>{
 document.body.innerHTML='<div id="host"></div><button id="publish">发布</button>';const shadow=document.querySelector('#host')!.attachShadow({mode:'open'});shadow.innerHTML='<div class="cover-main"><img src="https://cdn.test/old.png"></div><div class="bcc-dialog"><div class="submit">完成</div></div>';for(const e of shadow.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 const confirmed=vi.fn();shadow.querySelector('.submit')!.addEventListener('click',confirmed);const published=vi.fn();document.querySelector('#publish')!.addEventListener('click',published);await nativeCoverEditor('bilibili','confirm');expect(confirmed).toHaveBeenCalledTimes(1);expect(published).not.toHaveBeenCalled();
});

it('B站遗留上传输入不能抢当前原生上传容器中的视频',()=>{
 document.body.innerHTML='<input type="file" name="buploader" accept=".mp4"><div class="bcc-upload-wrapper"><input id="current" type="file" accept=".mp4"></div>';expect(nativeMediaInput('bilibili',{...image(),kind:'video',name:'test.mp4',mime:'video/mp4'}).id).toBe('current');
});
it('B站封面保存为CSS背景时仍核对真实资源，不计系统推荐封面',async()=>{
 document.body.innerHTML='<div class="cover-main"><div class="cover-img" style="background-image:url(https://archive.biliimg.com/bfs/archive/selected.jpg)"></div></div><div class="img-item-cover" style="background-image:url(https://archive.biliimg.com/recommend.jpg)"></div>';visible();expect((await nativeCoverEditor('bilibili','read')).identities).toEqual(['https://archive.biliimg.com/bfs/archive/selected.jpg']);
});
it('X只选择发帖弹窗中的附件输入，不选主页上传控件',()=>{
 document.body.innerHTML='<input id="home" type="file" accept="image/png"><div role="dialog" aria-modal="true"><input id="compose" type="file" accept="image/png"></div>';expect(nativeMediaInput('x',{...image('image'),mime:'image/png'}).id).toBe('compose');
});
