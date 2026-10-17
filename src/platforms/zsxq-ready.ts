import type {PublishTask,Evidence} from '../core/model';
import {editorBody} from '../core/post-limits';
import {db,updateTask,log} from '../core/repository';
import {SyncError} from '../core/protocol';
import {publicationProbe} from './publication';
import {nativeZsxqBackup} from './zsxq-backup';
import {nativeFillEditor} from './native-fill-editor';
import {fillProfile} from './fill-profiles';
const pause=()=>new Promise(r=>setTimeout(r,250));
const normal=(v:string)=>v.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
const digest=async(v:BufferSource)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',v))].map(n=>n.toString(16).padStart(2,'0')).join('');
/** Preparation only. The journal is persisted before refreshing; no submit here. */
export async function readyZsxqPublication(task:PublishTask,verify:()=>Promise<Evidence>,refill?:(current:PublishTask)=>Promise<void>){
 if(task.publicationAttemptedAt)throw new SyncError('ZSXQ_EDITOR_STALE','知识星球发布控件仍未就绪；已有提交标记，只核对结果',false);
 await verify();
 const probe=async()=>{try{return await publicationProbe(task);}catch(error){if(error instanceof Error&&/平台发布条件未满足|发布控件缺失/.test(error.message))return;throw error;}};
 const ready=await probe();if(ready)return ready;
 const stale=()=>new SyncError('ZSXQ_EDITOR_STALE','正文已填写，但知识星球发布控件仍未就绪。恢复仅限一次且须核对原稿归属；尚未提交。',false);
 if(!task.tabId||task.publicationAttemptedAt)throw stale();
 const native=async(action:Parameters<typeof nativeZsxqBackup>[0],accountKey?:string)=>{const response=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'MAIN',func:nativeZsxqBackup,args:[action,{targetId:task.targetId,...(accountKey?{accountKey}:{})}]});if(!response[0]?.result)throw stale();return response[0].result;};
 const before=await native('inspect');const text=editorBody(task.snapshot,false);
 if(!before.accountKey||normal(before.text)!==normal(text))throw stale();
 const hasMedia=!!task.snapshot.media.length;
 if(hasMedia&&!refill||!hasMedia&&!before.plain)throw stale();
 const d=await db();let current=await d.get('tasks',task.id);
 if(!current||current.publicationAttemptedAt||current.editorRefreshAttemptedAt||current.editorRecovery)throw stale();
 if(hasMedia){
  if(!task.proof||task.proof.uploadedMediaIds?.length!==task.snapshot.media.length||task.proof.mediaHashes.length!==task.snapshot.media.length)throw stale();
  for(const ref of task.snapshot.media){const stored=await d.get('media',ref.id);if(ref.kind!=='image'||!task.proof.uploadedMediaIds.includes(ref.id)||!stored||stored.blob.size!==ref.bytes)throw stale();}
 }
 const reopen=async()=>{let stamp='',stable=0;for(let i=0;i<60;i++){try{await native('open');const read=await native('inspect',before.accountKey);if(read.editorFound){const next=JSON.stringify([read.text,read.mediaCount,read.accountKey]);stable=next===stamp?stable+1:1;stamp=next;if(stable>=4)return read;}}catch(error){if(error instanceof Error&&/账号已变化|目标星球变化/.test(error.message))throw new SyncError('EDITOR_OCCUPIED',error.message,false);}await pause();}throw stale();};
 // Plain text retains the previously verified native persistence check.
 if(!hasMedia){await native('close',before.accountKey);let closed=false;for(let i=0;i<20;i++){if(!(await native('closed')).editorFound){closed=true;break;}await pause();}if(!closed)throw stale();const reopened=await reopen();if(!reopened.plain||normal(reopened.text)!==normal(before.text))throw stale();await verify();const guard=await probe();if(guard)return guard;}
 const marker=async()=>{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'MAIN',func:()=>({epoch:performance.timeOrigin,origin:location.origin,path:location.pathname,ready:document.readyState})});return result[0]?.result;};
 const oldDocument=await marker();if(!oldDocument||oldDocument.origin!=='https://wx.zsxq.com'||oldDocument.path!=='/group/'+task.targetId)throw stale();
 const journal={phase:'marked' as const,accountKey:before.accountKey,targetId:task.targetId,proof:structuredClone(task.proof||{bodyDigest:'',mediaHashes:[]}),startedAt:Date.now()};
 current=await updateTask(task.id,[current.status],{editorRefreshAttemptedAt:Date.now(),editorRecovery:journal,progress:'已保存恢复记录，正在重开失效的知识星球编辑器'});
 try{
  if(hasMedia)await native('close',before.accountKey);
  await chrome.tabs.reload(task.tabId);
  let changed=false;for(let i=0;i<80;i++){const next=await marker().catch(()=>undefined);if(next&&next.epoch!==oldDocument.epoch){if(next.origin!=='https://wx.zsxq.com'||next.path!=='/group/'+task.targetId)throw new SyncError('PAGE_CHANGED','刷新后离开目标星球，停止准备',false);if(next.ready!=='loading'){changed=true;break;}}await pause();}if(!changed)throw stale();
  current=await updateTask(task.id,[current.status],{editorRecovery:{...journal,phase:'reloaded'}});
  let reopened=await reopen();if(normal(reopened.text)&&normal(reopened.text)!==normal(text)){
   const backup=(await d.getAll('backups')).find(b=>b.taskId===task.id&&b.targetId===task.targetId&&b.accountKey===before.accountKey&&b.state!=='restored'&&b.text===reopened.text);
   if(!reopened.plain||reopened.mediaCount||!backup||backup.digest!==await digest(new TextEncoder().encode(backup.text)))throw new SyncError('EDITOR_OCCUPIED','刷新后恢复了其他正文，已保留原稿，停止替换',false);
   const result=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'MAIN',func:nativeZsxqBackup,args:['replace',{targetId:task.targetId,accountKey:before.accountKey,text:backup.text,replacement:''}]});if(!result[0]?.result)throw stale();reopened=await native('inspect',before.accountKey);if(reopened.text||reopened.mediaCount)throw stale();
  }
  if(hasMedia){
   const profile=fillProfile('zsxq','post')!;const payload={targetId:task.targetId,title:task.snapshot.title,text,video:false,expectedImages:task.snapshot.media.length};
   const inspect=async(bytes=false)=>{const res=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'MAIN',func:nativeFillEditor,args:[profile,'read',{...payload,verifyImageBytes:bytes},true]});const r=res[0]?.result;if(!r||r.error||!r.editorFound||r.uploadBusy)throw stale();return r;};
   let stable='';let samples=0;for(let i=0;i<24;i++){const read=await inspect();const stamp=JSON.stringify(read.images);samples=stamp===stable?samples+1:1;stable=stamp;if(samples>=4)break;await pause();}if(samples<4)throw stale();
   const files=await inspect(true);const count=files.images.length;
   if(count>task.snapshot.media.length||reopened.mediaCount>count)throw new SyncError('MEDIA_IDENTITY','刷新后出现额外或未完成附件，停止恢复，禁止重传',false);
   for(let i=0;i<count;i++){const stored=await d.get('media',task.snapshot.media[i]!.id);if(!stored||!/^((content|data|blob)-sha256):[a-f0-9]{64}$/.test(files.images[i]!)||files.images[i]!.split(':').at(-1)!==await digest(await stored.blob.arrayBuffer()))throw new SyncError('MEDIA_IDENTITY','刷新后图片字节或顺序不属于本任务，停止恢复',false);}
   const read=await inspect();if(read.images.length!==count)throw stale();
   const mediaHashes=await Promise.all(read.images.map(v=>digest(new TextEncoder().encode(v))));
   current=await updateTask(task.id,[current.status],{status:'preparing',editorRecovery:{...journal,phase:'refilling'},proof:{bodyDigest:await digest(new TextEncoder().encode(read.body)),mediaHashes,uploadedMediaIds:task.snapshot.media.slice(0,count).map(m=>m.id)},progress:'原稿归属已核对，正在恢复文字及缺失图片'});
   await refill!(current);current=await updateTask(task.id,['preparing'],{status:'ready_for_confirmation'});
  }else if(!reopened.plain||normal(reopened.text)!==normal(text))throw stale();
  await verify();const guard=await probe();if(!guard)throw stale();
  await updateTask(task.id,[current.status],{editorRecovery:{...journal,phase:'verified'},progress:'重开后文字、图片及发送按钮已核对，尚未提交'});
  await log('zsxq_editor_rebuilt','原账号与目标不变，失效编辑器已恢复一次；未提交',task.id);return guard;
 }catch(error){await updateTask(task.id,[current.status],{...(current.status==='preparing'?{status:'ready_for_confirmation' as const}:{}),editorRecovery:{...journal,phase:'interrupted'},autoRun:false,progress:'编辑器恢复未完成，保留证据，禁止再次刷新或重传'}).catch(()=>{});throw error;}
}
