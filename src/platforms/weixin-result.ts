import {editorBody} from '../core/post-limits';
import {safeUrl,type Evidence,type PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';
/** Read the ordinary public article view, or follow a unique visible result link. */
export async function nativeWeixinResult(expected:{title:string;text:string;mediaHashes:string[];cover?:PublishTask['nativeCover']},action:'open'|'read'){
 if(location.origin!=='https://mp.weixin.qq.com')throw new Error('公众号结果来源变化');
 const normal=(v:string)=>v.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const publicId=(value:string)=>{const u=new URL(value,location.href);if(u.origin!==location.origin)return '';return u.pathname.match(/^\/s\/([\w-]+)$/)?.[1]||(u.pathname==='/s'&&u.searchParams.get('__biz')&&u.searchParams.get('mid')?[u.searchParams.get('__biz'),u.searchParams.get('mid'),u.searchParams.get('idx')||'1'].join(':'):'');};
 const id=publicId(location.href);
 if(!id){if(action==='open'){const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&!a.closest('#js_appmsg_editor,[contenteditable=true]')&&normal(a.innerText||a.textContent||'')===normal(expected.title)&&publicId(a.href));if(links.length===1)return {opened:true,url:links[0]!.href};const records=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>visible(a)&&a.textContent?.trim()==='发表记录'&&new URL(a.href).origin===location.origin&&new URL(a.href).pathname==='/cgi-bin/appmsgpublish');if(records.length===1&&location.pathname!=='/cgi-bin/appmsgpublish'){records[0]!.click();return {opened:true,url:''};}}throw new Error('请打开本条贴图的正常公开详情页，保持待核对');}
 const imageDescription=document.querySelector<HTMLElement>('#js_image_desc');
 const titles=[...document.querySelectorAll<HTMLElement>(imageDescription?'.image_content h1.rich_media_title':'#activity-name')].filter(visible),bodies=[...document.querySelectorAll<HTMLElement>(imageDescription?'#js_image_desc':'#js_content')].filter(visible);
 const bodyText=(body:HTMLElement)=>{const copy=body.cloneNode(true) as HTMLElement;copy.querySelectorAll('br').forEach(br=>br.replaceWith('\n'));return copy.textContent||'';};
 if(titles.length!==1||bodies.length!==1||normal(titles[0]!.innerText||titles[0]!.textContent||'')!==normal(expected.title)||normal(imageDescription?bodyText(bodies[0]!):bodies[0]!.innerText||bodies[0]!.textContent||'')!==normal(expected.text))throw new Error('公开贴图标题或描述未匹配');
 // The ordinary carousel carries the uploaded identity in data-src; its decoded
 // img can use a processed CDN resource. Ignore the separate static placeholder.
 const items=imageDescription?[...document.querySelectorAll<HTMLElement>('.share_media:not([id]) .swiper_item[data-src]')]:[];
 const images=imageDescription?items.map(item=>item.querySelector<HTMLImageElement>('img')):[...bodies[0]!.querySelectorAll<HTMLImageElement>('img')].filter(visible);
 if(images.length!==(expected.cover?1:expected.mediaHashes.length)||images.some(img=>!img||!img.complete||img.naturalWidth<=0))throw new Error('公开贴图图片数量或加载状态未匹配');
 if(expected.cover){
  const image=images[0]!,source=imageDescription?items[0]!.getAttribute('data-src')||'':image!.currentSrc||image!.src,u=new URL(source,location.href);if(u.protocol!=='https:'||u.hostname!=='mmbiz.qpic.cn')throw new Error('平台生成封面未返回正式远程图片');
  let matched=u.origin+u.pathname===(expected.cover.remoteIdentity||expected.cover.previewIdentity);
  if(!matched&&expected.cover.pixels&&image!.naturalWidth===expected.cover.width&&image!.naturalHeight===expected.cover.height){try{const canvas=document.createElement('canvas');canvas.width=expected.cover.width;canvas.height=expected.cover.height;const ctx=canvas.getContext('2d');if(ctx){ctx.drawImage(image!,0,0);const pixels=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');matched=pixels===expected.cover.pixels;}}catch{}}
  if(!matched)throw new Error('公开封面与已持久记录的平台生成封面尚未匹配');
  return {id,url:location.href,mediaCount:1};
 }
 for(const [index,image] of images.entries()){const source=imageDescription?items[index]!.getAttribute('data-src')||'':image!.currentSrc||image!.src;const u=new URL(source,location.href);if(u.protocol!=='https:'||u.hostname!=='mmbiz.qpic.cn')throw new Error('公开贴图媒体不是已知平台远程资源');const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(u.origin+u.pathname)))].map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==expected.mediaHashes[index])throw new Error('公开贴图平台媒体身份或顺序未匹配');}

 return {id,url:location.href,mediaCount:images.length};
}
export async function verifyWeixinPublication(task:PublishTask):Promise<Evidence>{
 if(!task.tabId||task.snapshot.type!=='post'||task.proof?.mediaHashes.length!==task.snapshot.media.length)throw new SyncError('RESULT_PAGE_REQUIRED','请保留公众号原任务页与媒体核对证明',false);
 if(!await chrome.permissions.contains({origins:['https://mp.weixin.qq.com/*']}))throw new SyncError('PERMISSION_REQUIRED','公众号权限已取消',false);
 const expected={title:task.snapshot.title,text:editorBody(task.snapshot,true),mediaHashes:task.proof.mediaHashes,...(task.nativeCover?{cover:task.nativeCover}:{})};
 let message='公众号公开结果待核对';
 for(let i=0;i<30;i++){
   try{const r=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeWeixinResult,args:[expected,'open']});const result=r[0]?.result;
     if(result&&'id' in result&&result.id)return {kind:'publication_result',checkedAt:Date.now(),title:task.snapshot.title,bodyMatched:true,mediaMatched:true,mediaCount:result.mediaCount,contentId:result.id,url:safeUrl(result.url),notice:'普通公开详情页标题、描述与有序平台媒体身份核对通过'};
     if(result&&'opened' in result&&result.url){const u=new URL(result.url);if(u.origin!=='https://mp.weixin.qq.com'||!/^\/s(?:\/|$)/.test(u.pathname))throw new Error('公开链接来源变化');await chrome.tabs.update(task.tabId,{url:u.href});}
   }catch(error){message=error instanceof Error?error.message:message;}
   await new Promise(r=>setTimeout(r,250));
 }
 throw new SyncError('PUBLISH_RESULT_PENDING',message+'；不会再次发表',false);
}
