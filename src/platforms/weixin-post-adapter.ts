import {editorBody} from '../core/post-limits';
import {FillAdapter} from './fill-adapter';
import {createTaskTab} from './task-tab';
import {fillProfile} from './fill-profiles';
import {nativeFillEditor} from './native-fill-editor';
import {db,updateTask} from '../core/repository';
import {safeUrl} from '../core/model';
import {SyncError} from '../core/protocol';
import type {ContentDraft,PublishTask} from '../core/model';
/** Use the observed normal creation menu; carry its native destination in memory,
 * without copying session data into storage, logs or extension messages. */
export function openWeixinPost(){
 if(location.origin!=='https://mp.weixin.qq.com')throw new Error('公众号页面来源变化');
 if(document.querySelector('.share-text__input .ProseMirror[contenteditable=true]'))return true;
 const entries=[...document.querySelectorAll<HTMLElement>('.new-creation__menu-item')].filter(e=>e.querySelector('.new-creation__menu-title')?.textContent?.trim()==='贴图');
 if(entries.length!==1)return false;
 const original=window.open;let destination:string|undefined;
 window.open=function(url){const value=new URL(String(url),location.href);if(value.origin!=='https://mp.weixin.qq.com')throw new Error('公众号入口来源变化');destination=value.href;return null;};
 try{entries[0]!.click();}finally{window.open=original;}
 if(destination)location.assign(destination);return false;
}
export class WeixinPostAdapter extends FillAdapter {
 constructor(){super('weixin');}
 override validate(draft:ContentDraft){
  super.validate(draft);if(draft.type!=='post')throw new SyncError('UNSUPPORTED_TYPE','贴图适配器只处理动态');
  if(draft.media.length>20)throw new SyncError('IMAGE_REQUIRED','公众号贴图最多20张图片；零附件使用平台自动封面');
  if(draft.title.length>20)throw new SyncError('TITLE_TOO_LONG','公众号贴图标题最多20字');
  if(editorBody(draft,true).length>1000)throw new SyncError('BODY_TOO_LONG','公众号贴图描述与标签最多1000字');
 }
 /** Older fills captured a temporary preview. Reconcile only after exact decoded
  * pixel, dimensions, order, title and body checks against the frozen local files. */
 override async verifyDraft(task:PublishTask,readOnly=false){
  try{return await super.verifyDraft(task);}catch(error){
   if(!(error instanceof SyncError)||error.code!=='FILL_UNCONFIRMED'||!task.tabId||task.publicationAttemptedAt||task.snapshot.type!=='post'||!task.snapshot.media.length||task.proof?.uploadedMediaIds?.length!==task.snapshot.media.length)throw error;
   const profile=fillProfile('weixin','post')!;const payload={title:task.snapshot.title,text:editorBody(task.snapshot,true),video:false,expectedImages:task.snapshot.media.length};
   const read=async(pixels:boolean)=>{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'MAIN',func:nativeFillEditor,args:[profile,'read',{...payload,verifyImagePixels:pixels}]});return result[0]?.result;};
   const initial=await read(false);if(!initial?.remoteMediaReady||!initial.editorFound||initial.title!==task.snapshot.title||!initial.bodyMatched||initial.uploadBusy||initial.imageItems!==task.snapshot.media.length||initial.images.length!==task.snapshot.media.length)throw error;
   const actual=await read(true);if(!actual||actual.images.length!==task.snapshot.media.length)throw error;
   const expected:string[]=[];
   for(const ref of task.snapshot.media){if(ref.kind!=='image'||!task.proof.uploadedMediaIds!.includes(ref.id))throw error;const media=await(await db()).get('media',ref.id);if(!media)throw error;const image=await createImageBitmap(media.blob);if(image.width*image.height>32_000_000){image.close();throw error;}const canvas=new OffscreenCanvas(image.width,image.height);const ctx=canvas.getContext('2d');if(!ctx){image.close();throw error;}ctx.drawImage(image,0,0);image.close();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');expected.push(`pixels-sha256:${canvas.width}:${canvas.height}:${digest}`);}
   if(expected.some((value,index)=>value!==actual.images[index]))throw error;
   const final=await read(false);if(!final?.bodyMatched||final.title!==task.snapshot.title||final.images.join('|')!==initial.images.join('|')||final.uploadBusy||final.imageItems!==task.snapshot.media.length)throw error;
   const hashes=await Promise.all(final.images.map(async id=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)))].map(x=>x.toString(16).padStart(2,'0')).join('')));
   if(!readOnly)await updateTask(task.id,[task.status],{proof:{...task.proof,mediaHashes:hashes}});
   return {kind:'editor_readback' as const,checkedAt:Date.now(),title:final.title,bodyMatched:true,mediaMatched:true,mediaCount:final.images.length,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:readOnly?'正式图片与本地原图尺寸、解码像素及顺序完全一致；只读核对，未改记录、上传或发表':'正式图片与本地原图尺寸、解码像素及顺序完全一致；只更新媒体证明，未上传或发表'};
  }
 }
 override async recoverEditor(task:PublishTask){if(task.publicationAttemptedAt)throw new SyncError('UNSAFE_RECOVERY','已经尝试发表，仅核对结果',false);const evidence=await this.verifyDraft(task);const latest=await(await db()).get('tasks',task.id);return {proof:latest!.proof!,evidence};}
 override async openEditor(task:PublishTask){
  if(!await chrome.permissions.contains({origins:['https://mp.weixin.qq.com/*']}))throw new SyncError('PERMISSION_REQUIRED','请先连接公众号');
  let tab:chrome.tabs.Tab|undefined;if(task.tabId){try{tab=await chrome.tabs.get(task.tabId);}catch{}}
  if(tab?.id&&(!tab.url||new URL(tab.url).origin!=='https://mp.weixin.qq.com'))throw new SyncError('PAGE_CHANGED','公众号任务页已变化',false);
  tab??=await createTaskTab(task,'https://mp.weixin.qq.com/');if(!tab.id)throw new SyncError('TAB_UNAVAILABLE','无法打开公众号贴图页');
  for(let i=0;i<180;i++){const current=await chrome.tabs.get(tab.id);if(current.url?.startsWith('https://mp.weixin.qq.com/')){const r=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:openWeixinPost}).catch(()=>[]);if(r[0]?.result)return tab.id;}await new Promise(r=>setTimeout(r,250));}
  throw new SyncError('EDITOR_UNAVAILABLE','公众号贴图页未就绪，请检查登录或验证');
 }
}
