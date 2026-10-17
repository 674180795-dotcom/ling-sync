import type {ContentDraft,PlatformId} from '../core/model';
import {SyncError} from '../core/protocol';
export function validatePublicationOptions(platform:PlatformId,draft:ContentDraft){
 if(draft.type!=='video')return;
 if(['channels','bilibili'].includes(platform)&&!draft.videoSource)throw new SyncError('VIDEO_SOURCE_REQUIRED','请在视频平台选项中明确选择原创或转载');
 if(platform==='bilibili'&&draft.videoSource==='repost'){let valid=false;try{const u=new URL(draft.sourceUrl||'');valid=['http:','https:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password;}catch{}if(!valid)throw new SyncError('SOURCE_URL_REQUIRED','B站转载视频需要填写有效来源链接');}
 if(platform==='bilibili'&&(!draft.bilibiliCategory?.trim()||!draft.tags.length))throw new SyncError('BILIBILI_METADATA','B站视频需要明确分区名称和至少一个标签');
 if(platform==='bilibili'&&draft.tags.length>10)throw new SyncError('TAG_LIMIT','当前B站适配器最多10个标签，不会截断');
}
/** Ordinary visible radio, dropdown, tag-input interactions. Missing controls
 * stop submission; the user's source declaration is never invented. */
export async function nativeVideoOptions(platform:PlatformId,options:{source?:ContentDraft['videoSource'];sourceUrl?:string;category?:string;tags:string[]}){
 const origins:Partial<Record<PlatformId,string>>={bilibili:'https://member.bilibili.com',channels:'https://channels.weixin.qq.com'};
 if(!origins[platform]||location.origin!==origins[platform])throw new Error('视频选项页面来源变化');
 const roots:Array<Document|ShadowRoot>=[];const collect=(r:Document|ShadowRoot)=>{roots.push(r);for(const e of r.querySelectorAll('*')){if(e.shadowRoot)collect(e.shadowRoot);if(e instanceof HTMLIFrameElement){try{if(e.contentDocument?.location.origin===location.origin)collect(e.contentDocument);}catch{}}}};collect(document);
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';const all=(s:string)=>[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLElement>(s)]))].filter(visible);
 const selectText=(labels:string[],selector='label,[role="radio"],button,span,div')=>{const found=all(selector).filter(e=>labels.includes(e.textContent?.trim()||''));const leaf=found.filter(e=>!found.some(o=>o!==e&&e.contains(o)));if(leaf.length!==1)throw new Error('视频来源或选项不唯一，请在平台人工确认');return leaf[0]!;};
 if(platform==='bilibili'){
  if(!options.source||!options.category||!options.tags.length)throw new Error('视频来源、分区或标签未明确');
  selectText(options.source==='original'?['自制']:['转载']).click();
  if(options.source==='repost'){const input=all('input[placeholder*="转载"],input[placeholder*="来源"]') as HTMLInputElement[];if(input.length!==1||!options.sourceUrl)throw new Error('转载来源控件缺失');Object.getOwnPropertyDescriptor(input[0]!.ownerDocument.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input[0],options.sourceUrl);input[0]!.dispatchEvent(new Event('input',{bubbles:true}));}
  const label=selectText(['分区'],'label,span,div');const scope=label.closest('.category-container,.partition-container,.select-row')||label.parentElement?.parentElement;if(!scope)throw new Error('分区控件未定位');
  if(!scope.textContent?.includes(options.category)){const controls=[...scope.querySelectorAll<HTMLElement>('[role="combobox"],.select-item,[class*="select"]')].filter(visible);const leaf=controls.filter(e=>!controls.some(o=>o!==e&&e.contains(o)));if(leaf.length!==1)throw new Error('请在B站原生页明确选择分区');leaf[0]!.click();selectText([options.category],'[role="option"],li,.select-option,span').click();}
  if(!scope.textContent?.includes(options.category))throw new Error('分区选择尚未确认');
  const inputs=all('input[placeholder="按回车键Enter创建标签"]') as HTMLInputElement[];if(inputs.length!==1)throw new Error('标签输入控件不唯一');const input=inputs[0]!;
  for(const tag of options.tags){const existing=all('[class*="tag"]');if(existing.some(e=>e.textContent?.trim()===tag))continue;Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype,'value')!.set!.call(input,tag);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keypress',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,100));}
  if(options.tags.some(tag=>!all('[class*="tag"]').some(e=>e.textContent?.replace(/[×✕]/g,'').trim()===tag)))throw new Error('标签创建未确认，请在B站原生页核对');
 }else {
  if(!options.source)throw new Error('视频号来源声明未选择');
  const original=selectText(['声明原创','原创声明'],'label,span,div');const scope=original.closest('label,[role="checkbox"]')||original.parentElement;const box=scope?.querySelector<HTMLInputElement>('input[type="checkbox"]');const expected=options.source==='original';
  if(box){if(box.checked!==expected)box.click();if(box.checked!==expected)throw new Error('原创声明状态尚未确认');}else{if(!scope||!['true','false'].includes(scope.getAttribute('aria-checked')||''))throw new Error('原创声明控件状态无法读取，请在平台人工确认');if((scope.getAttribute('aria-checked')==='true')!==expected)original.click();if((scope.getAttribute('aria-checked')==='true')!==expected)throw new Error('原创声明状态尚未确认');}
  // Repost explicitly keeps the original declaration off.
 }
 return {applied:true};
}
