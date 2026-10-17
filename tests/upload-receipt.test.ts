import {expect,it,vi} from 'vitest';
import {Blob as NativeBlob} from 'node:buffer';
import {db,saveDraft,enqueue,claimNextTask} from '../src/core/repository';
import {newDraft} from '../src/core/model';
import {FillAdapter} from '../src/platforms/fill-adapter';
it('上传提交回执丢失前已经持久记录不确定性，拒绝安全重试',async()=>{
 const database=await db();const media={id:crypto.randomUUID(),name:'video.mp4',kind:'video' as const,mime:'video/mp4' as const,bytes:8};
 const draft=await saveDraft({...newDraft('video'),title:'测试',markdown:'正文',media:[media]},0);await database.put('media',{...media,draftId:draft.id,blob:new NativeBlob(['12345678']) as unknown as Blob});
 const queued=await enqueue(draft,'douyin','','batch',true,'fill');const claimed=await claimNextTask();expect(claimed?.id).toBe(queued.id);
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:async()=>[]},tabs:{get:async()=>({url:'https://creator.douyin.com/creator-micro/content/upload'}),sendMessage:async(_id:number,p:any)=>{if(p.action==='commit'){expect((await database.get('tasks',queued.id))?.proof?.uploadedMediaIds).toContain(media.id);throw new Error('receipt lost after dispatch');}return {ok:true};}}});
 const adapter=new FillAdapter('douyin');await expect(adapter['upload'](claimed!,123,media)).rejects.toMatchObject({code:'UPLOAD_UNCONFIRMED',retrySafe:false});
 expect((await database.get('tasks',queued.id))?.proof?.uploadedMediaIds).toContain(media.id);
});
it('媒体身份凭据缺失时，同数附件也不能将未知任务核对为填写完成',async()=>{
 const media={id:crypto.randomUUID(),name:'same.png',kind:'image' as const,mime:'image/png' as const,bytes:8};
 const task={id:'test',batchId:'batch',platform:'jike' as const,targetId:'',snapshot:{...newDraft('post'),markdown:'正文',media:[media]},status:'unknown' as const,createdAt:0,updatedAt:0,attemptId:'attempt',tabId:123,progress:'待核对',operation:'fill' as const,proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[media.id]}};
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({url:'https://web.okjike.com/'})},scripting:{executeScript:async()=>[{result:{login:'connected',body:'正文',bodyMatched:true,title:'',images:['https://cdn.test/unrecorded.png'],editorFound:true,videoReady:false}}]}});
 await expect(new FillAdapter('jike').verifyDraft(task)).rejects.toMatchObject({code:'MEDIA_IDENTITY_UNCONFIRMED',retrySafe:false});
});
it('视频页logo和封面图片不能代替尚未完成的视频',async()=>{
 const media={id:crypto.randomUUID(),name:'video.mp4',kind:'video' as const,mime:'video/mp4' as const,bytes:8};
 const task={id:'test',batchId:'batch',platform:'douyin' as const,targetId:'',snapshot:{...newDraft('video'),title:'标题',markdown:'正文',media:[media]},status:'unknown' as const,createdAt:0,updatedAt:0,attemptId:'attempt',tabId:123,progress:'待核对',operation:'fill' as const,proof:{bodyDigest:'a'.repeat(64),mediaHashes:['a'.repeat(64)],uploadedMediaIds:[media.id]}};
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({url:'https://creator.douyin.com/creator-micro/content/upload'})},scripting:{executeScript:async()=>[{result:{login:'connected',body:'正文',bodyMatched:true,title:'标题',images:['https://cdn.test/logo.png'],editorFound:true,videoReady:false,videoIdentity:'https://cdn.test/processing.mp4'}}]}});
 const adapter=new FillAdapter('douyin');expect((await adapter['observe'](task,123)).mediaCount).toBe(0);await expect(adapter.verifyDraft(task)).rejects.toMatchObject({code:'FILL_UNCONFIRMED',retrySafe:false});
});
