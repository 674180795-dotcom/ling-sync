import {editorBody} from '../core/post-limits';
import {db} from '../core/repository';
import {safeUrl,type Evidence,type PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';

/** Match a visible, authored result, never the still-open composer or framework state. */
export async function nativeZsxqResult(expected:{targetId:string;text:string;images:string[];detailUrl?:string;accountKey?:string;mediaIdentities?:string[];pixels?:string[];verifiedMedia?:Array<{identity:string;proof:string}>},action:'open'|'read',reportErrors=false){
 try{
 if(location.origin!=='https://wx.zsxq.com')throw new Error('发布结果来源变化');
 const normal=(v:string)=>v.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const identity=(value:string)=>{const u=new URL(value,location.href);return u.origin+u.pathname;};
 const user=document.querySelector<HTMLImageElement>('.user-container img');const account=user?identity(user.src):expected.accountKey;if(!account)throw new Error('当前账号尚未确认');if(expected.accountKey&&account!==expected.accountKey)throw new Error('当前账号已变化');
 const detailId=(value:string)=>{const u=new URL(value,location.href);if(u.origin!==location.origin)return '';return u.pathname.match(/\/(?:topic|topic_detail)\/([A-Za-z0-9_-]{5,})\/?$/)?.[1]||'';};
 if(!detailId(location.href)&&location.pathname!=='/group/'+expected.targetId)throw new Error('发布结果离开目标星球');
 const panel=[...document.querySelectorAll<HTMLElement>('app-topic-detail')].find(e=>visible(e)||!!e.querySelector('.topic-detail')?.getClientRects().length);
 if(!detailId(location.href)&&action==='open'&&!panel){const latest=[...document.querySelectorAll<HTMLElement>('.menu-container .item')].filter(e=>visible(e)&&e.textContent?.trim()==='最新');if(latest.length===1&&!latest[0]!.classList.contains('actived')){latest[0]!.click();return {waiting:true};}}
 const candidates=[...(panel||document).querySelectorAll<HTMLElement>('div,p,article')].filter(e=>visible(e)&&!e.closest('.create-topic-panel,form,[contenteditable=true],[role=dialog]')&&normal(e.textContent||e.innerText||'')===normal(expected.text));
 const unique=candidates.filter(e=>!candidates.some(child=>child!==e&&e.contains(child)));if(unique.length!==1)throw new Error('没有唯一匹配的已发布正文，保持待核对');
 const content=unique[0]!;let scope:HTMLElement|undefined;let ancestor=content.parentElement;
 for(let i=0;i<8&&ancestor&&ancestor!==document.body;i++,ancestor=ancestor.parentElement){if(!ancestor.querySelector('.create-topic-panel')&&[...ancestor.querySelectorAll<HTMLImageElement>('img')].some(img=>visible(img)&&identity(img.src)===account)){scope=ancestor;break;}}
 if(!scope)throw new Error('未核对到当前账号的发布结果');
 const id=detailId(location.href);
 if(id&&expected.detailUrl!==location.origin+location.pathname)throw new Error('请从目标星球打开匹配结果后再核对');
 if(!id){
   if(panel){
    const share=panel.querySelector<HTMLElement>('.share-topic');
    const copyButtons=[...panel.querySelectorAll<HTMLElement>('div,span,button')].filter(e=>visible(e)&&e.textContent?.trim()==='复制链接'&&!e.children.length);
    if(!copyButtons.length){if(!share)throw new Error('正常分享入口缺失');share.click();return {opened:true,url:''};}
    if(copyButtons.length!==1)throw new Error('分享链接入口不唯一');
    let copied='';const write=navigator.clipboard.writeText,command=document.execCommand;
    try{navigator.clipboard.writeText=async value=>{copied=String(value);};document.execCommand=function(name,...args){if(name.toLowerCase()==='copy'){const active=document.activeElement as HTMLInputElement|null;copied=active?.value||getSelection()?.toString()||'';return true;}return command.call(document,name,...args);};copyButtons[0]!.click();for(let i=0;i<12&&!copied;i++)await Promise.resolve();}
    finally{navigator.clipboard.writeText=write;document.execCommand=command;}
    if(!copied)throw new Error('正常分享链接未返回');const u=new URL(copied);if(!['https://wx.zsxq.com','https://t.zsxq.com'].includes(u.origin))throw new Error('分享链接来源变化');return {opened:true,url:u.href};
   }
   if(action!=='open')throw new Error('请打开该动态的正常详情页');
   const links=[...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&detailId(a.href));
   if(links.length===1)return {opened:true,url:links[0]!.href};
   const details=[...scope.querySelectorAll<HTMLElement>('div,span,button,a')].filter(e=>visible(e)&&e.textContent?.trim()==='查看详情'&&![...e.children].some(c=>c.textContent?.trim()==='查看详情'));if(details.length!==1)throw new Error('详情入口不唯一');details[0]!.click();return {opened:true,url:''};
 }
 const images=[...scope.querySelectorAll<HTMLImageElement>('img')].filter(img=>visible(img)&&!img.matches('.preload,.image.can-scale')&&identity(img.src)!==account&&!/avatar|icon|emoji/.test(img.className+' '+(img.parentElement?.className||'')));
 if(images.length!==expected.images.length||images.some(img=>!img.complete||img.naturalWidth<=0))throw new Error('已发布图片数量或加载状态未匹配');
 const hash=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
 const identities=await Promise.all(images.map(img=>hash(identity(img.currentSrc||img.src))));
 if(expected.mediaIdentities?.length===images.length&&identities.every((v,i)=>v===expected.mediaIdentities![i]))return {id,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:true,mediaCount:images.length};
 const verifiedMedia=[...(expected.verifiedMedia||[])];
 try{for(const [index,img] of images.entries()){
  let source=img.currentSrc||img.src;const mediaIdentity=identity(source),prior=verifiedMedia[index];if(prior?.identity===mediaIdentity&&(prior.proof==='bytes:'+expected.images[index]||!!expected.pixels?.[index]&&prior.proof==='rgba:'+expected.pixels[index]))continue;
  if(expected.pixels){
   // The normal viewer supplies its own signed full-size resource. Never edit
   // the signature or invent an original-image endpoint from a thumbnail.
   const viewer=[...document.querySelectorAll<HTMLImageElement>('img.image.can-scale')].filter(e=>visible(e)&&identity(e.currentSrc||e.src)===identity(source));
   if(viewer.length!==1){img.click();return {waiting:true,verifiedMedia};}
   if(!viewer[0]!.complete||viewer[0]!.naturalWidth<=0)return {waiting:true,verifiedMedia};source=viewer[0]!.currentSrc||viewer[0]!.src;
  }
  const u=new URL(source);if(u.protocol!=='https:')throw new Error('结果图片不是远程资源');const response=await fetch(u.href,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('结果图片尚未核对');const blob=await response.blob();if(!blob.type.startsWith('image/')||blob.size>15*1024*1024)throw new Error('结果图片身份不明');
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');if(digest===expected.images[index]){verifiedMedia[index]={identity:mediaIdentity,proof:'bytes:'+digest};continue;}
  if(!expected.pixels?.[index])return {id,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:false,mediaCount:images.length};
  // Qiniu preserves PNG channels but may change colour metadata. Compare every
  // decoded RGBA channel, at original dimensions, with colour conversion off.
  const bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>32_000_000){bitmap.close();throw new Error('结果图片尺寸不可核对');}
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{colorSpace:'srgb'});if(!ctx){bitmap.close();throw new Error('像素核对不可用');}ctx.drawImage(bitmap,0,0);bitmap.close();
  const rgba=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');if(`${canvas.width}:${canvas.height}:${rgba}`!==expected.pixels[index])return {id,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:false,mediaCount:images.length};verifiedMedia[index]={identity:mediaIdentity,proof:'rgba:'+expected.pixels[index]};
 }}catch{return {id,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:false,mediaCount:images.length};}

 return {id,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:true,mediaCount:images.length};
 }catch(error){if(!reportErrors)throw error;return {error:error instanceof Error?error.message:'知识星球结果脚本未返回'};}
}
export async function verifyZsxqPublication(task:PublishTask):Promise<Evidence>{
 if(task.snapshot.type!=='post')throw new SyncError('RESULT_PAGE_REQUIRED','请保留知识星球原任务页',false);
 if(!await chrome.permissions.contains({origins:['https://wx.zsxq.com/*']}))throw new SyncError('PERMISSION_REQUIRED','知识星球权限已取消',false);
 const images:string[]=[],pixels:string[]=[];for(const ref of task.snapshot.media){const media=await(await db()).get('media',ref.id);if(!media)throw new SyncError('MEDIA_MISSING','任务图片无法核对',false);images.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await media.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));const bitmap=await createImageBitmap(media.blob,{colorSpaceConversion:'none'});if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>32_000_000){bitmap.close();throw new SyncError('MEDIA_DIMENSIONS','本地原图尺寸不可核对',false);}const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d',{colorSpace:'srgb'});if(!ctx){bitmap.close();throw new SyncError('PIXEL_CHECK_UNAVAILABLE','像素核对不可用',false);}ctx.drawImage(bitmap,0,0);bitmap.close();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(v=>v.toString(16).padStart(2,'0')).join('');pixels.push(`${canvas.width}:${canvas.height}:${digest}`);}
 // Result verification gets its own ordinary page; never navigate an uncertain composer.
 const resultTab=await chrome.tabs.create({url:'https://wx.zsxq.com/group/'+task.targetId,active:false,...(task.source?{windowId:task.source.windowId}:{})});
 if(!resultTab.id)throw new SyncError('RESULT_PAGE_REQUIRED','无法打开知识星球只读结果页',false);const tabId=resultTab.id;
 try{
 const expected:{targetId:string;text:string;images:string[];detailUrl?:string;accountKey?:string;mediaIdentities?:string[];pixels?:string[];verifiedMedia?:Array<{identity:string;proof:string}>}={targetId:task.targetId,text:editorBody(task.snapshot,false),images,pixels};
 if(task.proof?.uploadedMediaIds?.length===task.snapshot.media.length&&task.snapshot.media.every((m,i)=>m.id===task.proof!.uploadedMediaIds![i]))expected.mediaIdentities=task.proof.remoteMediaHashes||task.proof.mediaHashes;
 let lastError='知识星球发布结果尚未核对',openedFromTarget=false;
 const knownDetail=task.publicationResult?.visibility==='public'&&task.evidence?.bodyMatched&&task.evidence.contentId===task.publicationResult.id&&task.evidence.url===task.publicationResult.url&&task.publicationResult.url===`https://wx.zsxq.com/group/${task.targetId}/topic/${task.publicationResult.id}`?task.publicationResult.url:undefined;
 for(let i=0;i<240;i++){
   try{if(!expected.accountKey){const identity=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{const img=document.querySelector<HTMLImageElement>('.user-container img');if(!img)return '';const u=new URL(img.src);return u.origin+u.pathname;}});expected.accountKey=identity[0]?.result||undefined;}if(knownDetail&&expected.accountKey&&!openedFromTarget){await chrome.tabs.update(tabId,{url:knownDetail});openedFromTarget=true;expected.detailUrl=knownDetail;await new Promise(r=>setTimeout(r,250));continue;}if(openedFromTarget){const current=await chrome.tabs.get(tabId);if(current.url){const u=new URL(current.url);if(u.origin==='https://wx.zsxq.com'&&/\/(?:topic|topic_detail)\/[^/]+\/?$/.test(u.pathname))expected.detailUrl=u.origin+u.pathname;}}const r=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeZsxqResult,args:[expected,openedFromTarget?'read':'open',true]});const result=r[0]?.result;if(result&&'verifiedMedia' in result)expected.verifiedMedia=result.verifiedMedia;if(result&&'error' in result)throw new Error(result.error);
     if(result&&'id' in result&&result.id)return {kind:result.mediaMatched?'publication_result':'publication_receipt',checkedAt:Date.now(),title:task.snapshot.title,bodyMatched:true,mediaMatched:result.mediaMatched,mediaCount:result.mediaCount,contentId:result.id,url:safeUrl(result.url),notice:result.mediaMatched?'正常详情页核对当前账号、正文及已证明上传的有序媒体身份、图片字节或完整原尺寸RGBA像素通过':'已发现当前账号的发布详情，正文一致；平台转换后的图片尚未通过完整核对，不重复发布'};
     if(result&&'opened' in result){openedFromTarget=true;}
     if(result&&'opened' in result&&result.url){const url=new URL(result.url);if(!['https://wx.zsxq.com','https://t.zsxq.com'].includes(url.origin)||url.origin==='https://wx.zsxq.com'&&! /\/(?:topic|topic_detail)\/[^/]+\/?$/.test(url.pathname))throw new Error('详情页来源变化');await chrome.tabs.update(tabId,{url:url.href});}
   }catch(error){lastError=error instanceof Error?error.message:lastError;}
   await new Promise(r=>setTimeout(r,250));
 }
 throw new SyncError('PUBLISH_RESULT_PENDING',lastError+'；不会重新发布',false);
 }finally{await chrome.tabs.remove(tabId).catch(()=>{});}
}
