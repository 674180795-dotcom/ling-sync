import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Blob} from 'node:buffer';
import {readyZsxqPublication} from '../src/platforms/zsxq-ready';
import {db,saveDraft,enqueue,updateTask} from '../src/core/repository';
import {newDraft} from '../src/core/model';
const probe=vi.hoisted(()=>vi.fn());vi.mock('../src/platforms/publication',()=>({publicationProbe:probe}));
beforeEach(async()=>{const d=await db();for(const s of d.objectStoreNames)await d.clear(s);probe.mockReset();});
afterEach(()=>vi.unstubAllGlobals());
async function fixture(reason='empty'){
 const d=await db(),seed=newDraft('post');const ref={id:crypto.randomUUID(),name:'one.png',kind:'image' as const,mime:'image/png' as const,bytes:3};await d.put('media',{...ref,draftId:seed.id,blob:new Blob(['png']) as globalThis.Blob});const draft=await saveDraft({...seed,markdown:'恢复正文',media:[ref]},0);let task=await enqueue(draft,'zsxq','12345','media',false,'publish');task=await updateTask(task.id,['queued'],{status:'preparing',tabId:7});task=await updateTask(task.id,['preparing'],{status:'ready_for_confirmation',proof:{bodyDigest:'a'.repeat(64),mediaHashes:['b'.repeat(64)],uploadedMediaIds:[ref.id]}});let reloaded=false,replaced=false;
 if(reason==='backup'){const text='原生旧稿',hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');await d.put('backups',{id:'original',taskId:task.id,targetId:task.targetId,tabId:7,url:'https://wx.zsxq.com/group/12345',accountKey:'owner',text,digest:hash,createdAt:1,updatedAt:1,state:'replacing'});}
 probe.mockImplementation(async()=>{if(!reloaded)throw new Error('平台发布条件未满足');return 'ready';});
 const reload=vi.fn(async()=>{expect((await d.get('tasks',task.id))?.editorRecovery?.phase).toBe('marked');expect((await d.get('tasks',task.id))?.publicationAttemptedAt).toBeUndefined();reloaded=true;});
 const bytes=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('png')))].map(n=>n.toString(16).padStart(2,'0')).join('');
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{reload},scripting:{executeScript:async({args}:any)=>{
  if(args?.[0]==='replace'){expect(reason).toBe('backup');expect(args[1]).toMatchObject({text:'原生旧稿',replacement:''});replaced=true;return [{result:{}}];}
  if(!args)return [{result:{epoch:reloaded?2:1,origin:'https://wx.zsxq.com',path:'/group/12345',ready:'complete'}}];
  if(args[1]==='read'){const images=reason==='extra'?['extra','extra']:reason==='prefix'?[(args[2].verifyImageBytes?'content-sha256:'+bytes:'https://cdn.test/one')]:[];return [{result:{editorFound:true,uploadBusy:false,body:'',bodyMatched:false,images}}];}
  if(reloaded&&reason==='account'&&args[0]==='inspect')throw new Error('当前账号已变化，原稿备份保留');
  return [{result:{text:reloaded?(reason==='backup'&&!replaced||reason==='foreign'?'原生旧稿':''):'恢复正文',plain:reloaded,accountKey:'owner',mediaCount:reloaded?(reason==='extra'?2:reason==='prefix'?1:0):1,editorFound:true}}];
 }}});
 const verify=vi.fn(async()=>({kind:'editor_readback' as const,checkedAt:1,url:'https://wx.zsxq.com/group/12345'}));const refill=vi.fn(async(_current:import('../src/core/model').PublishTask)=>{});
 return {d,task,ref,reload,verify,refill};
}
it('已归属图片在刷新后丢失时仅一次重建，原证明先落盘且无提交',async()=>{
 const f=await fixture();expect(await readyZsxqPublication(f.task,f.verify,f.refill)).toBe('ready');expect(f.reload).toHaveBeenCalledOnce();expect(f.refill.mock.calls[0]![0].proof!.uploadedMediaIds).toEqual([]);const t=await f.d.get('tasks',f.task.id);expect(t?.editorRecovery).toMatchObject({phase:'verified',proof:f.task.proof});expect(t?.publicationAttemptedAt).toBeUndefined();
});
it('刷新后保留的原图片经字节和顺序核对后复用，不再交付',async()=>{
 const f=await fixture('prefix');await readyZsxqPublication(f.task,f.verify,f.refill);expect(f.refill.mock.calls[0]![0].proof!.uploadedMediaIds).toEqual([f.ref.id]);
});
it.each(['account','extra'])('%s变化中断恢复并保存记录，第二次准备不刷新',async reason=>{
 const f=await fixture(reason);await expect(readyZsxqPublication(f.task,f.verify,f.refill)).rejects.toThrow();expect(f.refill).not.toHaveBeenCalled();expect((await f.d.get('tasks',f.task.id))?.editorRecovery?.phase).toBe('interrupted');probe.mockRejectedValue(new Error('平台发布条件未满足'));await expect(readyZsxqPublication((await f.d.get('tasks',f.task.id))!,f.verify,f.refill)).rejects.toThrow();expect(f.reload).toHaveBeenCalledOnce();
});
it('本地原图缺失时不刷新、不清除原附件证明',async()=>{
 const f=await fixture();await f.d.delete('media',f.ref.id);await expect(readyZsxqPublication(f.task,f.verify,f.refill)).rejects.toThrow();expect(f.reload).not.toHaveBeenCalled();expect((await f.d.get('tasks',f.task.id))?.proof).toEqual(f.task.proof);
});
it('已有提交标记时即使发送按钮不可用也不刷新重建',async()=>{
 const f=await fixture();await expect(readyZsxqPublication({...f.task,publicationAttemptedAt:1},f.verify,f.refill)).rejects.toThrow();expect(f.reload).not.toHaveBeenCalled();expect(f.refill).not.toHaveBeenCalled();
});
it('恢复旧稿前仍有图片时不取消任务、不清除上传证明',async()=>{
 const f=await fixture();const {cancelZsxqPreparationForRestore}=await import('../src/platforms/zsxq-backup');const backup={id:'backup',taskId:f.task.id,targetId:'12345',tabId:7,accountKey:'owner'} as any;await expect(cancelZsxqPreparationForRestore(f.task,backup)).rejects.toThrow('移除本次图片');expect((await f.d.get('tasks',f.task.id))?.proof).toEqual(f.task.proof);
});
it('用户移除本次图片后，确认同账号空附件才能取消准备并恢复旧稿',async()=>{
 const f=await fixture();(chrome.scripting.executeScript as any)=vi.fn(async()=>[{result:{plain:true,mediaCount:0,text:'恢复正文',accountKey:'owner'}}]);const {cancelZsxqPreparationForRestore}=await import('../src/platforms/zsxq-backup');const backup={id:'backup',taskId:f.task.id,targetId:'12345',tabId:7,accountKey:'owner'} as any;expect(await cancelZsxqPreparationForRestore(f.task,backup)).toMatchObject({status:'failed',autoRun:false,error:{code:'CANCELLED_FOR_RESTORE'}});expect((await f.d.get('tasks',f.task.id))?.proof).toBeUndefined();expect(f.reload).not.toHaveBeenCalled();
});

it('刷新返回已持久备份的同账号纯文本旧稿时，核对摘要后替换并恢复本任务',async()=>{const f=await fixture('backup');await readyZsxqPublication(f.task,f.verify,f.refill);expect(f.refill).toHaveBeenCalledOnce();expect((await f.d.get('tasks',f.task.id))?.editorRecovery?.phase).toBe('verified');expect((await f.d.get('backups','original'))?.text).toBe('原生旧稿');});
it('刷新返回无备份的其他正文时保留现场，不替换或交付图片',async()=>{const f=await fixture('foreign');await expect(readyZsxqPublication(f.task,f.verify,f.refill)).rejects.toThrow('其他正文');expect(f.refill).not.toHaveBeenCalled();expect((await f.d.get('tasks',f.task.id))?.editorRecovery?.phase).toBe('interrupted');});
