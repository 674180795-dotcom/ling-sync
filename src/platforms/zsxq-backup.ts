import {editorBody} from '../core/post-limits';
import type {DraftBackup,PublishTask} from '../core/model';
import {db,updateTask} from '../core/repository';
import {workspaceChanged} from '../core/changes';
import {SyncError} from '../core/protocol';

/** Visible composer only. Avatar paths identify the displayed account; signed query data is discarded. */
export async function nativeZsxqBackup(action:'inspect'|'replace'|'restore'|'close'|'open'|'closed',expected:{targetId:string;accountKey?:string;text?:string;replacement?:string}){
 if(location.origin!=='https://wx.zsxq.com'||location.pathname!=='/group/'+expected.targetId)throw new Error('目标星球变化，原稿备份保留');
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const panels=[...document.querySelectorAll<HTMLElement>('.create-topic-panel')].filter(visible);
 if(action==='closed')return {text:'',plain:false,accountKey:'',mediaCount:0,editorFound:panels.length>0};
 if(action==='open'&&!panels.length){const entries=[...document.querySelectorAll<HTMLElement>('.post-topic-head')].filter(visible);if(entries.length!==1)throw new Error('原稿入口不唯一');entries[0]!.click();return {text:'',plain:false,accountKey:'',mediaCount:0,editorFound:false};}
 if(panels.length!==1)throw new Error('原稿编辑器不唯一或已关闭');
 const panel=panels[0]!,editors=[...panel.querySelectorAll<HTMLElement>('.ql-editor[contenteditable=true]')].filter(visible);
 if(editors.length!==1)throw new Error('原稿字段不唯一');const body=editors[0]!;
 const path=(image:HTMLImageElement|null)=>{try{const u=new URL(image?.src||'');return u.protocol==='https:'?u.origin+u.pathname:'';}catch{return '';}};
 const account=path(document.querySelector<HTMLImageElement>('.user-container img'));
 const avatar=path(panel.querySelector<HTMLImageElement>('.content-container > .avatar'));
 const accountKey=account&&account===avatar?account:'';
 if(expected.accountKey&&accountKey!==expected.accountKey)throw new Error('当前账号已变化，原稿备份保留');
 const read=()=>{const copy=body.cloneNode(true) as HTMLElement;copy.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));return [...copy.children].length?[...body.children].map(e=>e.childNodes.length===1&&e.firstChild?.nodeName==='BR'?'':(()=>{const p=e.cloneNode(true) as HTMLElement;p.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));return p.textContent||'';})()).join('\n'):copy.textContent||'';};
 const mediaCount=Math.max(panel.querySelectorAll('.image-list-container .image-item,.file-list-container > *,video').length,[...panel.querySelectorAll<HTMLInputElement>('input[type=file]')].reduce((n,e)=>n+(e.files?.length||0),0));
 const plain=!!accountKey&&!mediaCount&&![...body.querySelectorAll('*')].some(e=>!['P','DIV','BR'].includes(e.tagName)||e.hasAttribute('style')||e.hasAttribute('class')||e.getAttribute('contenteditable')==='false')&&!panel.querySelector('input:checked');
 const text=read();
 if(action==='replace'||action==='restore'){
   if(!plain)throw new Error('旧稿包含附件或复杂格式，保留原稿');
   if(text!==(expected.text||''))throw new Error('原稿已变化，停止替换');
   body.focus();const selection=body.ownerDocument.getSelection(),range=body.ownerDocument.createRange();range.selectNodeContents(body);selection?.removeAllRanges();selection?.addRange(range);
   if(!body.ownerDocument.execCommand(expected.replacement?'insertText':'delete',false,expected.replacement||''))throw new Error('原生编辑器未接受替换，备份仍保留');
   await Promise.resolve();await Promise.resolve();
   if(read()!==(expected.replacement||''))throw new Error('原稿替换尚未核对，备份仍保留');
 }
 if(action==='close'){const close=panel.querySelector<HTMLElement>('.close-icon');if(!close||!visible(close))throw new Error('无法核对原稿保存入口');close.click();}
 return {text:read(),plain,accountKey,mediaCount,editorFound:true};
}
async function native(tabId:number,action:Parameters<typeof nativeZsxqBackup>[0],expected:Parameters<typeof nativeZsxqBackup>[1]){
 if(!await chrome.permissions.contains({origins:['https://wx.zsxq.com/*']}))throw new SyncError('PERMISSION_REQUIRED','知识星球权限已取消，原稿备份仍在');
 const r=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeZsxqBackup,args:[action,expected]});
 if(!r[0]?.result)throw new SyncError('BACKUP_PENDING','原稿编辑器未响应，备份仍在',false);return r[0].result;
}
export async function backupBeforeFill(task:PublishTask,tabId:number){
 const d=await db();const backups=(await d.getAll('backups')).filter(b=>b.targetId===task.targetId);
 const observed=await native(tabId,'inspect',{targetId:task.targetId});
 const text=editorBody(task.snapshot,false);
 const normal=(v:string)=>v.replace(/\n{3,}/g,'\n\n').trim();
 if(!observed.text.trim()||normal(observed.text)===normal(text))return;
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(observed.text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const eligible=observed.plain&&!observed.mediaCount&&!!observed.accountKey;
 const matches=(backup:DraftBackup)=>eligible&&backup.accountKey===observed.accountKey&&backup.text===observed.text&&backup.digest===digest;
 const outstanding=backups.find(b=>b.state!=='restored'&&matches(b));
 // A pending record describes its own original draft, not every future draft in
 // the same star. Only exact persisted provenance can isolate another pending record.
 if(backups.some(b=>b.state!=='restored')&&!outstanding&&!backups.some(b=>b.state==='restored'&&matches(b)))throw new SyncError('BACKUP_PENDING','有待核对的知识星球原稿备份；本次保留平台内容，不再次替换。',true);
 if(task.operation!=='publish'||!eligible)throw new SyncError('EDITOR_OCCUPIED',task.operation==='publish'?'知识星球旧稿含附件、格式或账号尚未确认，已保留原稿，本次跳过。':'知识星球已有旧稿；当前仅填写，已保留原稿，本次跳过。');
 await new Promise(r=>setTimeout(r,250));
 const again=await native(tabId,'inspect',{targetId:task.targetId,accountKey:observed.accountKey}).catch(()=>undefined);
 if(!again?.plain||again.mediaCount||again.accountKey!==observed.accountKey||again.text!==observed.text)throw new SyncError('BACKUP_PENDING','原稿尚未通过稳定核对，本次未替换。',false);
 if(outstanding){
  // Reconcile only this exact original; other records and publication states stay intact.
  await d.put('backups',{...outstanding,state:'restored',updatedAt:Date.now(),note:'只读核对平台原稿与备份完整一致；未修改旧任务发布状态。'});workspaceChanged();
 }
 const now=Date.now();const backup:DraftBackup={id:crypto.randomUUID(),taskId:task.id,targetId:task.targetId,tabId,url:'https://wx.zsxq.com/group/'+task.targetId,accountKey:observed.accountKey,text:observed.text,digest,createdAt:now,updatedAt:now,state:'captured'};
 await d.put('backups',backup);
 const stored=await d.get('backups',backup.id);if(stored?.digest!==digest||stored.text!==observed.text)throw new SyncError('BACKUP_FAILED','旧稿备份未完整保存，本次停止');
 await d.put('backups',{...backup,state:'replacing',updatedAt:Date.now()});workspaceChanged();
 try{await native(tabId,'replace',{targetId:task.targetId,accountKey:backup.accountKey,text:backup.text,replacement:''});}
 catch(error){await d.put('backups',{...backup,state:'restore_pending',updatedAt:Date.now(),note:'旧稿替换未完成，请核对原页后恢复。'});workspaceChanged();throw new SyncError('BACKUP_PENDING',error instanceof Error?error.message:'原稿备份待恢复',false);}
}
/** Explicit restore cancels an unsubmitted preparation. Uploaded media must first
 * be removed by the user from the owned page; this function never removes files. */
export async function cancelZsxqPreparationForRestore(task:PublishTask,backup:DraftBackup){
 if(task.platform!=='zsxq'||backup.taskId!==task.id||task.targetId!==backup.targetId||task.publicationAttemptedAt||!['ready_for_confirmation','unknown','failed'].includes(task.status))return task;
 if(task.proof?.uploadedMediaIds?.length){
  const read=await native(backup.tabId,'inspect',{targetId:backup.targetId,accountKey:backup.accountKey});
  if(!read.plain||read.mediaCount||read.text&&read.text!==editorBody(task.snapshot,false))throw new SyncError('BACKUP_PENDING','请先在原任务页移除本次图片并核对正文，再恢复原草稿；不会删除图片或重新发布。',false);
 }
 return updateTask(task.id,[task.status],{status:'failed',autoRun:false,progress:'已取消尚未提交的发布，恢复原草稿',proof:undefined,error:{code:'CANCELLED_FOR_RESTORE',message:'用户选择恢复原草稿，未执行发布',retrySafe:false}});
}
export async function restoreZsxqBackup(task:PublishTask,backup:DraftBackup){
 if(backup.taskId!==task.id||backup.targetId!==task.targetId||task.platform!=='zsxq')throw new SyncError('BACKUP_TARGET','备份与任务目标不一致',false);
 if(backup.state==='restored')return;
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(backup.text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(digest!==backup.digest)throw new SyncError('BACKUP_DAMAGED','原稿备份校验不一致，停止恢复',false);
 const published=task.status==='published';const abandoned=task.status==='failed'&&!task.publicationAttemptedAt&&!task.proof?.uploadedMediaIds?.length;
 if(!published&&!abandoned)throw new SyncError('BACKUP_PENDING','发布结果或附件尚未确认，请先核对平台；不会重新发布。',false);
 const d=await db();const target={targetId:backup.targetId,accountKey:backup.accountKey};
 let activated=false;if(task.source){const source=await chrome.tabs.get(task.source.tabId).catch(()=>undefined),tab=await chrome.tabs.get(backup.tabId).catch(()=>undefined);if(source?.active&&source.windowId===task.source.windowId&&tab?.windowId===source.windowId){await chrome.tabs.update(backup.tabId,{active:true});activated=true;}}
 try{
   const tab=await chrome.tabs.get(backup.tabId);if(tab.url&&new URL(tab.url).pathname!=='/group/'+backup.targetId){if(!published||!task.publicationResult||new URL(tab.url).origin+new URL(tab.url).pathname!==new URL(task.publicationResult.url).origin+new URL(task.publicationResult.url).pathname)throw new Error('原页已离开任务结果，请在目标星球恢复原稿');await chrome.tabs.update(backup.tabId,{url:backup.url});}
   let opened=false;for(let i=0;i<80;i++){try{await native(backup.tabId,'open',target);if((await native(backup.tabId,'inspect',target)).editorFound){opened=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}if(!opened)throw new Error('原稿编辑器尚未就绪，备份仍保留');
   const observed=await native(backup.tabId,'inspect',target);
   const owned=editorBody(task.snapshot,false);
   if(observed.text!==backup.text){if(observed.text&&(!abandoned||observed.text!==owned))throw new Error('原编辑器已有其他内容，停止恢复，备份仍保留');await native(backup.tabId,'restore',{...target,text:observed.text,replacement:backup.text});}
   await native(backup.tabId,'close',target);
   let closed=false;for(let i=0;i<40;i++){if(!(await native(backup.tabId,'closed',target)).editorFound){closed=true;break;}await new Promise(r=>setTimeout(r,250));}if(!closed)throw new Error('原稿编辑器未关闭，尚不能确认平台已保留原稿，备份仍在');
   let restored=false,stable=0;
   for(let i=0;i<40;i++){await native(backup.tabId,'open',target);const read=await native(backup.tabId,'inspect',target).catch(()=>undefined);stable=read?.plain&&read.text===backup.text?stable+1:0;if(stable>=4){restored=true;break;}await new Promise(r=>setTimeout(r,250));}
   if(!restored)throw new Error('原稿重新打开后尚未核对，备份仍保留');
   await d.put('backups',{...backup,state:'restored',updatedAt:Date.now(),note:'原稿已恢复并重新打开核对。'});workspaceChanged();
 }catch(error){await d.put('backups',{...backup,state:'restore_pending',updatedAt:Date.now(),note:error instanceof Error?error.message:'原稿待恢复'});workspaceChanged();throw new SyncError('BACKUP_PENDING',error instanceof Error?error.message:'原稿待恢复',false);}
 finally{if(activated&&task.source){const active=(await chrome.tabs.query({windowId:task.source.windowId,active:true}))[0];if(active?.id===backup.tabId)await chrome.tabs.update(task.source.tabId,{active:true}).catch(()=>{});}}
}
