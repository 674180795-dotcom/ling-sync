import type {ContentType,PlatformId,PublishTask,Evidence} from '../core/model';
import {platformFor,platformOrigins,safeUrl} from '../core/model';
import {fillProfile} from './fill-profiles';
import {SyncError} from '../core/protocol';
import {nativeChannelsReceipt} from './channels-result';
import {updateTask} from '../core/repository';
import {editorBody} from '../core/post-limits';

export type PublicationProfile={platform:PlatformId;type:ContentType;scope:string;button:string;labels:string[]};
// Reference factory paths plus observed native composers. These are candidates,
// not proof of a successful public publication. Never use private publish APIs.
export const publicationProfiles:PublicationProfile[]=[
 {platform:'weixin',type:'post',scope:'body',button:'button.mass_send',labels:['发表']},
 {platform:'douyin',type:'post',scope:'body',button:'button',labels:['发布']},
 {platform:'kuaishou',type:'post',scope:'body',button:'button,[role="button"],div',labels:['发布']},
 {platform:'bilibili',type:'post',scope:'.bili-dyn-publishing',button:'button,.bili-dyn-publishing__action__btn,.bili-dyn-publishing__action.launcher',labels:['发布']},
 {platform:'xiaohongshu',type:'post',scope:'body',button:'button,[role="button"]',labels:['发布']},
 {platform:'xiaohongshu',type:'video',scope:'body',button:'button,[role="button"]',labels:['发布']},

 {platform:'zsxq',type:'post',scope:'.create-topic-panel',button:'.submit-btn',labels:['发布']},
 {platform:'jike',type:'post',scope:'[role="dialog"] form',button:'button',labels:['发送']},
 {platform:'x',type:'post',scope:'div[role="dialog"][aria-modal="true"]',button:'button[data-testid="tweetButton"]',labels:['Post','发帖']},
 {platform:'x',type:'video',scope:'div[role="dialog"][aria-modal="true"]',button:'button[data-testid="tweetButton"]',labels:['Post','发帖']},
 {platform:'douyin',type:'video',scope:'body',button:'button',labels:['发布']},
 {platform:'channels',type:'post',scope:'body',button:'button',labels:['发表']},
 {platform:'channels',type:'video',scope:'body',button:'button',labels:['发表']},
 {platform:'kuaishou',type:'video',scope:'body',button:'button,[role="button"],div',labels:['发布']},
 {platform:'bilibili',type:'video',scope:'body',button:'span.submit-add',labels:['立即投稿','投稿','提交稿件']},
];
export const publicationFor=(platform:PlatformId,type:ContentType)=>publicationProfiles.find(p=>p.platform===platform&&p.type===type);
// Saved cover proofs belong to older attempts. New tasks use the native text
// choice, including when the task already contains its own original images.
const publicationFields=(task:PublishTask)=>({...fillProfile(task.platform,task.snapshot.type)!,...(task.platform==='weixin'&&task.snapshot.type==='post'&&task.nativeCover?{nativeCover:true,coverProof:task.nativeCover}:{}),...(task.platform==='zsxq'&&task.snapshot.type==='post'?{expectedText:editorBody(task.snapshot,false)}:{})});

/** Bundled native interaction; probe has no side effects. Toasts must originate
 * outside the content editor and be new relative to the pre-click baseline. */
