import {it,expect,beforeEach,vi} from 'vitest';
import {Blob} from 'node:buffer';
import {newDraft,normaliseSettings} from '../src/core/model';
import {needsTextImages,syncOperation,batchSummary} from '../src/core/post-routing';
import {wrapText,cardPages,textImages} from '../src/core/text-images';
import {db,saveDraft,enqueue,updateTask} from '../src/core/repository';
beforeEach(async()=>{const d=await db();for(const s of ['drafts','media','tasks'] as const)await d.clear(s);});
it('图片按平台必需条件路由，纯文本平台及已有附件不生成',()=>{
 const post=newDraft('post');for(const p of ['douyin','kuaishou','channels','xiaohongshu'] as const)expect(needsTextImages(post,p)).toBe(true);
 for(const p of ['weixin','jike','zsxq','x','bilibili'] as const)expect(needsTextImages(post,p)).toBe(false);
 expect(needsTextImages({...post,type:'article'},'douyin')).toBe(false);expect(needsTextImages({...post,media:[{} as any]},'douyin')).toBe(false);
});
it('总开关统一所选平台，旧平台开关不再影响新任务',()=>{
 const d=newDraft('post');const settings=normaliseSettings({directPublishPlatforms:['jike']});expect(syncOperation('jike',d,settings)).toBe('publish');expect(syncOperation('zsxq',d,settings)).toBe('publish');expect(syncOperation('jike',d,{...settings,directPublish:false})).toBe('fill');expect(settings.autoTextImages).toBe(true);
});
it('中日韩文字、emoji和换行完整分页；超过页数明确失败不截断',()=>{
 const text='甲乙👨‍👩‍👧‍👦丙\n\n中文段落';const lines=wrapText(text,t=>[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(t)].length,2);
 expect(lines[1]).toBe('👨‍👩‍👧‍👦丙');expect(lines).toContain('');expect(cardPages(lines,2).flat()).toEqual(lines);expect(()=>cardPages(lines,1,1)).toThrow('最多');
});
it('后台本地渲染缓存全部页面，任务引用生成图但原稿不加附件',async()=>{
 const ctx={font:'',fillStyle:'',textBaseline:'',measureText:(s:string)=>({width:[...s].length*40}),fillRect:vi.fn(),fillText:vi.fn()};
 vi.stubGlobal('OffscreenCanvas',class {getContext(){return ctx;}convertToBlob(){return Promise.resolve(new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}));}});
 try{const draft=await saveDraft({...newDraft('post'),title:'原稿',markdown:'正文'},0);const images=await textImages(draft);expect(await textImages(draft)).toEqual(images);expect(images).toHaveLength(1);
 const task=await enqueue({...draft,media:images},'douyin','','batch',true,'fill');expect(task.snapshot.media).toEqual(images);expect((await(await db()).get('drafts',draft.id))?.media).toEqual([]);expect((await(await db()).get('media',images[0]!.id))?.blob.size).toBe(4);
 }finally{vi.unstubAllGlobals();}
});
it('之前缺图失败可生成新快照继续；原失败历史保留、重复点击不增任务',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'失败原稿'},0);const old=await enqueue(draft,'douyin','','old',true,'fill');await updateTask(old.id,['queued'],{status:'failed',error:{code:'IMAGE_REQUIRED',message:'缺图',retrySafe:true}});
 const image={id:crypto.randomUUID(),name:'generated.png',kind:'image' as const,mime:'image/png' as const,bytes:4};await(await db()).put('media',{...image,draftId:draft.id,blob:new Blob(['test']) as unknown as globalThis.Blob});
 const next=await enqueue({...draft,media:[image]},'douyin','','new',true,'fill');expect(next.id).not.toBe(old.id);expect(next.supersedesTaskId).toBe(old.id);expect((await(await db()).get('tasks',old.id))?.snapshot.media).toEqual([]);
 expect((await enqueue({...draft,media:[image]},'douyin','','duplicate',true,'fill')).id).toBe(next.id);
});
it('失败填写可明确改为发布；未知上传不受文字图片或新开关影响',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'待发布'},0);const old=await enqueue(draft,'x','','old',true,'fill');await updateTask(old.id,['queued'],{status:'failed',error:{code:'PERMISSION_REQUIRED',message:'权限',retrySafe:true}});const pub=await enqueue(draft,'x','','pub',true,'publish');expect(pub.supersedesTaskId).toBe(old.id);
 await updateTask(pub.id,['queued'],{status:'preparing'});await updateTask(pub.id,['preparing'],{status:'unknown'});expect((await enqueue(draft,'x','','again',true,'publish')).id).toBe(pub.id);
 expect(batchSummary([pub])).toMatchObject({done:false,running:1});
});
it('用户解决旧稿阻断后再次开始，建立关联新任务；并发重复点击仍只入队一次',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'用户已删除废稿'},0);const old=await enqueue(draft,'zsxq','123456','blocked',true,'publish');await updateTask(old.id,['queued'],{status:'preparing'});await updateTask(old.id,['preparing'],{status:'failed',error:{code:'EDITOR_OCCUPIED',message:'恢复旧稿',retrySafe:true}});
 const [a,b]=await Promise.all([enqueue(draft,'zsxq','123456','retry-a',true,'publish'),enqueue(draft,'zsxq','123456','retry-b',true,'publish')]);expect(a.id).toBe(b.id);expect(a.id).not.toBe(old.id);expect(a.supersedesTaskId).toBe(old.id);expect(a.status).toBe('queued');expect((await(await db()).get('tasks',a.id))?.publicationAttemptedAt).toBeUndefined();expect((await(await db()).get('tasks',old.id))?.status).toBe('failed');
});
it('已交付附件、已尝试提交或不可安全重试的旧稿错误，再次开始都不能生成发布任务',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'不能重发'},0);for(const platform of ['zsxq','x','jike'] as const){const old=await enqueue(draft,platform,'123456','blocked',true,'publish');await updateTask(old.id,['queued'],{status:'preparing'});await updateTask(old.id,['preparing'],{status:'failed',error:{code:'EDITOR_OCCUPIED',message:'旧稿',retrySafe:platform!=='jike'},...(platform==='x'?{publicationAttemptedAt:Date.now()}:{}) ,...(platform==='zsxq'?{proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[crypto.randomUUID()]}}:{})});expect((await enqueue(draft,platform,'123456','again',true,'publish')).id).toBe(old.id);}
 expect(await(await db()).getAll('tasks')).toHaveLength(3);
});
