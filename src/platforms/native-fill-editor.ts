import type {FillProfile} from './fill-profiles';
/** Bundled page function: ordinary form events only, no private platform APIs/state. */
export async function nativeFillEditor(profile:FillProfile,action:'detect'|'read'|'fill',payload:{title:string;text:string;video:boolean;expectedImages:number;targetId?:string;videoName?:string;videoBytes?:number;ownedVideoUpload?:boolean;verifyImageBytes?:boolean;verifyImagePixels?:boolean;verifyXOriginals?:Array<{base64:string;digest:string}>;expectedVideoDuration?:number;expectedVideoWidth?:number;expectedVideoHeight?:number},reportErrors=false) {
 try{
  if(location.origin!==new URL(profile.url).origin)throw new Error('平台来源变化');
  if(profile.platform==='zsxq'&&action!=='detect'&&(!payload.targetId||location.pathname!=='/group/'+payload.targetId))throw new Error('目标星球已变化');
  const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const roots:Array<Document|ShadowRoot>=[];
  const collect=(root:Document|ShadowRoot)=>{if(roots.includes(root))return;roots.push(root);for(const e of root.querySelectorAll('*')){if(e.shadowRoot)collect(e.shadowRoot);if(e.tagName==='IFRAME'){try{const frame=e as HTMLIFrameElement;if(frame.contentDocument&&frame.contentDocument.location.origin===location.origin)collect(frame.contentDocument);}catch{}}}};
  // Inspect the same accessible roots for detection, input and readback.
  collect(document);
  const all=(selector:string)=>[...new Set(roots.flatMap(d=>[...d.querySelectorAll<HTMLElement>(selector)]))];
  const one=(selector:string,root?:Document|ShadowRoot)=>{const elements=(root?[...root.querySelectorAll<HTMLElement>(selector)]:all(selector)).filter(visible);if(elements.length>1)throw new Error('平台字段不唯一，停止填写');return elements[0];};
  let body=one(profile.body);let title=profile.title?one(profile.title):undefined;
  const text=document.body.innerText||document.body.textContent||'';
  if(/请完成安全验证|访问过于频繁|操作频繁|异常访问/.test(text))throw new Error('平台要求验证，尚未操作编辑器');
  const login=/扫码登录|扫描二维码登录|请先登录|短信登录|Sign in to X/.test(text)?'logged_out':body?'connected':'unknown';
  const normalized=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
  const weixinBody=()=>{if(!body)return '';const clean=body.cloneNode(true) as HTMLElement;clean.querySelectorAll('[contenteditable="false"],.editor_placeholder,.ProseMirror-separator').forEach(e=>e.remove());clean.querySelectorAll('br').forEach(e=>e.replaceWith('\n'));return [...clean.children].length&&[...clean.children].every(e=>['P','DIV'].includes(e.tagName))?[...clean.children].map(e=>e.textContent||'').join('\n'):clean.textContent||'';};
  // Read semantic line breaks rather than innerText's paragraph-margin spacing.
  const plainText=(node:Node):string=>{
    if(node.nodeType===3)return node.textContent||'';
    if(node.nodeType!==1)return '';
    const e=node as HTMLElement;if(e.matches('.editor_placeholder,.ProseMirror-separator'))return '';
    if(e.tagName==='BR')return '\n';
    if(e.tagName==='IMG')return e.getAttribute('alt')||'';
    if(e.childNodes.length===1&&e.firstChild?.nodeName==='BR')return '';
    const children=[...e.childNodes];let value='';
    const block=(n:Node)=>n.nodeType===1&&/^(P|DIV|LI|BLOCKQUOTE|H[1-6])$/.test((n as Element).tagName);
    const parts=children.map(plainText);children.forEach((n,i)=>{if(i&&(block(n)||block(children[i-1]!))&&!parts[i-1]!.endsWith('\n'))value+='\n';value+=parts[i];});return value;
  };
  const kuaishouBody=()=>{if(!body)return '';const clean=body.cloneNode(true) as HTMLElement;for(const tag of clean.querySelectorAll('[is-tag="true"]')){const separators:Node[]=[];let next=tag.nextSibling;while(next?.nodeType===3&&/^\s+$/.test(next.textContent||'')){separators.push(next);next=next.nextSibling;}if(separators.length&&next?.nodeType===1&&(next as Element).matches('[is-tag="true"]'))separators.forEach((separator,index)=>{separator.textContent=index?'':' ';});}return plainText(clean);};
  const bodyValue=()=>normalized(body?profile.type==='post'?profile.platform==='weixin'?weixinBody():profile.platform==='kuaishou'?kuaishouBody():plainText(body):body.innerText||body.textContent||'':'');
  const isField=(e:HTMLElement)=>e.tagName==='INPUT'||e.tagName==='TEXTAREA';
  const titleValue=()=>title&&isField(title)?(title as HTMLInputElement).value:title?.textContent||'';
  const imageDigest=async(blob:Blob)=>{
    if(!blob.size||blob.size>15*1024*1024)return '';
    if(!blob.type.startsWith('image/')){
      // XHS's normal uploader creates text/plain Blob previews containing the
      // original image bytes. Validate the signature instead of waiting forever.
      if(profile.platform!=='xiaohongshu')return '';
      const head=new Uint8Array(await blob.slice(0,12).arrayBuffer());const ascii=(start:number,end:number)=>String.fromCharCode(...head.slice(start,end));
      if(!(head[0]===137&&ascii(1,4)==='PNG'&&head[4]===13&&head[5]===10&&head[6]===26&&head[7]===10||head[0]===255&&head[1]===216&&head[2]===255||ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP'))return '';
    }
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
  };
  if(action==='fill') {
    if(!body)throw new Error('尚未找到平台正文编辑器');
    if(profile.title&&!title)throw new Error('尚未找到平台标题编辑器');
    if(bodyValue()&&bodyValue()!==normalized(payload.text))throw new Error('编辑器已有其他内容，停止覆盖');
    if(title&&titleValue()&&titleValue()!==payload.title&&!(profile.autoTitleFromFilename&&payload.ownedVideoUpload&&titleValue()===payload.videoName?.replace(/\.[^.]+$/,'')))throw new Error('标题已有其他内容，停止覆盖');
    if(title&&titleValue()!==payload.title){
      if(profile.platform==='xiaohongshu'&&isField(title)){title.focus();(title as HTMLInputElement).select();if(!title.ownerDocument.execCommand('insertText',false,payload.title))throw new Error('小红书原生标题输入未接收，未提交');}
      else if(isField(title)){const view=title.ownerDocument.defaultView!;const proto=title.tagName==='INPUT'?view.HTMLInputElement.prototype:view.HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(title,payload.title);title.dispatchEvent(new view.Event('input',{bubbles:true}));title.dispatchEvent(new view.Event('change',{bubbles:true}));}
      else {title.focus();title.ownerDocument.execCommand('selectAll',false);title.ownerDocument.execCommand('insertText',false,payload.title);}
    }
    if(profile.platform==='bilibili'&&profile.type==='post'){
      // Updating the title can remount the composer on the next render turn.
      // Never paste into the detached node captured before the title's input event.
      await new Promise<void>(resolve=>setTimeout(resolve,0));
      if(location.origin!==new URL(profile.url).origin)throw new Error('平台来源变化');
      roots.length=0;collect(document);body=one(profile.body);title=profile.title?one(profile.title):undefined;
      if(!body||profile.title&&!title)throw new Error('B站标题更新后编辑器尚未就绪，未填写正文或发布');
      if(title&&titleValue()!==payload.title)throw new Error('B站标题更新后未稳定，未填写正文或发布');
      if(bodyValue()&&bodyValue()!==normalized(payload.text))throw new Error('编辑器已有其他内容，停止覆盖');
    }
    if(bodyValue()!==normalized(payload.text)){body.focus();const range=body.ownerDocument.createRange();range.selectNodeContents(body);if(bodyValue())range.collapse(false);const selection=body.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);const view=body.ownerDocument.defaultView!;
      if(profile.type==='post'&&profile.platform==='bilibili'){
        // The native rich-text model does not ingest execCommand-created DIV siblings.
        // Its ordinary paste handler must consume all paragraphs before we can read back.
        const data=new view.DataTransfer();data.setData('text/plain',payload.text);
        const paste=new view.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});body.dispatchEvent(paste);
        await Promise.resolve();await Promise.resolve();
        if(!paste.defaultPrevented)throw new Error('B站原生粘贴未接收正文，未上传或发布');
      }else if(profile.type==='post'&&['zsxq','weixin','xiaohongshu'].includes(profile.platform)){
        // Quill's paste fallback moves focus into a hidden clipboard and defers
        // conversion with a page timer. Use ordinary editing in the visible field.
        const command=['weixin','zsxq'].includes(profile.platform)?'insertHTML':'insertText';
        const escaped=payload.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r\n?/g,'\n').replace(/\n/g,'<br>');
        const input=profile.platform==='zsxq'?payload.text.replace(/\r\n?/g,'\n').split('\n').map(line=>'<p>'+(line?line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):'<br>')+'</p>').join(''):profile.platform==='weixin'?escaped:payload.text;
        if(!body.ownerDocument.execCommand(command,false,input))throw new Error('平台编辑器未接受正文输入');
        // Native insertHTML notifies Quill itself. A second synthetic input can reset its model.
      }else{const data=new view.DataTransfer();data.setData('text/plain',payload.text);body.dispatchEvent(new view.ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));await Promise.resolve();await Promise.resolve();if(profile.platform!=='x'&&!bodyValue()){body.ownerDocument.execCommand('insertText',false,payload.text);body.dispatchEvent(new view.InputEvent('input',{bubbles:true,inputType:'insertText',data:payload.text}));}}}
    await Promise.resolve();await Promise.resolve();
  }
  const scope=body?.closest<HTMLElement>(profile.scope)||one(profile.scope,(body?.getRootNode()||document) as Document|ShadowRoot);if(body&&!scope)throw new Error('Editor scope changed');const mediaScope=scope||document.body;
  const imageElements=[...mediaScope.querySelectorAll<HTMLImageElement>(profile.imagesSelector||'img')].filter(visible);
  // X's four-photo DOM is column-major; the normal preview and publication order
  // are read row-major. Geometry also detects a real user reorder.
  if(profile.platform==='x')imageElements.sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return Math.abs(x.top-y.top)>2?x.top-y.top:x.left-y.left;});
  const rawImageSources=profile.backgroundImagesSelector?[...mediaScope.querySelectorAll<HTMLElement>(profile.backgroundImagesSelector)].filter(visible).map(e=>getComputedStyle(e).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1]||''):imageElements.map(e=>e.currentSrc||e.src);
  const imageSources=profile.platform==='weixin'&&profile.type==='post'?rawImageSources.filter(src=>{try{const u=new URL(src);return u.protocol==='blob:'&&u.origin===location.origin||u.protocol==='data:'&&src.startsWith('data:image/')||u.protocol==='https:'&&['mmbiz.qpic.cn','mmbiz.qlogo.cn'].includes(u.hostname);}catch{return false;}}):rawImageSources;
  const pendingImageItems=rawImageSources.length-imageSources.length;
  const images=await Promise.all(imageSources.map(async(src,index)=>{
    try{
      const u=new URL(src);
      if(profile.platform==='bilibili'&&u.protocol==='http:'&&/^i\d+\.hdslb\.com$/.test(u.hostname))u.protocol='https:';
      // X's observed public encoder (64555 -> 189859.Vt) uses an opaque white
      // canvas and JPEG quality .85. Only exact bytes from this one transform
      // prove ownership; no similarity score or alternative quality search.
      if(profile.platform==='x'&&payload.verifyXOriginals&&(u.protocol==='blob:'&&u.origin===location.origin||u.protocol==='data:'&&src.startsWith('data:image/'))){
        const original=payload.verifyXOriginals[index];if(!original)return '';
        const originalBytes=Uint8Array.from(atob(original.base64),c=>c.charCodeAt(0));
        if(originalBytes.length>15*1024*1024||originalBytes.length<8||![137,80,78,71,13,10,26,10].every((n,i)=>originalBytes[i]===n))return '';
        const digest=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(await digest(originalBytes.buffer)!==original.digest)return '';
        const preview=await(await fetch(u.href)).blob();if(preview.type!=='image/jpeg'||!preview.size||preview.size>15*1024*1024)return '';
        const url=URL.createObjectURL(new Blob([originalBytes],{type:'image/png'}));
        try{
          const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('原图无法解码'));image.src=url;});
          if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth>4096||image.naturalHeight>4096||image.naturalWidth*image.naturalHeight>32_000_000)return '';
          if(typeof image.decode==='function')await image.decode();
          const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
          const ctx=canvas.getContext('2d');if(!ctx)return '';ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
          const encoded=canvas.toDataURL('image/jpeg',.85);if(!encoded.startsWith('data:image/jpeg;base64,'))return '';
          const encodedBytes=Uint8Array.from(atob(encoded.split(',')[1]!),c=>c.charCodeAt(0));
          return `x-jpeg85-sha256:${original.digest}:${await digest(encodedBytes.buffer)}:${await digest(await preview.arrayBuffer())}`;
        }finally{URL.revokeObjectURL(url);}
      }
      if(profile.platform==='x'&&payload.verifyImagePixels&&(u.protocol==='blob:'&&u.origin===location.origin||u.protocol==='data:'&&/^data:image\/(png|jpeg|webp);base64,/.test(src))){
        const response=await fetch(u.href);const blob=await response.blob();
        if(!/^image\/(png|jpeg|webp)$/.test(blob.type)||!blob.size||blob.size>15*1024*1024)return '';
        const image=await createImageBitmap(blob,{colorSpaceConversion:'none'});
        if(!image.width||!image.height||image.width*image.height>32_000_000){image.close();return '';}
        const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d',{colorSpace:'srgb'});
        if(!ctx){image.close();return '';}ctx.drawImage(image,0,0);image.close();
        const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;if(rgba.length!==canvas.width*canvas.height*4)return '';
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',rgba))].map(v=>v.toString(16).padStart(2,'0')).join('');
        return `pixels-sha256:${canvas.width}:${canvas.height}:${digest}`;
      }
      if(u.protocol==='data:'&&/^data:image\/(png|jpeg|webp|gif);base64,/.test(src)&&src.length<=21*1024*1024){const blob=await(await fetch(src)).blob();if(blob.size>15*1024*1024)return '';const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');return 'data-sha256:'+digest;}
      if(u.protocol==='https:'){if(payload.verifyImagePixels){const response=await fetch(u.href);if(!response.ok)return '';const blob=await response.blob();if(!blob.type.startsWith('image/')||blob.size>15*1024*1024)return '';const image=await createImageBitmap(blob);if(!image.width||!image.height||image.width*image.height>32_000_000){image.close();return '';}const canvas=new OffscreenCanvas(image.width,image.height);const ctx=canvas.getContext('2d');if(!ctx){image.close();return '';}ctx.drawImage(image,0,0);image.close();const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,canvas.width,canvas.height).data))].map(x=>x.toString(16).padStart(2,'0')).join('');return `pixels-sha256:${canvas.width}:${canvas.height}:${digest}`;}if(payload.verifyImageBytes){const response=await fetch(u.href);if(!response.ok)return '';const digest=await imageDigest(await response.blob());return digest?'content-sha256:'+digest:'';}return u.origin+u.pathname;}
      if(u.protocol==='blob:'&&u.origin===location.origin){
        const digest=await imageDigest(await(await fetch(u.href)).blob());return digest?'blob-sha256:'+digest:'';
      }
    }catch{}return '';
  })).then(values=>values.filter(Boolean));
  const nameMatches=!!payload.videoName&&(mediaScope.innerText||mediaScope.textContent||'').includes(payload.videoName)||[...document.querySelectorAll<HTMLInputElement>('input[type=file]')].some(input=>[...(input.files||[])].some(file=>file.name===payload.videoName&&file.size===payload.videoBytes));
  const statusNodes=[...((body?.getRootNode()||document) as Document|ShadowRoot).querySelectorAll<HTMLElement>('[role=status],[role=progressbar],[class*=upload],[class*=Upload],[class*=progress],[class*=Progress]')].filter(e=>visible(e)&&(!body||!e.contains(body)&&!body.contains(e))&&(!title||!e.contains(title)&&!title.contains(e)));
  const stage=statusNodes.map(e=>e.innerText||e.textContent||'').join('\n');
  const sources=[...new Set([...mediaScope.querySelectorAll<HTMLVideoElement>('video')].filter(visible).map(v=>v.currentSrc||v.src||v.querySelector('source')?.src||'').filter(Boolean))];
  let videoIdentity='';if(sources.length===1){try{const u=new URL(sources[0]!);if(u.protocol==='https:')videoIdentity=u.origin+u.pathname;else if(u.protocol==='blob:'&&u.origin===location.origin)videoIdentity=u.href;}catch{}}
  const busy=/上传中|正在上传|转码中|正在转码|处理中|正在处理|上传失败|处理失败|Uploading|Processing/i.test(stage);
  const readyVideo=[...mediaScope.querySelectorAll<HTMLVideoElement>('video')].find(v=>v.readyState>=2&&Number.isFinite(v.duration)&&v.duration>0);
  const metadataMatches=!!readyVideo&&(!payload.expectedVideoDuration||Math.abs(readyVideo.duration-payload.expectedVideoDuration)<=0.25)&&(!payload.expectedVideoWidth||readyVideo.videoWidth===payload.expectedVideoWidth)&&(!payload.expectedVideoHeight||readyVideo.videoHeight===payload.expectedVideoHeight);
  const processed=metadataMatches&&!!payload.ownedVideoUpload&&!!profile.processedRoute&&location.pathname===profile.processedRoute&&!!readyVideo&&!!profile.processedVideoOrigin&&videoIdentity.startsWith(profile.processedVideoOrigin+'/');
  let localPreview=false;
  if(profile.fileVideoReceipt&&payload.ownedVideoUpload){
    const inputs=all('.bcc-upload-wrapper input[type=file]').filter(e=>!e.closest('[role="dialog"],.bcc-dialog')) as HTMLInputElement[];
    const rows=all('.upload-queue .file-item').filter(visible);
    const file=inputs.length===1&&inputs[0]!.files?.length===1?inputs[0]!.files[0]:undefined;
    const stem=payload.videoName?.replace(/\.[^.]+$/,'');
    if(file&&file.name===payload.videoName&&file.size===payload.videoBytes&&file.type.startsWith('video/')&&rows.length===1&&rows[0]!.querySelector('.title-text')?.textContent?.trim()===stem&&rows[0]!.querySelector('.file-item-content-status-text .success')?.textContent?.trim()==='上传完成'){
      let chain=new Uint8Array(32);
      for(let offset=0;offset<file.size;offset+=96*1024){const part=new Uint8Array(await file.slice(offset,offset+96*1024).arrayBuffer());const joined=new Uint8Array(chain.length+part.length);joined.set(chain);joined.set(part,chain.length);chain=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));}
      videoIdentity='native-video-chain256:'+file.size+':'+[...chain].map(v=>v.toString(16).padStart(2,'0')).join('');localPreview=true;
    }
  }
  if(profile.localVideoPreview&&payload.ownedVideoUpload&&readyVideo&&videoIdentity.startsWith('blob:')){
    const blob=await(await fetch(videoIdentity)).blob();
    if(blob.size>0&&blob.size===payload.videoBytes){
      let chain=new Uint8Array(32);
      for(let offset=0;offset<blob.size;offset+=96*1024){const part=new Uint8Array(await blob.slice(offset,offset+96*1024).arrayBuffer());const joined=new Uint8Array(chain.length+part.length);joined.set(chain);joined.set(part,chain.length);chain=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));}
      videoIdentity='blob-video-chain256:'+blob.size+':'+[...chain].map(v=>v.toString(16).padStart(2,'0')).join('');localPreview=true;
    }
  }
  const uploaded=!!videoIdentity&&payload.video&&!busy&&(localPreview||processed||nameMatches&&!!profile.videoReady&&new RegExp(profile.videoReady,'i').test(payload.videoName?stage.split(payload.videoName).join(''):stage));
  // A DOM-only edit can look complete while the native editor still holds an
  // older value. Its visible character counter is an independent readiness signal.
  const counter=profile.platform==='zsxq'?mediaScope.querySelector('.text-range')?.textContent?.match(/^\s*\((\d+)\s*\/\s*10000\)\s*$/):undefined;
  const nativeModelMatched=!counter||Number(counter[1])===payload.text.replace(/\r\n?/g,'\n').trim().length;
  const fieldState={actualCharacters:bodyValue().length,expectedCharacters:normalized(payload.text).length,nativeCharacters:counter?Number(counter[1]):undefined,modelMatched:nativeModelMatched};
  return {fieldState,error:undefined as string|undefined,remoteMediaReady:imageSources.length>0&&imageSources.every(src=>src.startsWith('https://')),imageItems:profile.imageItemsSelector?mediaScope.querySelectorAll(profile.imageItemsSelector).length:profile.platform==='x'?rawImageSources.length:undefined,uploadBusy:busy||pendingImageItems>0,uploadInputReady:all('input[type=file]').some(e=>!(e as HTMLInputElement).disabled&&((e as HTMLInputElement).accept.split(',').some(a=>a.trim().startsWith(payload.video?'video/':'image/')||a.trim()===(payload.video?'.mp4':'.png')||!payload.video&&['.jpg','.jpeg','.webp'].includes(a.trim())))),login,editorFound:!!body&&(!profile.title||!!title),title:titleValue(),bodyMatched:!!body&&bodyValue()===normalized(payload.text)&&nativeModelMatched,formatMatched:true,body:bodyValue(),images,videoReady:uploaded,videoIdentity,hasVideoMedia:sources.length>0||all('input[type=file]').some(e=>[...((e as HTMLInputElement).files||[])].some(file=>file.type.startsWith('video/'))),notice:!nativeModelMatched?'知识星球正文显示与原生字数尚未一致':stage.match(/(?:上传中|正在上传|上传成功|上传完成|转码中|正在转码|处理中|正在处理|Processing|Uploading)[^\n]{0,80}/i)?.[0]};
 }catch(error){if(!reportErrors)throw error;return {fieldState:undefined,error:error instanceof Error?error.message:'编辑器脚本未返回结果',remoteMediaReady:false,imageItems:undefined,uploadBusy:false,uploadInputReady:false,login:'unknown',editorFound:false,title:'',bodyMatched:false,formatMatched:true,body:'',images:[] as string[],videoReady:false,videoIdentity:'',hasVideoMedia:false,notice:undefined};}

}
