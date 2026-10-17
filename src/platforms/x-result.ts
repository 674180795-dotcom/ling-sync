import {editorBody} from '../core/post-limits';
import {db} from '../core/repository';
import {safeUrl,type Evidence,type PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';

type ExpectedXResult={text:string;ownerPath:string;attemptedAt:number;images:string[];detailUrl?:string};
/** Only ordinary visible posts authored by the current account, after this attempt.
 * A matching public body is a receipt; unmatched media never becomes published. */
export async function nativeXResult(expected:ExpectedXResult,reportErrors=false){
 try{
  if(location.origin!=='https://x.com')throw new Error('X结果页面来源变化');
  const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const normal=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
  if(!/^\/[A-Za-z0-9_]{1,15}$/.test(expected.ownerPath)||!Number.isFinite(expected.attemptedAt)||expected.attemptedAt<=0)throw new Error('X账号或本次提交时间未确认');
  const owners=[...document.querySelectorAll<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"],nav a[aria-label="个人资料"],nav a[aria-label="Profile"]')].filter(a=>visible(a)&&a.origin===location.origin&&/^\/[A-Za-z0-9_]{1,15}$/.test(a.pathname)).map(a=>a.pathname.toLowerCase());
  if(new Set(owners).size!==1||owners[0]!==expected.ownerPath.toLowerCase())throw new Error('X当前登录账号已变化或未确认');
  const nodes=[...document.querySelectorAll<HTMLElement>('article [data-testid="tweetText"]')].filter(e=>visible(e)&&!e.closest('[contenteditable="true"],form,a,[role="link"]')&&normal(e.textContent||'')===normal(expected.text));
  const matches=nodes.flatMap(node=>{
   const article=node.closest('article')!;
   const links=[...article.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&a.querySelector('time')&&a.origin===location.origin&&new RegExp('^'+expected.ownerPath+'/status/[0-9]+$','i').test(a.pathname));
   const unique=[...new Map(links.map(a=>[a.pathname.toLowerCase(),a])).values()];if(unique.length!==1)return [];
   const link=unique[0]!,when=Date.parse(link.querySelector('time')!.getAttribute('datetime')||'');
   if(!Number.isFinite(when)||when<expected.attemptedAt-2000||when>expected.attemptedAt+10*60_000||when>Date.now()+60_000)return [];
   return [{article,url:link.origin+link.pathname,id:link.pathname.split('/').at(-1)!}];
  });
  if(matches.length!==1)throw new Error('未找到唯一匹配当前账号、完整正文及本次时间的X结果');
  const match=matches[0]!;
  if(location.pathname.toLowerCase()!==new URL(match.url).pathname.toLowerCase())return {opened:true,url:match.url};
  if(expected.detailUrl?.toLowerCase()!==match.url.toLowerCase())throw new Error('请从当前账号匹配结果进入详情');
  const images=[...match.article.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img')].filter(visible);
  if(images.length<expected.images.length)return {id:match.id,url:match.url,bodyMatched:true,mediaMatched:false,mediaCount:undefined as number|undefined};
  const bytes:string[]=[];
  for(const image of images){
   const u=new URL(image.currentSrc||image.src);if(u.origin!=='https://pbs.twimg.com'||!u.pathname.startsWith('/media/'))throw new Error('X结果图片来源未确认');
   try{const response=await fetch(u.href,{signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('图片未就绪');const blob=await response.blob();if(!blob.size||blob.size>15*1024*1024||!blob.type.startsWith('image/'))throw new Error('图片不可核对');bytes.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));}catch{bytes.push('');}
  }
  const mediaMatched=images.length===expected.images.length&&bytes.every((value,index)=>!!value&&value===expected.images[index])&&!match.article.querySelector('video');
  return {id:match.id,url:match.url,bodyMatched:true,mediaMatched,mediaCount:images.length};
 }catch(error){if(!reportErrors)throw error;return {error:error instanceof Error?error.message:'X结果核对未返回'};}
}

export async function verifyXPublication(task:PublishTask):Promise<Evidence>{
 if(task.snapshot.type!=='post'||!task.publicationAttemptedAt)throw new SyncError('PUBLISH_RESULT_PENDING','X仅核对有提交标记的动态，不重复发送',false);
 if(!await chrome.permissions.contains({origins:['https://x.com/*']}))throw new SyncError('PERMISSION_REQUIRED','X结果站点尚未授权',false);
 const images:string[]=[];for(const ref of task.snapshot.media){const media=await(await db()).get('media',ref.id);if(ref.kind!=='image'||!media||media.blob.size!==ref.bytes)throw new SyncError('MEDIA_MISSING','X任务原图无法核对',false);images.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await media.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));}
 // Isolate reconciliation from the original composer, even when its tab survives.
 const tab=await chrome.tabs.create({url:'https://x.com/home',active:false,...(task.source?{windowId:task.source.windowId}:{})});
 if(!tab.id)throw new SyncError('RESULT_PAGE_REQUIRED','无法打开X只读结果页',false);
 try{
  let ownerPath='',detailUrl='',message='X发布结果尚未核对';
  for(let i=0;i<100;i++){
   try{
    if(!ownerPath){const owner=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>{if(location.origin!=='https://x.com')return '';const paths=[...document.querySelectorAll<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"],nav a[aria-label="个人资料"],nav a[aria-label="Profile"]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&e.origin===location.origin&&/^\/[A-Za-z0-9_]{1,15}$/.test(e.pathname)).map(e=>e.pathname);return new Set(paths.map(p=>p.toLowerCase())).size===1?paths[0]||'':'';}});ownerPath=owner[0]?.result||'';if(ownerPath){await chrome.tabs.update(tab.id,{url:'https://x.com'+ownerPath});}await new Promise(r=>setTimeout(r,250));continue;}
    const r=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:nativeXResult,args:[{text:editorBody(task.snapshot,false),ownerPath,attemptedAt:task.publicationAttemptedAt,images,detailUrl},true]});const result=r[0]?.result;
    if(result&&'error' in result)message=result.error||message;
    if(result&&'opened' in result&&result.url){detailUrl=result.url;await chrome.tabs.update(tab.id,{url:detailUrl});}
    if(result&&'id' in result&&result.id)return {kind:result.mediaMatched?'publication_result':'publication_receipt',checkedAt:Date.now(),title:task.snapshot.title,bodyMatched:true,mediaMatched:result.mediaMatched,mediaCount:result.mediaCount,contentId:result.id,url:safeUrl(result.url),notice:result.mediaMatched?'X当前账号详情的完整正文、提交时间和有序原图字节核对通过':'已在X当前账号详情找到本次完整正文与发布时间；公开图片尚未逐字节匹配，保留已提交，不重复发送'};
   }catch(error){message=error instanceof Error?error.message:message;}
   await new Promise(r=>setTimeout(r,250));
  }
  throw new SyncError('PUBLISH_RESULT_PENDING',message+'；禁止重复发布',false);
 }finally{await chrome.tabs.remove(tab.id).catch(()=>{});}
}
