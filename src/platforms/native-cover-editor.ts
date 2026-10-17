import type {PlatformId} from '../core/model';
/** Candidate normal-page cover workflow. No publish/save-draft action is exposed. */
export async function nativeCoverEditor(platform:PlatformId,action:'open'|'choose_upload'|'next_ratio'|'confirm'|'read',ownedCoverUpload=false) {
  const specs={
    douyin:{origin:'https://creator.douyin.com',entry:'div[class^="coverControl-"] div[class^="title-"]',entryText:'选择封面',dialog:'[role="dialog"]',uploadLabel:'',confirm:'button',confirmText:'完成',preview:'div[class^="coverControl-"] img'},
    kuaishou:{origin:'https://cp.kuaishou.com',entry:'[class*="_cover-full-editor_"]',entryText:'封面设置',dialog:'.ant-modal-body',uploadLabel:'上传封面',confirm:'button',confirmText:'确认',preview:'[class*="_default-cover_"] img'},
    bilibili:{origin:'https://member.bilibili.com',entry:'div.cover-main .cover-empty',entryText:'',dialog:'.bcc-dialog,[role="dialog"]',uploadLabel:'',confirm:'div.submit,button',confirmText:'完成',preview:'div.cover-main img,div.cover-main .cover-img'},
  } as const;
  if(platform!=='kuaishou'&&platform!=='bilibili'&&platform!=='douyin')throw new Error('此平台封面槽尚未核对，不能自动选择');
  const s=specs[platform];if(location.origin!==s.origin)throw new Error('封面来源变化');
  const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const roots:Array<Document|ShadowRoot>=[];
  const collect=(root:Document|ShadowRoot)=>{roots.push(root);for(const e of root.querySelectorAll('*')){if(e.shadowRoot)collect(e.shadowRoot);if(e.tagName==='IFRAME'){try{const doc=(e as HTMLIFrameElement).contentDocument;if(doc&&doc.location.origin===location.origin)collect(doc);}catch{}}}};collect(document);
  const all=(selector:string)=>[...new Set(roots.flatMap(root=>[...root.querySelectorAll<HTMLElement>(selector)]))];
  const identity=(source:string)=>{try{const u=new URL(source);return u.protocol==='https:'?u.origin+u.pathname:'';}catch{return '';}};
  const rawPreviews=async()=>Promise.all(all(s.preview).filter(visible).map(async element=>{const source=element.tagName==='IMG'?(element as HTMLImageElement).src:getComputedStyle(element).backgroundImage.match(/^url\(["']?(.+?)["']?\)$/)?.[1]||'';const remote=identity(source);if(remote)return remote;try{const u=new URL(source);if(u.protocol==='blob:'&&u.origin===location.origin){const blob=await(await fetch(u.href)).blob();if(blob.type.startsWith('image/')&&blob.size<=15*1024*1024){const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()));return 'blob-cover-sha256:'+Array.from(digest,v=>v.toString(16).padStart(2,'0')).join('');}}}catch{}return '';})).then(values=>values.filter(Boolean));
  const slotHashes=async()=>{if(platform!=='douyin')return [];const containers=all('div[class^="coverControl-"]').filter(visible);const ordered=['竖封面3:4','横封面4:3'].map(label=>containers.filter(e=>e.textContent?.includes(label)));if(ordered.some(list=>list.length!==1))return [];const sources=ordered.map(list=>identity(list[0]!.querySelector('img')?.src||''));if(sources.some(src=>!src))return [];return Promise.all(sources.map(async source=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source))),v=>v.toString(16).padStart(2,'0')).join('')));};
  const previews=async()=>{if(platform!=='douyin')return rawPreviews();const slots=await slotHashes();return slots.length===2?['douyin-cover-pair:'+slots.join(':')]:[];};
  if(/请完成安全验证|访问过于频繁|异常访问/.test(document.body.innerText||''))throw new Error('平台要求安全验证');
  if(action==='read')return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:all(s.dialog).some(visible)};
  if(action==='open'){
    const entries=all(s.entry).filter(e=>visible(e)&&(!s.entryText||e.textContent?.trim()===s.entryText)&&(platform!=='douyin'||e.closest('div[class^="coverControl-"]')?.textContent?.includes('竖封面3:4')));
    const targets=entries.filter(e=>!entries.some(child=>child!==e&&e.contains(child)));
    if(targets.length!==1)throw new Error('封面入口缺失或不唯一，停止操作');targets[0]!.click();return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:false};
  }
  const dialogs=all(s.dialog).filter(visible);
  // Nested semantic dialogs refer to one panel, but unrelated visible panels are ambiguous.
  const outer=dialogs.filter(e=>!dialogs.some(other=>other!==e&&other.contains(e)));
  if(outer.length!==1)throw new Error('封面面板缺失或不唯一，停止操作');const dialog=outer[0]!;
  if(action==='choose_upload'){
    if(s.uploadLabel){const labels=[...dialog.querySelectorAll<HTMLElement>('button,div,span')].filter(e=>visible(e)&&e.textContent?.trim()===s.uploadLabel&&!e.querySelector('button,div,span'));if(labels.length!==1)throw new Error('封面上传入口缺失或不唯一');labels[0]!.click();}
    return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:true};
  }
  if(action==='next_ratio'){
    if(platform!=='douyin')throw new Error('此平台没有双比例封面切换');
    if((dialog.innerText||dialog.textContent||'').includes('横封面预览（4:3）'))return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:true};
    const input=dialog.querySelector<HTMLInputElement>('div.semi-upload[class*="upload-"] input.semi-upload-hidden-input');if(!ownedCoverUpload&&input?.files?.length!==1)throw new Error('竖封面文件尚未进入当前面板');
    const next=[...dialog.querySelectorAll<HTMLButtonElement>('button')].filter(e=>visible(e)&&e.textContent?.trim()==='设置横封面'&&!e.disabled);if(next.length!==1)throw new Error('横封面切换入口未就绪');next[0]!.click();return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:true};
  }
  if(platform==='douyin'&&(!(dialog.innerText||dialog.textContent||'').includes('横封面预览（4:3）')))throw new Error('横竖封面仍在处理中，不能确认');
  const buttons=[...dialog.querySelectorAll<HTMLElement>(s.confirm)].filter(e=>visible(e)&&e.textContent?.trim()===s.confirmText&&!(e as HTMLButtonElement).disabled&&e.getAttribute('aria-disabled')!=='true'&&getComputedStyle(e).pointerEvents!=='none');
  // Ant footer can be a sibling of its body; scope it to the same .ant-modal.
  if(platform==='kuaishou'&&!buttons.length){const modal=dialog.closest('.ant-modal');if(modal)buttons.push(...[...modal.querySelectorAll<HTMLElement>(s.confirm)].filter(e=>visible(e)&&e.textContent?.trim()===s.confirmText&&!(e as HTMLButtonElement).disabled&&e.getAttribute('aria-disabled')!=='true'&&getComputedStyle(e).pointerEvents!=='none'));}
  if(buttons.length!==1)throw new Error('封面确认入口缺失或不唯一');buttons[0]!.click();return {identities:await previews(),slotHashes:await slotHashes(),dialogOpen:true};
}
