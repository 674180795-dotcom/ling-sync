import {editorBody} from '../core/post-limits';
import {FillAdapter} from './fill-adapter';
import {createTaskTab} from './task-tab';
import {type ContentDraft,type PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';
import {backupBeforeFill} from './zsxq-backup';
import {db,updateTask} from '../core/repository';
import {nativeZsxqBackup} from './zsxq-backup';
import {readyZsxqPublication} from './zsxq-ready';
/** Normal composer opening, separate from the verified long-article adapter. */
export function openZsxqComposer(groupId:string){
 if(location.origin!=='https://wx.zsxq.com'||location.pathname!=='/group/'+groupId)throw new Error('目标星球变化');
 if(document.querySelector('.create-topic-panel .ql-editor[contenteditable="true"]'))return true;
 if(document.querySelector('.create-topic-panel'))return false;
 const entries=[...document.querySelectorAll<HTMLElement>('.post-topic-head')].filter(e=>e.getClientRects().length);
 if(entries.length!==1)return false;entries[0]!.click();return false;
}
export class ZsxqPostAdapter extends FillAdapter {
 constructor(){super('zsxq');}
 private readonly foreground=new Set<string>();
 private async activate(task:PublishTask,tabId:number){if(task.source){const source=await chrome.tabs.get(task.source.tabId).catch(()=>undefined);if(source?.active){await chrome.tabs.update(tabId,{active:true});this.foreground.add(task.id);}}}
 private async returnToSource(task:PublishTask){if(!this.foreground.delete(task.id)||!task.source||!task.tabId)return;const active=(await chrome.tabs.query({windowId:task.source.windowId,active:true}))[0];if(active?.id===task.tabId)await chrome.tabs.update(task.source.tabId,{active:true}).catch(()=>{});}
 override async preparePublication(task:PublishTask){await this.activate(task,task.tabId!);try{return await readyZsxqPublication(task,async()=>{const latest=await(await db()).get('tasks',task.id);return this.verifyDraft(latest||task);},async current=>{const observed=await super.fillEditor(current,current.tabId!);const latest=await(await db()).get('tasks',current.id);await updateTask(current.id,[current.status],{proof:{...latest!.proof!,bodyDigest:observed.bodyDigest,mediaHashes:observed.mediaHashes}});});}finally{await this.returnToSource(task);}}
 override async fillEditor(task:PublishTask,tabId:number){await backupBeforeFill(task,tabId);return super.fillEditor(task,tabId);}
 override validate(draft:ContentDraft,targetId=''){
  super.validate(draft);if(!/^\d{5,30}$/.test(targetId))throw new SyncError('TARGET_REQUIRED','请明确选择目标星球');
  if(draft.type!=='post')throw new SyncError('UNSUPPORTED_TYPE','此适配器仅用于动态');
  const text=editorBody(draft,false);
  if(text.length>10000)throw new SyncError('BODY_TOO_LONG','知识星球动态最多10000个字符');
  if(draft.media.length>9)throw new SyncError('MEDIA_LIMIT','当前动态适配器一次最多9张图片（适配器限制）');
 }
 override async openEditor(task:PublishTask){
  if(!await chrome.permissions.contains({origins:['https://wx.zsxq.com/*']}))throw new SyncError('PERMISSION_REQUIRED','请先连接知识星球');
  const expected='https://wx.zsxq.com/group/'+task.targetId;let tab:chrome.tabs.Tab|undefined;
  if(task.tabId){try{tab=await chrome.tabs.get(task.tabId);}catch{}}
  if(tab?.id&&(!tab.url||new URL(tab.url).origin!=='https://wx.zsxq.com'||new URL(tab.url).pathname!=='/group/'+task.targetId))throw new SyncError('PAGE_CHANGED','任务页离开目标星球，停止填写',false);
  if(!tab?.id)tab=await createTaskTab(task,expected);
  if(!tab.id)throw new SyncError('TAB_UNAVAILABLE','无法打开目标星球');
  await this.activate(task,tab.id);
  for(let i=0;i<90;i++){
   const current=await chrome.tabs.get(tab.id);
   if(current.url&&new URL(current.url).origin==='https://wx.zsxq.com'&&new URL(current.url).pathname==='/group/'+task.targetId){const r=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:openZsxqComposer,args:[task.targetId]}).catch(()=>[]);if(r[0]?.result){let stamp='',stable=0;for(let j=0;j<40;j++){const read=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:nativeZsxqBackup,args:['inspect',{targetId:task.targetId}]});const state=read[0]?.result;if(state?.editorFound&&state.accountKey){const next=JSON.stringify([state.text,state.mediaCount,state.accountKey]);stable=next===stamp?stable+1:1;stamp=next;if(stable>=5)return tab.id;}else stable=0;await new Promise(r=>setTimeout(r,250));}throw new SyncError('EDITOR_UNAVAILABLE','知识星球原生旧稿尚未稳定，未填写或上传');}}else if(current.status==='complete')throw new SyncError('PAGE_CHANGED','目标星球变化，尚未交付内容',true);
   await new Promise(r=>setTimeout(r,500));
  }
  throw new SyncError('EDITOR_UNAVAILABLE','目标星球动态编辑器未就绪，请检查登录或验证');
 }
}
