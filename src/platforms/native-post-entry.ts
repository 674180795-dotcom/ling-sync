import type {FillProfile} from './fill-profiles';
/** Serialized into MAIN: traversal and inspection must be self-contained. */
export function nativePostReady(profile:FillProfile){
 try{
 const roots:Array<Document|ShadowRoot>=[];
 const collect=(r:Document|ShadowRoot)=>{if(roots.includes(r))return;roots.push(r);for(const e of r.querySelectorAll('*')){if(e.shadowRoot)collect(e.shadowRoot);if(e.tagName==='IFRAME'){try{const d=(e as HTMLIFrameElement).contentDocument;if(d&&d.location.origin===location.origin)collect(d);}catch{}}}};collect(document);
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const all=(s:string)=>[...new Set(roots.flatMap(r=>[...r.querySelectorAll(s)]))];
 const fields=all(profile.body).some(visible)&&(!profile.title||all(profile.title).some(visible));
 const kind=profile.type==='video'?'video':'image';
 const input=all('input[type=file]').some(e=>{const i=e as HTMLInputElement;return !i.disabled&&i.accept.split(',').some(a=>a.trim().startsWith(kind+'/')||(kind==='image'?/^\.(png|jpe?g|webp)$/i:/^\.(mp4|mov|webm)$/i).test(a.trim()))&&(!i.closest('[role=tabpanel]')||visible(i.closest('[role=tabpanel]')!));});
 const nativeImageEntry=profile.platform!=='kuaishou'||profile.type!=='post'||all('button').filter(e=>visible(e)&&e.textContent?.trim()==='上传图片').length===1;
 const text=roots.map(r=>'body' in r?(r as Document).body?.innerText||(r as Document).body?.textContent||'':r.textContent||'').join('\n');
 const verification=/请完成安全验证|访问过于频繁|异常访问|请完成验证/.test(text);
 const login=/扫码登录|扫描二维码登录|请先登录|短信登录|Sign in to X/.test(text)&&!fields?'logged_out':fields||input?'connected':'unknown';
 return {error:undefined as string|undefined,ready:location.origin===new URL(profile.url).origin&&(fields||!!profile.mediaFirst&&input&&nativeImageEntry),editorFound:fields,uploadInputReady:input,login,verification};
 }catch(error){return {ready:false,editorFound:false,uploadInputReady:false,login:'unknown',verification:false,error:error instanceof Error?error.message:'编辑器检测异常'};}
}
/** Switch only the normal, unique content tab. Never clear restored content. */
export function activateNativePost(profile:FillProfile){
 if(location.origin!==new URL(profile.url).origin)throw new Error('平台来源变化');
 const roots:Array<Document|ShadowRoot>=[];const collect=(r:Document|ShadowRoot)=>{if(roots.includes(r))return;roots.push(r);for(const e of r.querySelectorAll('*')){if(e.shadowRoot)collect(e.shadowRoot);if(e.tagName==='IFRAME'){try{const d=(e as HTMLIFrameElement).contentDocument;if(d&&d.location.origin===location.origin)collect(d);}catch{}}}};collect(document);
 const all=(s:string)=>[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLElement>(s)]))];
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 if(all(profile.body).some(visible)&&(!profile.title||all(profile.title).some(visible)))return true;
 if(!profile.entrySelector)return false;
 if(all('[contenteditable=true],textarea').some(e=>visible(e)&&((e as HTMLTextAreaElement).value||e.textContent)?.trim())||all('input[type=file]').some(e=>(e as HTMLInputElement).files?.length))throw new Error('平台恢复了已有内容，请保留原稿后再切换类型');
 const candidates=all(profile.entrySelector).filter(e=>visible(e)&&(!profile.entryLabels?.length||profile.entryLabels.includes(e.getAttribute('aria-label')?.trim()||e.textContent?.trim()||'')));
 const buttons=candidates.filter(e=>!candidates.some(other=>other!==e&&e.contains(other)));if(buttons.length!==1)return false;
 if(buttons[0]!.getAttribute('aria-selected')==='true')return true;buttons[0]!.click();return true;
}
/** Dismiss the ordinary topic suggestion with the editor's normal Escape handler. */
export function nativeXhsSuggestions(action:'dismiss'|'check'){
 try{
  if(location.origin!=='https://creator.xiaohongshu.com')throw new Error('小红书来源变化');
  const editor=document.querySelector<HTMLElement>('.publish-page .tiptap[contenteditable=true]');if(!editor)throw new Error('小红书编辑器未就绪');
  const visibleTips=()=>[...document.querySelectorAll<HTMLElement>('[role=tooltip]')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
  if(action==='dismiss'){
   if(visibleTips()){editor.focus();editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}));}
   if(editor===document.activeElement||editor.contains(document.activeElement))editor.blur();
   document.body.click();
  }
  return {ready:!visibleTips(),error:undefined as string|undefined};
 }catch(error){return {ready:false,error:error instanceof Error?error.message:'话题建议未关闭'};}
}
