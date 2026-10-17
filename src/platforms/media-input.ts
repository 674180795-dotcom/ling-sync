import type {MediaRef,PlatformId} from '../core/model';
/** Capture only the file input opened by the normal B站图片 button's next tick. */
export async function prepareBiliImageInput(){
  try{
  if(location.origin!=='https://t.bilibili.com')throw new Error('B站动态页面来源变化');
  const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const scopes=[...document.querySelectorAll<HTMLElement>('.bili-dyn-publishing')].filter(visible);
  if(scopes.length!==1)throw new Error('B站动态编辑器缺失或不唯一');const scope=scopes[0]!;
  const existing=[...scope.querySelectorAll<HTMLInputElement>('input[type=file][data-ling-sync-bili-picker]')];
  if(existing.length>1)throw new Error('B站图片选择器不唯一');
  if(existing.length===1)return {ready:true,accept:existing[0]!.accept,multiple:existing[0]!.multiple,error:''};
  const buttons=[...scope.querySelectorAll<HTMLElement>('.bili-dyn-publishing__tools__item.pic')].filter(visible);
  if(buttons.length!==1)throw new Error('B站正常图片按钮缺失或不唯一');
  const original=HTMLInputElement.prototype.click;const captured:HTMLInputElement[]=[];
  // The normal button waits for Vue's next tick before opening a detached input.
  // Cross only microtasks, then restore; no timer, createElement hook or private objects.
  try{
    HTMLInputElement.prototype.click=function(){
      if(this.type!=='file')return original.call(this);
      if(this.isConnected&&!scope.contains(this))throw new Error('B站图片选择器离开本编辑器');
      if(captured.includes(this))return;captured.push(this);
    };
    buttons[0]!.click();
    for(let i=0;i<16&&!captured.length;i++)await Promise.resolve();
  }finally{HTMLInputElement.prototype.click=original;}
  if(captured.length!==1)throw new Error('B站正常图片按钮未产生唯一文件选择器');
  const input=captured[0]!;
  if(input.disabled||input.accept&&!input.accept.split(',').some(v=>/^image\//i.test(v.trim())||/^\.(png|jpe?g|webp|gif)$/i.test(v.trim())))throw new Error('B站图片选择器类型不匹配');
  input.hidden=true;input.setAttribute('data-ling-sync-bili-picker','1');scope.append(input);
  return {ready:true,accept:input.accept,multiple:input.multiple,error:''};
  }catch(error){return {ready:false,accept:'',multiple:false,error:error instanceof Error?error.message:'B站正常图片选择器未就绪'};}
}
/** Traverse only accessible same-origin documents and open shadow roots. */
export function mediaRoots(root:Document|ShadowRoot=document):Array<Document|ShadowRoot>{
  const result:Array<Document|ShadowRoot>=[root];
  for(const e of root.querySelectorAll('*')){if(e.shadowRoot)result.push(...mediaRoots(e.shadowRoot));if(e.tagName==='IFRAME'){try{const doc=(e as HTMLIFrameElement).contentDocument;if(doc&&doc.location.origin===location.origin)result.push(...mediaRoots(doc));}catch{}}}
  return result;
}
export function nativeMediaInput(platform:PlatformId,media:MediaRef){
  const roots=mediaRoots();
  if(platform==='kuaishou'&&media.kind==='image'){const buttons=[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLButtonElement>('button')]))].filter(b=>!!b.getClientRects().length&&b.textContent?.trim()==='上传图片');if(buttons.length===1){const drop=buttons[0]!.closest<HTMLElement>('[class*="_dragger-container_"]')||buttons[0]!.parentElement?.parentElement;if(drop)return drop;}}
  const extension='.'+media.name.split('.').at(-1)?.toLowerCase();
  const inputs=[...new Set(roots.flatMap(root=>[...root.querySelectorAll<HTMLInputElement>('input[type=file]')]))].filter(e=>!e.disabled&&(!e.accept||e.accept.split(',').some(value=>{const accept=value.trim().toLowerCase();return accept===media.mime||accept===extension||accept===media.mime.split('/')[0]+'/*';})));
  const scoped=media.kind==='cover'?inputs.filter(input=>{
    if(platform==='kuaishou')return !!input.closest('.ant-modal-body');
    if(platform==='douyin')return !!input.closest('[role="dialog"]')&&!!input.closest('div.semi-upload[class*="upload-"]')&&input.classList.contains('semi-upload-hidden-input');
    if(platform==='bilibili')return !!input.closest('.bcc-upload-wrapper')&&!!input.closest('.bcc-dialog,[role="dialog"]');
    return false;
  }):inputs.filter(input=>(!input.closest('[role="dialog"],.ant-modal,.bcc-dialog')||platform==='x'||platform==='jike')&&(platform!=='bilibili'||!!input.closest(media.kind==='image'?'.bili-dyn-publishing':'.bcc-upload-wrapper'))&&(platform!=='zsxq'||!!input.closest('.create-topic-panel'))&&(platform!=='x'||!!input.closest('div[role="dialog"][aria-modal="true"]'))&&(platform!=='jike'||!!input.closest('[role="dialog"]'))&&(platform!=='weixin'||!!input.closest('.image-selector')));
  const candidates=platform==='xiaohongshu'&&media.kind==='image'?scoped.filter(input=>input.multiple&&!!input.closest('.upload-wrapper,.img-list')):scoped;
  if(!candidates.length&&platform==='kuaishou'&&media.kind==='image'){const buttons=[...new Set(roots.flatMap(r=>[...r.querySelectorAll<HTMLButtonElement>('button')]))].filter(b=>!!b.getClientRects().length&&b.textContent?.trim()==='上传图片');if(buttons.length===1&&buttons[0]?.parentElement?.parentElement)return buttons[0].parentElement.parentElement;}
  if(candidates.length!==1)throw new Error('对应媒体上传控件缺失或不唯一，停止上传');return candidates[0]!;
}
