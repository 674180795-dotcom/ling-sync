/** Read-only management-list receipt. This proves a submission record, not the
 * public body, media identity, order, or availability of the published content.
 * Self-contained for chrome.scripting.executeScript; no platform state/API use. */
export function nativeChannelsReceipt(expected:{title:string;attemptedAt:number},captureErrors=false){
 try{
  const origin='https://channels.weixin.qq.com',path='/platform/post/finderNewLifePostList';
  if(location.origin!==origin||location.pathname!==path)throw new Error('视频号回执不在原图文管理页面');
  const now=Date.now(),minute=60_000;
  if(!Number.isFinite(expected.attemptedAt)||expected.attemptedAt<=0||expected.attemptedAt>now)throw new Error('视频号原提交时间未确认');
  const normal=(value:string)=>value.replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').trim();
  const title=normal(expected.title);if(!title)throw new Error('视频号任务标题为空，无法归属回执');
  const roots:Array<Document|ShadowRoot>=[document],seen=new Set<Document|ShadowRoot>(roots);
  // WUJIE uses open shadow roots; inspect only the normal same-origin DOM.
  for(let i=0;i<roots.length;i++)for(const element of roots[i]!.querySelectorAll('*')){
   if(element.shadowRoot&&!seen.has(element.shadowRoot)){seen.add(element.shadowRoot);roots.push(element.shadowRoot);}
   if(element.tagName==='IFRAME')try{
    const frame=element as HTMLIFrameElement,doc=frame.contentDocument;
    if(doc&&frame.contentWindow?.location.origin===origin&&!seen.has(doc)){seen.add(doc);roots.push(doc);}
   }catch{/* Cross-origin frames have no authority over this receipt. */}
  }
  const visible=(element:Element)=>{
   if(!element.getClientRects().length)return false;
   let current:Element|null=element;
   while(current){
    const style=current.ownerDocument.defaultView?.getComputedStyle(current);
    if(current.hasAttribute('hidden')||style?.display==='none'||style?.visibility==='hidden')return false;
    const parent:Element|null=current.parentElement,root:Node=current.getRootNode();
    current=parent||(root.nodeType===11&&'host' in root?(root as ShadowRoot).host:root.nodeType===9?(root as Document).defaultView?.frameElement||null:null);
   }
   return true;
  };
  const editors=roots.flatMap(root=>[...root.querySelectorAll('div[data-placeholder="添加描述, 1000个字符内"],input[placeholder="填写标题, 22个字符内"]')]).filter(visible);
  if(editors.length)throw new Error('视频号仍显示正文编辑器，不能认领管理回执');
  const matches=roots.flatMap(root=>[...root.querySelectorAll<HTMLElement>('.post-title')]).filter(element=>visible(element)&&normal(element.innerText||element.textContent||'')===title);
  if(matches.length!==1)throw new Error('视频号管理列表没有唯一匹配标题，保留待核对');
  const row=matches[0]!.closest('.center-info');if(!row)throw new Error('视频号标题不在可核对的管理记录中');
  const times=[...row.querySelectorAll<HTMLElement>('.desc .posted-info .post-time .time-label')].filter(visible);
  if(times.length!==1)throw new Error('视频号管理记录发表时间未唯一确认');
  const rawTime=normal(times[0]!.innerText||times[0]!.textContent||'');
  const parts=rawTime.match(/^(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s+(\d{1,2}):(\d{2})$/);
  if(!parts)throw new Error('视频号管理记录时间格式未确认');
  const [year,month,day,hour,minutes]=parts.slice(1).map(Number) as [number,number,number,number,number];
  const utc=Date.UTC(year,month-1,day,hour,minutes),date=new Date(utc);
  if(year<2000||date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day||date.getUTCHours()!==hour||date.getUTCMinutes()!==minutes)throw new Error('视频号管理记录时间无效');
  // Native Chinese management times are CST (UTC+8) and only minute precise.
  const postedAt=utc-8*60*minute,attemptMinute=Math.floor(expected.attemptedAt/minute)*minute;
  if(postedAt<attemptMinute||postedAt>attemptMinute+10*minute||postedAt>Math.floor(now/minute)*minute)throw new Error('视频号管理记录时间与本次提交不符，保留待核对');
  const rawStatus=[...row.querySelectorAll<HTMLElement>('.desc')].filter(visible).map(element=>normal(element.innerText||element.textContent||'').replace(/\s+/g,' ')).filter(Boolean).join('；').slice(0,400);
  return {notice:'视频号图文管理列表出现本次标题和发表时间'+(rawStatus?'；平台原文：'+rawStatus:'')+'；仅确认提交回执，正文及图片尚待核对',postedAt,url:origin+path,receiptOnly:true as const};
 }catch(error){if(!captureErrors)throw error;return {error:error instanceof Error?error.message:'视频号提交回执未确认'};}
}
