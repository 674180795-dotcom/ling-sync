import {editorBody} from '../core/post-limits';
import {db} from '../core/repository';
import {platformFor,platformOrigins,safeUrl,type PublishTask,type Evidence} from '../core/model';
import {SyncError} from '../core/protocol';
import {verifyZsxqPublication} from './zsxq-result';
import {verifyWeixinPublication} from './weixin-result';
export type ResultProfile={origin:string;body:string;mediaScope:string;images:string;detailPattern:string;};
export const resultProfiles:Partial<Record<PublishTask['platform'],ResultProfile>>={
 jike:{origin:'https://web.okjike.com',body:'div[class^="_content_"]',mediaScope:'div[class^="_contentWrapper_"]',images:'img[class*="_picture_"]',detailPattern:'^/u/[^/]+/post/([a-f0-9]{24})$'},
};
/** Public, visible result only. Never inspect framework state or use private APIs. */
export async function nativePublicationResult(profile:ResultProfile,expected:{text:string;images:string[];mediaCount:number;video:boolean;ownerPath?:string;targetId?:string},action:'read'|'open',captureErrors=false){
 try {
 if(location.origin!==profile.origin)throw new Error('发布结果页面来源变化');
 const normal=(v:string)=>v.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const matches=[...document.querySelectorAll<HTMLElement>(profile.body)].filter(e=>visible(e)&&!e.closest('form,[contenteditable="true"],[role="dialog"]')&&normal(e.innerText||e.textContent||'')===normal(expected.text));
 const unique=matches.filter(e=>!matches.some(other=>other!==e&&e.contains(other)));if(unique.length!==1)throw new Error('没有唯一匹配的发布结果，不重复提交');
 const node=unique[0]!;const detail=location.pathname.match(new RegExp(profile.detailPattern));
 if(!detail){if(action==='open'){node.click();return {opened:true};}throw new Error('请先打开匹配内容的详情页');}
 if(expected.ownerPath&&!location.pathname.startsWith(expected.ownerPath+'/post/'))throw new Error('公开结果账号与当前登录账号不符');
 const scope=node.closest(profile.mediaScope);if(!scope)throw new Error('发布媒体作用域未确认');
 if(expected.targetId!==undefined){const circles=[...scope.querySelectorAll<HTMLAnchorElement>('a[href^="/topic/"]')].filter(visible);if(circles.length>(expected.targetId?1:0)||(expected.targetId?circles[0]?.textContent?.trim():circles[0]?.textContent?.trim()||'')!==expected.targetId)throw new Error('发布结果圈子与任务目标不符');}
 const images=[...scope.querySelectorAll<HTMLImageElement>(profile.images)].filter(visible);
 const videos=[...scope.querySelectorAll<HTMLVideoElement>('video')].filter(visible);
 if(expected.video||videos.length)throw new Error('视频发布结果核对尚未实现');
 if(images.length!==expected.mediaCount)throw new Error('发布图片数量未匹配');
 // Background result views may defer decoding; fetch and byte-match every actual remote source below.
 const actual:string[]=[];for(const image of images){const u=new URL(image.currentSrc||image.src);if(u.protocol!=='https:')throw new Error('发布图片不是平台远程资源');if(profile.origin==='https://web.okjike.com'&&u.origin==='https://cdnv2.ruguoapp.com'&&[...u.searchParams.keys()].every(k=>k.startsWith('imageMogr2/')))u.search='';const response=await fetch(u.href);if(!response.ok)throw new Error('远程图片无法核对');const blob=await response.blob();if(!blob.type.startsWith('image/')||blob.size>15*1024*1024)throw new Error('远程图片身份不可核对');actual.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));}
 if(actual.length!==expected.images.length||actual.some((value,index)=>value!==expected.images[index]))throw new Error('发布图片内容或顺序未匹配，保留待核对');
 return {id:detail[1]!,url:location.origin+location.pathname,bodyMatched:true,mediaMatched:true,mediaCount:images.length};
 } catch(error){if(!captureErrors)throw error;return {error:error instanceof Error?error.message:'发布结果未确认'};}
}
export async function verifyPublication(task:PublishTask):Promise<Evidence>{
 if(task.platform==='zsxq')return verifyZsxqPublication(task);
 if(task.platform==='weixin')return verifyWeixinPublication(task);
 const profile=resultProfiles[task.platform];if(!profile)throw new SyncError('PUBLISH_RESULT_PENDING','此平台发布结果自动核对尚待适配，请保留任务并人工核对',false);
 const origins=platformOrigins(task.platform,task.snapshot.type).map(o=>o+'/*');if(!await chrome.permissions.contains({origins}))throw new SyncError('PERMISSION_REQUIRED','发布结果站点尚未授权',false);
 let tab=task.tabId?await chrome.tabs.get(task.tabId).catch(()=>undefined):undefined;
 if(!tab?.id){const found=await chrome.tabs.query({url:profile.origin+'/*'});if(found.length!==1)throw new SyncError('RESULT_PAGE_REQUIRED','请打开唯一的原发布结果页',false);tab=found[0];}
 if(!tab?.id||!tab.url||new URL(tab.url).origin!==profile.origin)throw new SyncError('PAGE_CHANGED','请恢复原平台结果页',false);
 const images:string[]=[];for(const ref of task.snapshot.media.filter(m=>m.kind==='image')){const media=await(await db()).get('media',ref.id);if(!media)throw new SyncError('MEDIA_MISSING','本地任务附件无法核对',false);images.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await media.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));}
 const owner=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>{
  const paths=[...document.querySelectorAll<HTMLElement>('[title="个人主页"]')].filter(e=>e.getClientRects().length).map(e=>e.closest<HTMLAnchorElement>('a[href]')?.pathname).filter((p):p is string=>!!p&&/^\/u\/[^/]+$/.test(p));return [...new Set(paths)].length===1?paths[0]:undefined;
 }});const ownerPath=owner[0]?.result;if(!ownerPath)throw new SyncError('ACCOUNT_UNCONFIRMED','请在当前登录即刻页面核对账号',false);
 const expected={text:editorBody(task.snapshot,false),images,mediaCount:task.snapshot.media.length,video:task.snapshot.type==='video',ownerPath,targetId:task.targetId};
 // Use a separate ordinary profile view; an uncertain composer is never navigated or cleared.
 const resultTab=await chrome.tabs.create({url:profile.origin+ownerPath,active:false,...(task.source?{windowId:task.source.windowId}:{})});
 if(!resultTab.id)throw new SyncError('RESULT_PAGE_REQUIRED','无法打开只读结果页',false);
 let message='发布结果尚未核对';
 try{
  for(let i=0;i<40;i++){
   try{
    const r=await chrome.scripting.executeScript({target:{tabId:resultTab.id},world:'MAIN',func:nativePublicationResult,args:[profile,expected,'open',true]});const result=r[0]?.result;
    if(result&&'error' in result)message=result.error||message;
    if(result&&'id' in result&&result.id&&result.url)return {kind:'publication_result',checkedAt:Date.now(),title:task.snapshot.title,bodyMatched:true,mediaCount:result.mediaCount,mediaMatched:true,contentId:result.id,url:safeUrl(result.url),notice:'当前账号发布详情的正文、圈子及有序图片字节核对通过'};
   }catch(error){message=error instanceof Error?error.message:message;}
   await new Promise(r=>setTimeout(r,250));
  }
  throw new SyncError('PUBLISH_RESULT_UNCONFIRMED',message+'；禁止重复发布',false);
 }finally{await chrome.tabs.remove(resultTab.id).catch(()=>{});}
}