export async function nativePublication(profile:PublicationProfile,mode:'probe'|'submit'|'observe'|'receipt'|'stop',targetId:string,fields:{body:string;title?:string;scope:string;imagesSelector?:string;backgroundImagesSelector?:string;imageItemsSelector?:string;nativeCover?:boolean;coverProof?:PublishTask['nativeCover'];expectedText?:string},expectedGuard='',attemptKey='',reportErrors=false):Promise<{ready:boolean;notice:string;guard?:string;pending?:boolean;error?:string;generatedCover?:PublishTask['nativeCover']}>{
 try{
 const origins:Record<string,string>={weixin:'https://mp.weixin.qq.com',zsxq:'https://wx.zsxq.com',jike:'https://web.okjike.com',x:'https://x.com',douyin:'https://creator.douyin.com',channels:'https://channels.weixin.qq.com',kuaishou:'https://cp.kuaishou.com',bilibili:profile.type==='post'?'https://t.bilibili.com':'https://member.bilibili.com',xiaohongshu:'https://creator.xiaohongshu.com'};
 if(location.origin!==origins[profile.platform])throw new Error('发布页面来源变化');
 if(profile.platform==='zsxq'&&(mode==='probe'||mode==='submit')&&(!/^\d{5,30}$/.test(targetId)||location.pathname!=='/group/'+targetId))throw new Error('发布目标星球变化');
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const roots:Array<Document|ShadowRoot>=[];const collect=(r:Document|ShadowRoot,visited=new Set<Document|ShadowRoot>())=>{if(visited.has(r))return;visited.add(r);if(!roots.includes(r))roots.push(r);for(const e of r.querySelectorAll('*')){const elementClass=e.ownerDocument.defaultView?.HTMLElement;const shadow=e.shadowRoot||(profile.platform==='xiaohongshu'&&elementClass&&e instanceof elementClass&&typeof chrome!=='undefined'&&chrome.dom?.openOrClosedShadowRoot?chrome.dom.openOrClosedShadowRoot(e as HTMLElement):null);if(shadow)collect(shadow,visited);if(e.tagName==='IFRAME'){try{const frame=e as HTMLIFrameElement;if(frame.contentDocument&&frame.contentDocument.location.origin===location.origin)collect(frame.contentDocument,visited);}catch{}}}};
 collect(document);
 const all=<T extends Element>(selector:string)=>[...new Set(roots.flatMap(root=>[...root.querySelectorAll<T>(selector)]))];
 const failureText=/^(发布失败|发表失败|投稿失败|发送失败|请完成验证)(?:[，,：:！!。\s（(]|$)/;
 const outsideEditor=(e:Element):boolean=>{if(e.closest('[contenteditable="true"],textarea,input')||e.querySelector('[contenteditable="true"],textarea,input'))return false;const root=e.getRootNode();return !(root instanceof ShadowRoot)||outsideEditor(root.host);};
 const notices=()=>[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLElement>('[role="alert"],[role="status"],.ant-message-notice-content,.el-message,.message-toast,.toast,.ivu-message-notice-content,.weui-desktop-toast,.weui-desktop-dialog__title,.message-container,[class*="toast"],[class*="Toast"],.m-message'),...(profile.platform==='xiaohongshu'?[...r.querySelectorAll<HTMLElement>('div,p,span')].filter(e=>{const text=e.textContent?.trim()||'';return text.length<=1000&&failureText.test(text)&&![...e.children].some(child=>failureText.test(child.textContent?.trim()||''));}):[])]))].filter(e=>visible(e)&&outsideEditor(e)).map(e=>({element:e,text:e.textContent?.trim()||''}));
 // Weixin's generated-cover dialog is mounted inside the editor. Its image is
 // not an original attachment; the profile's background list owns those slots.
 const imageSelector=fields.imagesSelector||(profile.platform==='weixin'&&profile.type==='post'&&fields.backgroundImagesSelector?undefined:'img');
 const images=(scope:Element|ShadowRoot)=>imageSelector?[...scope.querySelectorAll<HTMLImageElement>(imageSelector)].filter(visible).map(i=>i.src):[];
 const mediaIdentity=(scope:Element|ShadowRoot)=>JSON.stringify({images:images(scope),backgroundImages:fields.backgroundImagesSelector?[...scope.querySelectorAll<HTMLElement>(fields.backgroundImagesSelector)].filter(visible).map(e=>getComputedStyle(e).backgroundImage):[],imageItems:fields.imageItemsSelector?scope.querySelectorAll(fields.imageItemsSelector).length:undefined});
 type Attempt={guard:string;baseline:Map<HTMLElement,string>;dialogs:Set<Element>;confirmed:Set<string>;confirmedButtons:Set<Element>;title:string;body:string;mediaIdentity:string;button:HTMLElement;notice?:string;observer?:MutationObserver;failure?:string;stopped?:boolean};
 const own=window as typeof window&{__lingSyncPublicationAttempts?:Map<string,Attempt>};
 const key=attemptKey||expectedGuard;
 const observe=async(state:Attempt,confirm:boolean):Promise<{ready:true;notice:string;pending?:boolean;generatedCover?:PublishTask['nativeCover']}>=>{
  if(state.stopped&&!state.notice)return {ready:true,notice:'',pending:true};
  if(state.failure)throw new Error(state.failure);
  if(state.notice){state.observer?.disconnect();return {ready:true,notice:state.notice};}
  const assertCurrentContent=()=>{
   collect(document);
   const bodies=all<HTMLElement>(fields.body).filter(visible),titles=fields.title?all<HTMLInputElement>(fields.title).filter(visible):[];
   if(bodies.length!==1||(bodies[0]!.innerText||bodies[0]!.textContent||'')!==state.body||fields.title&&(titles.length!==1||(titles[0]!.value||titles[0]!.textContent||'')!==state.title))throw new Error('发表确认前正文或标题已变化，停止发表');
   const editor=bodies[0]!,fieldRoot=editor.getRootNode(),mediaScope=fields.scope==='body'?(fieldRoot instanceof ShadowRoot?fieldRoot:editor.ownerDocument.body):editor.closest(fields.scope)||editor.parentElement!;
   if(!fields.nativeCover&&mediaIdentity(mediaScope)!==state.mediaIdentity)throw new Error('文字发表确认前原附件或顺序已变化，停止发表');
  };
  for(let round=0;round<3;round++){
   for(const n of notices())if(state.baseline.get(n.element)!==n.text){
    if(/^(发布成功|发表成功|投稿成功|发送成功|Your post was sent|Your post was sent\.)([！!。.]|$)/.test(n.text)){state.notice=n.text;return {ready:true,notice:n.text};}
    if(failureText.test(n.text))throw new Error('平台未确认发布：'+n.text);
   }
   if(profile.platform!=='weixin'||!confirm)break;
   collect(document);
   const dialogs=all<HTMLElement>('.weui-desktop-dialog,.weui-desktop-popover').filter(e=>visible(e)&&!state.dialogs.has(e));
   if(dialogs.some(e=>/扫码验证|身份验证|管理员确认|扫描二维码|安全验证/.test(e.innerText||e.textContent||'')))throw new Error('公众号要求扫码验证，请在原页完成后核对结果，不重复发表');
   const covers=dialogs.filter(e=>/已根据文字生成封面图片/.test(e.innerText||e.textContent||''));
   if(covers.length){
    if(covers.length!==1)throw new Error('公众号封面确认与本任务不符，请核对原页');
    const dialog=covers[0]!,images=[...dialog.querySelectorAll<HTMLImageElement>('img')].filter(visible);
    if(!fields.nativeCover){
     const stamp='native-text-publication';
     if(!state.confirmed.has(stamp)){const textChoices=[...dialog.querySelectorAll<HTMLButtonElement>('button')].filter(e=>visible(e)&&!e.disabled&&e.textContent?.trim()==='用文字发表');if(textChoices.length!==1)return {ready:true,notice:'',pending:true};assertCurrentContent();state.confirmed.add(stamp);state.confirmedButtons.add(textChoices[0]!);textChoices[0]!.click();}
    }else{
    const choices=[...dialog.querySelectorAll<HTMLButtonElement>('button')].filter(e=>visible(e)&&!e.disabled&&e.textContent?.trim()==='添加图片发表');
    if(images.length!==1||!images[0]!.complete||!images[0]!.naturalWidth||choices.length!==1)return {ready:true,notice:'',pending:true};
    const image=images[0]!,url=new URL(image.currentSrc||image.src,location.href);
    const nativePoster=['http:','https:'].includes(url.protocol)&&url.hostname==='320.wxapp.tc.qq.com'&&url.pathname==='/320/20304/stodownload';
    if(!(nativePoster||url.protocol==='https:'&&['mmbiz.qpic.cn','mmbiz.qlogo.cn','mp.weixin.qq.com'].includes(url.hostname)||url.protocol==='blob:'&&url.origin===location.origin||url.protocol==='data:'&&url.href.startsWith('data:image/')))throw new Error('平台生成封面来源无法核对');
    const sha=async(value:BufferSource)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(v=>v.toString(16).padStart(2,'0')).join('');
    const previewIdentity=url.protocol==='https:'&&!nativePoster?url.origin+url.pathname:'preview-sha256:'+await sha(new TextEncoder().encode(url.href));
    const generatedCover:NonNullable<PublishTask['nativeCover']>={previewIdentity,width:image.naturalWidth,height:image.naturalHeight,phase:'captured'};
    if(image.naturalWidth*image.naturalHeight<=32_000_000){try{const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');if(ctx){ctx.drawImage(image,0,0);generatedCover.pixels=await sha(ctx.getImageData(0,0,canvas.width,canvas.height).data);}}catch{}}
    // Return before the cover confirmation so the worker can persist its proof.
    if(!fields.coverProof){assertCurrentContent();return {ready:true,notice:'',pending:true,generatedCover};}
    const saved=fields.coverProof;
    if(saved.phase!=='confirming'||saved.previewIdentity!==previewIdentity||saved.width!==generatedCover.width||saved.height!==generatedCover.height||saved.pixels!==generatedCover.pixels)throw new Error('平台生成封面已变化或未持久记录，停止确认');
    const stamp='native-generated-cover:'+previewIdentity;
    if(!state.confirmed.has(stamp)){assertCurrentContent();state.confirmed.add(stamp);state.confirmedButtons.add(choices[0]!);choices[0]!.click();return {ready:true,notice:'',pending:true};}
    if(fields.backgroundImagesSelector){
     const previews=all<HTMLElement>(fields.backgroundImagesSelector).filter(visible);
     if(previews.length!==1)return {ready:true,notice:'',pending:true};
     const source=getComputedStyle(previews[0]!).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
     if(!source)return {ready:true,notice:'',pending:true};const formal=new URL(source,location.href);
     if(formal.protocol!=='https:'||formal.hostname!=='mmbiz.qpic.cn')return {ready:true,notice:'',pending:true};
     const remoteIdentity=formal.origin+formal.pathname;
     if(!saved.remoteIdentity)return {ready:true,notice:'',pending:true,generatedCover:{...saved,remoteIdentity}};
     if(saved.remoteIdentity!==remoteIdentity)throw new Error('生成封面正式资源已变化，停止发表');
    }
    // The platform keeps this guide visible underneath the final publish dialog.
    // A previously confirmed cover must not starve the next normal confirmation.
    }
   }
   const confirmations=dialogs.filter(e=>!covers.includes(e)&&(/发表方式|发表后|发表确认|群发通知|不群发|发表内容/.test(e.innerText||e.textContent||'')||!!state.title&&e.textContent?.includes(state.title)));
   let clicked=false;
   if(confirmations.length===1){const dialog=confirmations[0]!,text=dialog.innerText||dialog.textContent||'';const choices=[...dialog.querySelectorAll<HTMLButtonElement>('button.weui-desktop-btn_primary,button.mass_send')].filter(e=>visible(e)&&!e.disabled&&['发表','确认发表','继续发表'].includes(e.textContent?.trim()||''));
    if(choices.length===1){const stamp=text+'|'+choices[0]!.textContent;if(!state.confirmed.has(stamp)&&!state.confirmedButtons.has(choices[0]!)){if([...state.confirmed].filter(s=>!s.startsWith('native-generated-cover:')&&s!=='native-text-publication').length>=2)throw new Error('公众号发表确认流程变化，请核对原页，不重复发表');assertCurrentContent();state.confirmed.add(stamp);state.confirmedButtons.add(choices[0]!);choices[0]!.click();clicked=true;}}
   }
   if(!clicked)break;
  }
  return {ready:true,notice:'',pending:true};
 };
 if(mode==='observe'||mode==='receipt'||mode==='stop'){const state=own.__lingSyncPublicationAttempts?.get(key);if(!state||state.guard!==expectedGuard)throw new Error('发布观察状态已丢失，请只核对结果，不重复发布');if(mode==='stop'){state.observer?.disconnect();state.stopped=true;return {ready:true,notice:state.notice||'',pending:!state.notice};}return await observe(state,mode==='observe');}
 const scopes=[...new Set(roots.flatMap(r=>[...r.querySelectorAll(profile.scope)]))].filter(visible);
 const minimalScopes=scopes.filter(s=>!scopes.some(other=>other!==s&&s.contains(other)&&other.querySelector(fields.body)));
 const buttonRoots:Array<Element|ShadowRoot>=[...minimalScopes,...roots.filter((r):r is ShadowRoot=>r instanceof ShadowRoot&&!!r.host.closest(profile.scope))];
 const buttons=[...new Set(buttonRoots.flatMap(s=>[...s.querySelectorAll<HTMLElement>(profile.button)]))].filter(e=>visible(e)&&profile.labels.includes(e.textContent?.trim()||'')&&!e.querySelector(profile.button));
 if(buttons.length!==1)throw new Error('发布控件缺失或不唯一，尚未发布');
 const button=buttons[0]!;
 const editors=[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLElement>(fields.body)]))].filter(visible);if(editors.length!==1)throw new Error('发布正文控件不唯一');
 const editor=editors[0]!;const titles=fields.title?[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLInputElement>(fields.title!)]))].filter(visible):[];if(fields.title&&titles.length!==1)throw new Error('发布标题控件不唯一');
 const mediaScope=fields.scope==='body'?editor.ownerDocument.body:editor.closest(fields.scope)||editor.parentElement!;
 if(profile.platform==='zsxq'&&fields.expectedText!==undefined){const counter=mediaScope.querySelector('.text-range')?.textContent?.match(/^\s*\((\d+)\s*\/\s*10000\)\s*$/);if(counter&&Number(counter[1])!==fields.expectedText.replace(/\r\n?/g,'\n').trim().length)throw new Error('知识星球原生正文尚未更新，尚未发布');}
 const fieldRoot=editor.getRootNode() as Document|ShadowRoot;const stampScope=fields.scope==='body'&&fieldRoot instanceof ShadowRoot?fieldRoot:mediaScope;
 const circle=profile.platform==='jike'?mediaScope.querySelector('[name=topic] [class*="_contentNormal_"]')?.textContent?.trim()||'':'';if(profile.platform==='jike'&&circle!==targetId)throw new Error('即刻圈子已变化，尚未发布');
 if((button as HTMLButtonElement).disabled||button.getAttribute('aria-disabled')==='true'||button.classList.contains('disabled')||getComputedStyle(button).pointerEvents==='none'){
  if(profile.platform==='jike'){
   const text=(editor.innerText||editor.textContent||'').trim();
   const validations=[...mediaScope.querySelectorAll<HTMLElement>('[role="alert"],[aria-invalid="true"],.ant-form-item-explain-error,[class*="error"],[class*="Error"]')].filter(e=>visible(e)&&outsideEditor(e)).map(e=>e.textContent?.trim()||'').filter(Boolean);
   const busy=[...mediaScope.querySelectorAll<HTMLElement>('[role="progressbar"],[aria-busy="true"],[class*="loading"],[class*="Loading"],[class*="uploading"],[class*="Uploading"]')].some(visible);
   const localImages=[...mediaScope.querySelectorAll<HTMLImageElement>('img')].filter(e=>visible(e)&&/^(blob:|data:image\/)/.test(e.currentSrc||e.src)).length;
   throw new Error('即刻发送条件未满足：'+[text?'正文已显示 '+text.length+' 字':'正文为空',circle?'圈子：'+circle:'未选择圈子',...validations,busy?'图片或内容仍在处理':localImages?'仍有 '+localImages+' 张本地预览，远程上传状态未明确显示':'平台仍禁用发送，未显示具体校验提示'].join('；'));
  }
  throw new Error('平台发布条件未满足，尚未发布');
 }
 const stamp=JSON.stringify({circle,body:editor.innerText||editor.textContent||'',title:titles[0]?.value||titles[0]?.textContent||'',images:images(stampScope),backgroundImages:fields.backgroundImagesSelector?[...stampScope.querySelectorAll<HTMLElement>(fields.backgroundImagesSelector)].filter(visible).map(e=>getComputedStyle(e).backgroundImage):[],imageItems:fields.imageItemsSelector?stampScope.querySelectorAll(fields.imageItemsSelector).length:undefined,videos:[...stampScope.querySelectorAll<HTMLVideoElement>('video')].filter(visible).map(v=>v.currentSrc||v.src),conditions:profile.type==='video'?roots.flatMap(r=>[...r.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[type=radio],input[type=checkbox],select')].filter(e=>visible(e)||!!e.parentElement&&visible(e.parentElement)).map(e=>({type:e.tagName==='SELECT'?'select':(e as HTMLInputElement).type,name:e.getAttribute('name')||'',value:e.value,checked:(e as HTMLInputElement).checked}))):[]});
 const guard=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stamp)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 if(mode==='probe')return {ready:true,notice:'',guard};
 if(!expectedGuard||guard!==expectedGuard)throw new Error('发布前内容或附件发生变化，尚未发布');
 const prior=own.__lingSyncPublicationAttempts?.get(key);
 if(prior)throw new Error('本次发布已尝试，禁止再次点击');
 const state:Attempt={guard,baseline:new Map(notices().map(n=>[n.element,n.text])),dialogs:new Set(all<Element>('.weui-desktop-dialog,.weui-desktop-popover').filter(visible)),confirmed:new Set(),confirmedButtons:new Set(),title:titles[0]?.value||titles[0]?.textContent||'',body:editor.innerText||editor.textContent||'',mediaIdentity:mediaIdentity(stampScope),button};
 (own.__lingSyncPublicationAttempts??=new Map()).set(key,state);
 const capture=()=>{if(state.stopped)return;const known=roots.length;collect(document);for(const root of roots.slice(known))if(root instanceof ShadowRoot)state.observer?.observe(root,{childList:true,subtree:true,characterData:true});for(const n of notices())if(state.baseline.get(n.element)!==n.text){if(/^(发布成功|发表成功|投稿成功|发送成功|Your post was sent)([！!。.\s]|$)/.test(n.text)){state.notice=n.text;state.observer?.disconnect();}else if(failureText.test(n.text)){state.failure='平台未确认发布：'+n.text;state.observer?.disconnect();}}};
 state.observer=new MutationObserver(capture);state.observer.observe(document.body,{childList:true,subtree:true,characterData:true});
 // MutationObservers do not cross a shadow boundary. XHS exposes its normal
 // publish control and short-lived notices inside an extension-readable root.
 for(const root of roots)if(root instanceof ShadowRoot)state.observer.observe(root,{childList:true,subtree:true,characterData:true});
 button.click(); // Exactly one initial click per immutable attempt. No page timers.
 await Promise.resolve();return await observe(state,true);
 }catch(error){if(!reportErrors)throw error;return {ready:false,notice:'',error:error instanceof Error?error.message:'平台发布检查未返回结果'};}
}

export async function publicationProbe(task:PublishTask){
 const profile=publicationFor(task.platform,task.snapshot.type);if(!profile||!task.tabId)throw new SyncError('PUBLISH_UNIMPLEMENTED','此内容类型尚未开放直接发布');
 if(!await chrome.permissions.contains({origins:platformOrigins(task.platform,task.snapshot.type).map(o=>o+'/*')}))throw new SyncError('PERMISSION_REQUIRED','平台权限已取消');
 let last='发布控件未就绪';
 const attempts=task.platform==='jike'?60:24;
 for(let i=0;i<attempts;i++){
  const result=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'ISOLATED',func:nativePublication,args:[profile,'probe',task.targetId,publicationFields(task),'','',true]});
  const read=result[0]?.result;if(read?.ready&&read.guard)return read.guard;
  last=read?.error||'发布检查脚本未返回结果';
  if(!/条件未满足|控件缺失/.test(last))break;
  if(i<attempts-1)await new Promise(r=>setTimeout(r,250));
 }
 throw new SyncError('PUBLISH_NOT_READY',last);

}
/** Receipt recovery is read-only and tied to this task's original submitted tab. */
export async function readPublicationReceipt(task:PublishTask):Promise<Evidence|undefined>{
 if(!task.publicationAttemptedAt||!task.tabId||!task.publicationGuard)return;
 const tab=await chrome.tabs.get(task.tabId).catch(()=>undefined);if(!tab?.url||!platformOrigins(task.platform,task.snapshot.type).includes(new URL(tab.url).origin))return;
 const url=new URL(tab.url);
 if(task.platform==='channels'&&task.snapshot.type==='post'&&task.proof?.bodyDigest&&task.proof.mediaHashes.length===task.snapshot.media.length&&task.proof.uploadedMediaIds?.length===task.snapshot.media.length){
  try{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeChannelsReceipt,args:[{title:task.snapshot.title,attemptedAt:task.publicationAttemptedAt},true]});const read=result[0]?.result;if(read&&'notice' in read&&read.notice)return {kind:'publication_receipt',checkedAt:Date.now(),url:safeUrl(read.url),notice:read.notice};}catch{}
 }
 if(task.platform==='xiaohongshu'&&url.pathname==='/publish/publish'&&url.searchParams.get('published')==='true')return {kind:'publication_receipt',checkedAt:Date.now(),url:safeUrl(url.href),notice:'原任务页进入平台 published=true 成功回执；公开详情仍待人工核对'};
 const profile=publicationFor(task.platform,task.snapshot.type);if(!profile)return;
 try{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'ISOLATED',func:nativePublication,args:[profile,'receipt',task.targetId,publicationFields(task),task.publicationGuard,task.id+':'+task.attemptId,true]});if(result[0]?.result?.notice)return {kind:'publication_receipt',checkedAt:Date.now(),url:safeUrl(url.href),notice:result[0].result.notice};}catch{}return;
}
export async function submitPublication(task:PublishTask):Promise<Evidence>{
 const profile=publicationFor(task.platform,task.snapshot.type);if(!profile||!task.tabId)throw new SyncError('PUBLISH_UNIMPLEMENTED','此内容类型尚未开放直接发布',false);
 if(!await chrome.permissions.contains({origins:platformOrigins(task.platform,task.snapshot.type).map(o=>o+'/*')}))throw new SyncError('PERMISSION_REQUIRED','平台权限已取消',false);
 const attempt=task.id+':'+task.attemptId;
 const run=async(mode:'submit'|'observe')=>{const result=await chrome.scripting.executeScript({target:{tabId:task.tabId!},world:'ISOLATED',func:nativePublication,args:[profile,mode,task.targetId,publicationFields(task),task.publicationGuard||'',attempt,true]});const read=result[0]?.result;if(read?.error)throw new SyncError('PUBLISH_UNCONFIRMED',read.error,false);if(read?.generatedCover){const next=read.generatedCover,prior=task.nativeCover;if(task.platform!=='weixin'||task.snapshot.media.length||prior&&(prior.remoteIdentity||!next.remoteIdentity||prior.previewIdentity!==next.previewIdentity||prior.width!==next.width||prior.height!==next.height||prior.pixels!==next.pixels))throw new SyncError('PUBLISH_UNCONFIRMED','生成封面阶段与任务不符，停止确认',false);task=await updateTask(task.id,['publishing'],{nativeCover:{...next,phase:'confirming'},progress:next.remoteIdentity?'平台生成封面的正式资源已保存，正在继续原生确认':'平台封面证明已保存，正在按原生流程添加图片发表'});}return read;};
 try{
 let result;try{result=await run('submit');}catch(error){const receipt=await readPublicationReceipt(task);if(receipt)return receipt;throw error;}
 for(let i=0;i<120&&!result?.notice;i++){await new Promise(r=>setTimeout(r,250));const receipt=await readPublicationReceipt(task);if(receipt)return receipt;result=await run('observe');}
 if(!result?.notice)throw new SyncError('PUBLISH_UNCONFIRMED','发布回执未确认；请核对平台结果，禁止重复发布',false);
 return {kind:'publication_receipt',checkedAt:Date.now(),url:safeUrl((await chrome.tabs.get(task.tabId)).url||platformFor(task.platform).home),notice:result.notice};
 }finally{try{await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'ISOLATED',func:nativePublication,args:[profile,'stop',task.targetId,publicationFields(task),task.publicationGuard||'',attempt,true]});}catch{}}
}
