import {prepareJikeTarget,readJikeTarget} from './targets';
import {editorBody,postOverflow} from '../core/post-limits';
import {nativeVideoOptions} from './video-options';
import {activateNativePost,nativePostReady,nativeXhsSuggestions} from './native-post-entry';
import {publicationProbe,submitPublication} from './publication';
import {verifyPublication} from './publication-result';
import {nativeChannelsDraft} from './native-channels-draft';
import {createTaskTab} from './task-tab';
import {capabilityFor,platformFor,platformOrigins,type Account,type ContentDraft,type Evidence,type PlatformId,type PublishTask,type VideoMetadata,safeUrl} from '../core/model';
import {db,updateTask,log} from '../core/repository';
import {SyncError,errorValue} from '../core/protocol';
import {sameMedia,knownUploadPrefix} from '../core/content-proof';
import {mediaChunks} from '../core/media-stream';
import {fillProfile,type FillProfile} from './fill-profiles';
import {nativeFillEditor} from './native-fill-editor';
import {nativeCoverEditor} from './native-cover-editor';
import {prepareBiliImageInput} from './media-input';
import type {PlatformAdapter,EditorObservation} from './contracts';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const hash=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
export class FillAdapter implements PlatformAdapter {
  constructor(readonly platform:PlatformId){}
  private permission(type?:ContentDraft['type']){return chrome.permissions.contains({origins:platformOrigins(this.platform,type).map(o=>o+'/*')});}
  async detectSession():Promise<Account>{
    const base={platform:this.platform,checkedAt:Date.now(),targetId:''};if(!await this.permission(this.platform==='bilibili'?'video':undefined)&&!(this.platform==='bilibili'&&await this.permission('post')))return {...base,status:'permission_required'};
    const tab=(await chrome.tabs.query({url:platformOrigins(this.platform).map(o=>o+'/*')})).find(t=>t.id);
    const type=this.platform==='bilibili'&&tab?.url?.startsWith('https://t.bilibili.com/')?'post':this.platform==='jike'||this.platform==='x'?'post':'video';const profile=fillProfile(this.platform,type);
    if(!tab?.id||!profile)return {...base,status:'unknown',note:'在平台进入编辑页后再检测'};
    try{const observed=await this.native(tab.id,profile,'detect',{title:'',text:'',video:false,expectedImages:0});return {...base,status:observed.login as Account['status'],note:observed.login==='unknown'?'待确认：进入正常编辑页再检测':undefined};}
    catch{return {...base,status:'unknown',note:'页面加载或验证未完成'};}
  }
  validate(draft:ContentDraft,_targetId?:string){
    const overflow=postOverflow(draft,this.platform);if(overflow)throw new SyncError('BODY_TOO_LONG',`正文与标签共${overflow.length}字符，超过${overflow.limit}上限，请选择跳过或正文转图片。`);
    const profile=fillProfile(this.platform,draft.type);const capability=capabilityFor(this.platform,draft.type);
    if(profile?.batchImages&&draft.media.reduce((sum,m)=>sum+m.bytes,0)>64*1024*1024)throw new SyncError('BATCH_LIMIT','此图文批量附件合计最多64MiB（本地限制）');
    if(!profile||!capability||capability.verification==='unimplemented')throw new SyncError('UNSUPPORTED_TYPE','该平台的此内容类型尚未实现，请选择已开放的操作');
    if(!draft.markdown.trim()&&!draft.title.trim()&&!draft.tags.length)throw new SyncError('EMPTY_CONTENT','请填写内容');
    if(draft.type==='video'&&draft.media.filter(m=>m.kind==='video').length!==1)throw new SyncError('VIDEO_REQUIRED','请选择一个本地视频');
    if(draft.type!=='video'&&draft.media.some(m=>m.kind!=='image'))throw new SyncError('UNSUPPORTED_MEDIA','动态只接受有序图片');
    if(draft.type==='video'&&draft.media.some(m=>m.kind==='image'))throw new SyncError('UNSUPPORTED_MEDIA','视频只接受视频和封面');
    if(draft.media.filter(m=>m.kind==='cover').length>1)throw new SyncError('COVER_LIMIT','当前候选流程只接受一个封面');
    if(this.platform==='douyin'&&draft.media.some(m=>m.kind==='cover'&&m.mime==='image/gif'))throw new SyncError('COVER_TYPE','抖音封面不接受GIF，请选择PNG、JPEG或WebP');
    if(draft.media.some(m=>m.kind==='cover')&&!['kuaishou','bilibili','douyin'].includes(this.platform))throw new SyncError('COVER_UNVERIFIED','此平台封面槽尚未实测，不能自动选择；本地封面已保留');
    if(this.platform==='channels'&&draft.type==='post'){if(draft.media.length<1||draft.media.length>18)throw new SyncError('MEDIA_LIMIT','视频号图文需要1至18张图片');if(draft.title.length>22)throw new SyncError('TITLE_TOO_LONG','视频号图文标题最多22个字符');if(!draft.textAsImages&&[draft.markdown,draft.tags.map(t=>'#'+t.replace(/^#/,'' )).join(' ')].filter(Boolean).join('\n\n').length>1000)throw new SyncError('BODY_TOO_LONG','视频号图文描述和标签合计最多1000个字符');}
    if(draft.type==='post'&&this.platform==='x'&&draft.media.length>4)throw new SyncError('MEDIA_LIMIT','X动态最多4张图片');
    if(draft.type==='post'&&['douyin','kuaishou','xiaohongshu'].includes(this.platform)&&!draft.media.length)throw new SyncError('IMAGE_REQUIRED','此平台图文动态需要至少一张图片');
    if(this.platform==='kuaishou'&&draft.type==='post'){if(draft.media.length>31)throw new SyncError('MEDIA_LIMIT','当前快手图文页面最多31张图片');if(editorBody(draft,false).length>500)throw new SyncError('BODY_TOO_LONG','当前快手图文描述合计最多500字');if(draft.media.some(m=>m.mime==='image/gif'))throw new SyncError('MEDIA_TYPE','快手图文不支持GIF');}
    if(this.platform==='douyin'&&draft.type!=='post'&&[draft.markdown,draft.tags.map(t=>'#'+t).join(' ')].filter(Boolean).join('\n\n').length>1000)throw new SyncError('BODY_TOO_LONG','当前抖音描述及标签合计最多1000字');
    if(this.platform==='xiaohongshu'){if(draft.title.length>20)throw new SyncError('TITLE_TOO_LONG','小红书候选标题最多20字');if(draft.type!=='post'&&[draft.markdown,draft.tags.map(t=>'#'+t).join(' ')].filter(Boolean).join('\n\n').length>1000)throw new SyncError('BODY_TOO_LONG','小红书描述最多1000字');if(draft.media.filter(m=>m.kind==='image').length>18)throw new SyncError('MEDIA_LIMIT','小红书图文最多18张图片');if(draft.media.some(m=>m.mime==='image/gif'))throw new SyncError('MEDIA_TYPE','小红书网页图文不接受GIF');}
    if(this.platform==='bilibili'&&draft.type==='post'&&draft.title.length>20)throw new SyncError('TITLE_TOO_LONG','B站动态候选标题最多20字');
    if(this.platform==='douyin'&&draft.title.length>(draft.type==='post'?20:30))throw new SyncError('TITLE_TOO_LONG',draft.type==='post'?'当前抖音图文标题最多20字':'当前抖音视频标题最多30字');
    if(this.platform==='jike'&&draft.media.length>9)throw new SyncError('MEDIA_LIMIT','当前即刻适配器一次最多9张图片（适配器限制）');
  }
  async openEditor(task:PublishTask){
    if(!await this.permission(task.snapshot.type))throw new SyncError('PERMISSION_REQUIRED',`请在设置与账号中连接${platformFor(this.platform).name}，授权${platformOrigins(this.platform,task.snapshot.type).join('、')}站点访问后再试`);
    const profile=fillProfile(this.platform,task.snapshot.type)!;
    let tab:chrome.tabs.Tab|undefined;
    if(task.tabId){try{tab=await chrome.tabs.get(task.tabId);}catch{}}
    if(tab?.id&&(!tab.url||new URL(tab.url).origin!==new URL(profile.url).origin))throw new SyncError('PAGE_CHANGED','任务页离开目标平台，请先核对已填写内容',false);
    if(!tab?.id){
      if(this.platform==='kuaishou'&&task.snapshot.type==='post'){for(const other of await chrome.tabs.query({url:'https://cp.kuaishou.com/*'})){if(!other.id)continue;try{const existing=await this.native(other.id,profile,'read',{...this.payload(task),text:'',title:''});if(existing.body||existing.images.length||existing.imageItems)throw new SyncError('EDITOR_OCCUPIED','快手已有打开的图文编辑稿，平台会恢复其附件；请先在平台保留并完成该稿。本次未上传');}catch(error){if(error instanceof SyncError)throw error;throw new SyncError('EDITOR_STATE_UNKNOWN','已有快手页面无法核对，先保留并处理原页面，本次未上传');}}}
      tab=await createTaskTab(task,profile.url);
    }
    if(!tab.id)throw new SyncError('TAB_UNAVAILABLE','无法打开平台任务页');
    let activated=false;
    if(['kuaishou','bilibili'].includes(this.platform)&&task.snapshot.type==='post'&&task.source){const source=await chrome.tabs.get(task.source.tabId).catch(()=>undefined);if(source?.active){await chrome.tabs.update(tab.id,{active:true});activated=true;}}
    const readyTab=async()=>{if(['kuaishou','bilibili'].includes(this.platform)&&task.snapshot.type==='post'){let stamp='',stable=0;for(let j=0;j<40;j++){const read=await this.native(tab!.id!,profile,'read',this.payload(task));const next=JSON.stringify([read.body,read.title,read.images,read.imageItems,read.uploadBusy]);stable=next===stamp?stable+1:1;stamp=next;if(j>=9&&stable>=5&&!read.uploadBusy)break;if(j===39)throw new SyncError('EDITOR_UNAVAILABLE',platformFor(this.platform).name+'图文原稿尚未稳定，未交付附件');await sleep(250);}}if(activated&&task.source){const active=(await chrome.tabs.query({windowId:task.source.windowId,active:true}))[0];if(active?.id===tab!.id)await chrome.tabs.update(task.source.tabId,{active:true}).catch(()=>{});}return tab!.id!;};
    for(let i=0;i<180;i++){
      const current=await chrome.tabs.get(tab.id);
      if(current.url?.startsWith('chrome-error://'))throw new SyncError('PAGE_LOAD_FAILED','平台任务页显示浏览器错误页，尚未进入编辑器');
      if(current.url&&new URL(current.url).origin===new URL(profile.url).origin){
        const ready=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:nativePostReady,args:[profile]}).catch(error=>{const mapped=errorValue(error);if(mapped.code==='PAGE_LOAD_FAILED')throw new SyncError(mapped.code,mapped.message);return [];});
        const state=ready[0]?.result;if(state?.error&&!(this.platform==='channels'&&state.error==='此报错可以忽略，iframe主动中断主应用代码在子应用运行'))throw new SyncError('EDITOR_DETECTION_FAILED',state.error);if(state?.verification)throw new SyncError('VERIFICATION_REQUIRED','平台要求安全验证，尚未填写');if(state?.login==='logged_out')throw new SyncError('LOGIN_REQUIRED','平台登录已失效，尚未填写');if(state?.ready)return readyTab();
        if(['x','channels','jike'].includes(this.platform)&&i===12&&task.source){const source=await chrome.tabs.get(task.source.tabId).catch(()=>undefined);if(source?.active){await chrome.tabs.update(tab.id,{active:true});activated=true;await log('editor_foreground_required',`${platformFor(this.platform).name}后台编辑器尚未渲染，临时打开任务页，字段就绪后返回工作台`,task.id);}}
        if(profile.entrySelector&&current.status==='complete'){const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:activateNativePost,args:[profile]});if(result[0]?.result){const after=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:nativePostReady,args:[profile]});if(after[0]?.result?.ready)return readyTab();}}
      }else if(current.status==='complete')throw new SyncError('PAGE_CHANGED','任务页离开目标平台，本次停止');
      await sleep(250);
    }
    throw new SyncError('PAGE_TIMEOUT','进入动态编辑器超时：未找到当前类型的字段或图片上传入口');
  }
  private async native(tabId:number,profile:FillProfile,action:Parameters<typeof nativeFillEditor>[1],payload:Parameters<typeof nativeFillEditor>[2]){
    if(!await this.permission(profile.type))throw new SyncError('PERMISSION_REQUIRED','平台权限已取消');
    const current=await chrome.tabs.get(tabId);if(!current.url||new URL(current.url).origin!==new URL(profile.url).origin)throw new SyncError('PAGE_CHANGED','平台页面已变化',false);
    for(let i=0;i<(action==='read'?20:1);i++){
      const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeFillEditor,args:[profile,action,payload,true]});
      if(result[0]?.result?.error){if(action==='read'&&profile.platform==='channels'&&result[0].result.error==='此报错可以忽略，iframe主动中断主应用代码在子应用运行'){await sleep(250);continue;}throw new SyncError('EDITOR_SCRIPT_FAILED',result[0].result.error);}
      if(result[0]?.result)return result[0].result;
      if(action==='read')await sleep(250);
    }
    throw new SyncError('EDITOR_UNAVAILABLE',`编辑器${action==='read'?'回读':'输入'}未返回结果（${profile.platform}），未重复写入`);
  }
  private payload(task:PublishTask){const p=fillProfile(task.platform,task.snapshot.type)!;return {targetId:task.targetId,title:task.snapshot.title,text:editorBody(task.snapshot,!!p.title),video:task.snapshot.type==='video',expectedImages:task.snapshot.media.filter(m=>m.kind==='image').length,videoName:task.snapshot.media.find(m=>m.kind==='video')?.name,videoBytes:task.snapshot.media.find(m=>m.kind==='video')?.bytes};}
  private async observe(task:PublishTask,tabId:number,action:'read'|'fill'='read',includeCovers=true):Promise<EditorObservation>{
    const p=fillProfile(task.platform,task.snapshot.type)!;const persisted=await(await db()).get('tasks',task.id);const proof=persisted?.proof||task.proof;const video=task.snapshot.media.find(m=>m.kind==='video');const r=await this.native(tabId,p,action,{...this.payload(task),ownedVideoUpload:!!video&&!!proof?.uploadedMediaIds?.includes(video.id)});
    const recordedVideo=this.platform==='douyin'&&!!video&&!!proof?.uploadedMediaIds?.includes(video.id)&&!!r.videoIdentity&&r.videoIdentity.startsWith((p.processedVideoOrigin||'unavailable')+'/')&&!r.uploadBusy&&proof?.mediaHashes[0]===await hash(r.videoIdentity);
    const identities=task.snapshot.type==='video'?((r.videoReady||recordedVideo)&&r.videoIdentity?[r.videoIdentity]:[]):[...r.images];
    if(includeCovers&&task.snapshot.media.some(m=>m.kind==='cover'))identities.push(...(await this.cover(tabId,'read')).identities);
    return {title:r.title,bodyMatched:r.bodyMatched,formatMatched:true,bodyDigest:await hash(r.body),mediaHashes:await Promise.all(identities.map(hash)),mediaCount:identities.length,imageItems:r.imageItems,remoteMediaReady:r.remoteMediaReady,uploadBusy:r.uploadBusy,editorFound:r.editorFound,login:r.login as EditorObservation['login'],notice:r.notice,fieldState:r.fieldState};
  }
  private async waitForFields(task:PublishTask,tabId:number,initial:EditorObservation){
    let read=initial;let stable=0;const profile=fillProfile(task.platform,task.snapshot.type)!;
    for(let i=0;i<40;i++){
      if(read.editorFound&&read.bodyMatched&&(!profile.title||read.title===task.snapshot.title)){if(++stable>=2)return read;}else stable=0;
      if(read.login==='logged_out')throw new SyncError('LOGIN_REQUIRED','平台登录已失效');
      await sleep(250);read=await this.observe(task,tabId,'read',false);
    }
    const detail=read.fieldState;
    await log('editor_readback_mismatch',JSON.stringify({editorFound:read.editorFound,bodyMatched:read.bodyMatched,titleMatched:!profile.title||read.title===task.snapshot.title,...detail}),task.id);
    throw new SyncError('READBACK_FAILED',`填写后等待10秒，标题或正文仍未通过稳定回读${detail?`（正文${detail.actualCharacters}/${detail.expectedCharacters}字${detail.nativeCharacters===undefined?'':`，原生计数${detail.nativeCharacters}字`}，${detail.modelMatched?'模型已更新':'模型未更新'}）`:''}`);
  }
  private async cover(tabId:number,action:Parameters<typeof nativeCoverEditor>[1],ownedCoverUpload=false){
    if(!await this.permission('video'))throw new SyncError('PERMISSION_REQUIRED','平台权限已取消');
    const tab=await chrome.tabs.get(tabId);if(!tab.url||new URL(tab.url).origin!==platformFor(this.platform).origin)throw new SyncError('PAGE_CHANGED','封面页来源变化',false);
    const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeCoverEditor,args:[this.platform,action,ownedCoverUpload]});
    if(!result[0]?.result)throw new SyncError('COVER_UNAVAILABLE','封面编辑器未响应',false);return result[0].result;
  }
  private async upload(task:PublishTask,tabId:number,media:ContentDraft['media'][number]){
    const stored=await(await db()).get('media',media.id);if(!stored||stored.blob.size!==media.bytes)throw new SyncError('MEDIA_MISSING','本地附件不完整');
    await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/media-transfer.js']});
    const send=async(action:string,extra:Record<string,unknown>={})=>{if(!await this.permission(task.snapshot.type))throw new SyncError('PERMISSION_REQUIRED','平台权限已取消');const tab=await chrome.tabs.get(tabId);if(!tab.url||!platformOrigins(task.platform,task.snapshot.type).includes(new URL(tab.url).origin))throw new SyncError('PAGE_CHANGED','上传页已离开平台',false);const result=await chrome.tabs.sendMessage(tabId,{channel:'ling-sync-media-v5',version:5,platform:task.platform,type:task.snapshot.type,targetId:task.targetId,key:task.id+':'+task.attemptId+':'+media.id,action,...extra});if(!result?.ok)throw new SyncError('MEDIA_TRANSFER',result?.error||'附件传输中断');};
    let committing=false;
    try {
      let ready=false;for(let i=0;i<60;i++){try{await send('probe',{media});ready=true;break;}catch(error){if(!(error instanceof SyncError)||error.code!=='MEDIA_TRANSFER')throw error;await sleep(500);}}
      if(!ready)throw new SyncError('UPLOAD_INPUT_UNAVAILABLE','平台附件控件尚未就绪，未交付附件');
      await send('begin',{media});
      for await(const chunk of mediaChunks(stored.blob))await send('chunk',{index:chunk.index,chunk:chunk.chunk});
      const current=await(await db()).get('tasks',task.id);
      // Commit uncertainty before the normal platform input/change event can upload.
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:current?.proof?.bodyDigest||await hash(''),mediaHashes:current?.proof?.mediaHashes||[],uploadedMediaIds:[...new Set([...(current?.proof?.uploadedMediaIds||[]),media.id])]},progress:'准备交给平台上传，后续中断须先核对'});
      committing=true;await send('commit');
    } catch(error) {
      try{await send('abort');}catch{}
      if(committing)throw new SyncError('UPLOAD_UNCONFIRMED','已准备触发平台上传，但回执未确认；请先核对已有上传。'+(error instanceof SyncError?error.message:'传输或页面连接中断'),false);
      throw error;
    }
  }
  private async verifyUploadedImage(task:PublishTask,tabId:number,mediaId:string,readOnlyRecovery=false){
    const profile=fillProfile(task.platform,task.snapshot.type)!;
    const native=await this.native(tabId,profile,'read',this.payload(task));
    const identity=native.images.at(-1);
    if(!identity?.startsWith('blob-sha256:')&&!identity?.startsWith('data-sha256:')){if(readOnlyRecovery)throw new SyncError('MEDIA_IDENTITY','X只读恢复需要可核对完整字节的本地预览，禁止按地址或数量放行',false);return;}
    const local=await(await db()).get('media',mediaId);if(!local||local.blob.size!==task.snapshot.media.find(m=>m.id===mediaId)?.bytes)throw new SyncError('MEDIA_MISSING','本地图片缺失或不完整',false);
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await local.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(identity.split(':').at(-1)===digest&&!readOnlyRecovery)return;
    if(task.platform!=='x'||task.snapshot.type!=='post')throw new SyncError('MEDIA_IDENTITY','平台本地预览与入队图片不一致',false);
    // X may re-encode a PNG before creating its local Blob preview. Accept only
    // exact RGBA pixels, or the exact observed white-canvas JPEG .85 encoding,
    // bound to this task's ordered upload prefix. Resizing is never inferred.
    const current=await(await db()).get('tasks',task.id),count=task.snapshot.media.findIndex(m=>m.id===mediaId)+1;
    const prefix=task.snapshot.media.slice(0,count),owned=current?.proof?.uploadedMediaIds;
    if(!current||(readOnlyRecovery?!['unknown','failed'].includes(current.status):current.status!=='preparing')||current.publicationAttemptedAt||current.tabId!==tabId||count<1||native.uploadBusy||native.images.length!==count||native.imageItems!==undefined&&native.imageItems!==count||!owned||owned.length!==count||prefix.some((m,i)=>m.kind!=='image'||owned[i]!==m.id)||native.images.some(src=>!src.startsWith('blob-sha256:')&&!src.startsWith('data-sha256:')))throw new SyncError('MEDIA_IDENTITY','X预览字节变化，但本任务上传归属或图片顺序不完整，禁止发布',false);
    try{
      if(readOnlyRecovery){
        const exact=await Promise.all(prefix.map(async(ref,index)=>{const stored=await(await db()).get('media',ref.id);if(!stored||stored.blob.size!==ref.bytes)return false;const bytes=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await stored.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');return native.images[index]?.split(':').at(-1)===bytes;}));
        if(exact.every(Boolean))return;
      }
      const expected:string[]=[];
      for(const ref of prefix){
        const stored=await(await db()).get('media',ref.id);if(!stored||stored.blob.size!==ref.bytes||!/^image\/(png|jpeg|webp)$/.test(stored.blob.type)||!stored.blob.size||stored.blob.size>15*1024*1024)throw new Error('本地原图不可核对');
        const image=await createImageBitmap(stored.blob,{colorSpaceConversion:'none'});
        if(!image.width||!image.height||image.width*image.height>32_000_000){image.close();throw new Error('原图尺寸不可核对');}
        const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d',{colorSpace:'srgb'});
        if(!ctx){image.close();throw new Error('像素核对不可用');}ctx.drawImage(image,0,0);image.close();
        const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;if(rgba.length!==canvas.width*canvas.height*4)throw new Error('完整像素不可读取');
        const pixels=[...new Uint8Array(await crypto.subtle.digest('SHA-256',rgba))].map(v=>v.toString(16).padStart(2,'0')).join('');expected.push(`pixels-sha256:${canvas.width}:${canvas.height}:${pixels}`);
      }
      const pixels=await this.native(tabId,profile,'read',{...this.payload(task),verifyImagePixels:true});
      let encoding='完整RGBA';
      if(!sameMedia(pixels.images,expected)){
        const originals:Array<{base64:string;digest:string}>=[];
        for(const ref of prefix){const stored=await(await db()).get('media',ref.id);if(!stored||stored.blob.type!=='image/png')throw new Error('此转换只接受PNG原图');const bytes=new Uint8Array(await stored.blob.arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));originals.push({base64:btoa(binary),digest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')});}
        const converted=await this.native(tabId,profile,'read',{...this.payload(task),verifyXOriginals:originals});
        if(converted.uploadBusy||converted.images.length!==count||converted.imageItems!==undefined&&converted.imageItems!==count||converted.images.some((identity,index)=>{const parts=identity.split(':');return parts.length!==4||parts[0]!=='x-jpeg85-sha256'||parts[1]!==originals[index]?.digest||parts[2]!==parts[3]||parts[3]!==native.images[index]?.split(':').at(-1);}))throw new Error('平台确定转换的完整字节或顺序不一致');
        encoding='白底JPEG质量0.85的完整SHA-256';
      }
      const after=await this.native(tabId,profile,'read',this.payload(task));
      if(pixels.uploadBusy||after.uploadBusy||!sameMedia(after.images,native.images)||pixels.imageItems!==undefined&&pixels.imageItems!==count||after.imageItems!==undefined&&after.imageItems!==count)throw new Error('原尺寸、完整RGBA或顺序不一致');
      await log('image_encoding_verified',`X本地预览字节变化，已按本任务有序上传前缀核对${encoding}一致`,task.id);
    }catch(error){if(error instanceof SyncError)throw error;throw new SyncError('MEDIA_IDENTITY','X预览编码变化后，原像素或平台确定转换的完整字节与顺序仍无法证明一致，禁止发布',false);}
  }
  private async uploadImagesBatch(task:PublishTask,tabId:number){
    if(task.snapshot.media.reduce((n,m)=>n+m.bytes,0)>64*1024*1024)throw new SyncError('BATCH_LIMIT','当前批量图文附件合计最多64MiB（本地限制）');
    if(task.platform==='bilibili'){
      let picker:Array<{result?:Awaited<ReturnType<typeof prepareBiliImageInput>>}>=[];
      for(let i=0;i<8;i++){
        picker=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:prepareBiliImageInput});
        if(picker[0]?.result?.ready)break;
        const error=picker[0]?.result?.error||'B站正常图片选择器未就绪';
        if(!/未产生唯一文件选择器/.test(error)||i===7)throw new SyncError('UPLOAD_INPUT_UNAVAILABLE',error+'，未交付图片');
        const observed=await this.native(tabId,fillProfile('bilibili','post')!,'read',this.payload(task));
        if(observed.images.length||observed.imageItems)throw new SyncError('MEDIA_IDENTITY','选择器等待期间出现附件，停止再次打开选择器',false);
        await sleep(250);
      }
      const selected=picker[0]?.result;if(!selected?.ready)throw new SyncError('UPLOAD_INPUT_UNAVAILABLE','B站图片选择器未就绪，未交付图片');
      await log('native_image_picker_ready',`B站正常图片选择器：accept=${selected.accept}；multiple=${selected.multiple}`,task.id);
      if(task.snapshot.media.length>1&&!selected.multiple)throw new SyncError('MEDIA_LIMIT','B站当前正常选择器不接受多图，未交付图片');
    }
    await chrome.scripting.executeScript({target:{tabId},files:['content-scripts/media-transfer.js']});
    const key=task.id+':'+task.attemptId+':batch';let committing=false;
    const send=async(action:string,extra:Record<string,unknown>={})=>{if(!await this.permission(task.snapshot.type))throw new SyncError('PERMISSION_REQUIRED','附件站点权限已取消');const tab=await chrome.tabs.get(tabId);if(!tab.url||!platformOrigins(task.platform,task.snapshot.type).includes(new URL(tab.url).origin))throw new SyncError('PAGE_CHANGED','附件页面来源变化',false);const r=await chrome.tabs.sendMessage(tabId,{channel:'ling-sync-media-v5',version:5,type:task.snapshot.type,platform:task.platform,targetId:task.targetId,key,action,...extra});if(!r?.ok)throw new SyncError('MEDIA_TRANSFER',r?.error||'批量附件传输中断');};
    try {
      let ready=false;for(let i=0;i<60;i++){try{await send('probe',{media:task.snapshot.media[0]});ready=true;break;}catch(error){if(!(error instanceof SyncError)||error.code!=='MEDIA_TRANSFER')throw error;await sleep(500);}}if(!ready)throw new SyncError('UPLOAD_INPUT_UNAVAILABLE','图文上传入口未就绪，未交付图片');
      for(const media of task.snapshot.media){const stored=await(await db()).get('media',media.id);if(!stored||stored.blob.size!==media.bytes)throw new SyncError('MEDIA_MISSING','本地图片不完整');await send('begin',{media});for await(const chunk of mediaChunks(stored.blob))await send('chunk',{index:chunk.index,chunk:chunk.chunk});await send('stage');}
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:await hash(''),mediaHashes:[],uploadedMediaIds:task.snapshot.media.map(m=>m.id)},progress:'准备一次交付有序多图，后续中断须核对'});committing=true;await send('commit_batch');
    } catch(error){try{await send('abort');}catch{}if(committing)throw new SyncError('UPLOAD_UNCONFIRMED','批量图片已准备交付平台，结果待核对，禁止重传',false);throw error;}
  }
  async fillEditor(task:PublishTask,tabId:number){
    let activated=false;
    if(task.snapshot.type==='post'&&['channels','kuaishou','bilibili','jike'].includes(task.platform)&&task.source){const source=await chrome.tabs.get(task.source.tabId).catch(()=>undefined);if(source?.active){await chrome.tabs.update(tabId,{active:true});activated=true;}}
    try{return await this.fillPreparedEditor(task,tabId);}
    finally{if(activated&&task.source){const active=(await chrome.tabs.query({windowId:task.source.windowId,active:true}))[0];if(active?.id===tabId)await chrome.tabs.update(task.source.tabId,{active:true}).catch(()=>{});}}
  }
  private async fillPreparedEditor(task:PublishTask,tabId:number){
    await prepareJikeTarget({...task,tabId});
    let r:EditorObservation|undefined;const isVideo=task.snapshot.type==='video';const mediaFirst=isVideo||!!fillProfile(this.platform,task.snapshot.type)?.mediaFirst;
    // Video fields often appear only after upload. Recover the recorded upload; never resend it.
    const uploaded=new Set(task.proof?.uploadedMediaIds||[]);
    if(mediaFirst&&uploaded.size){r=await this.observe(task,tabId,'read',task.snapshot.media.some(m=>m.kind==='cover'&&uploaded.has(m.id)));if(!r.mediaCount)throw new SyncError('UPLOAD_STILL_PENDING','已交付媒体尚未核对，不能继续上传其他附件',false);}
    if(mediaFirst&&!uploaded.size){
      let initial=await this.native(tabId,fillProfile(task.platform,task.snapshot.type)!,'read',this.payload(task));
      for(let i=0;i<60&&!initial.uploadInputReady&&!initial.hasVideoMedia&&initial.login!=='logged_out';i++){await sleep(500);initial=await this.native(tabId,fillProfile(task.platform,task.snapshot.type)!,'read',this.payload(task));}
      if(!initial.uploadInputReady&&!initial.hasVideoMedia&&initial.login!=='logged_out')throw new SyncError('UPLOAD_INPUT_UNAVAILABLE','平台上传控件尚未就绪，未交付附件');
      if(!isVideo){let stamp='',stable=0;for(let i=0;i<32;i++){const next=JSON.stringify([initial.body,initial.title,initial.images,initial.imageItems,initial.uploadBusy]);stable=next===stamp?stable+1:1;stamp=next;if(initial.images.length||initial.imageItems||initial.body&&!initial.bodyMatched||initial.title&&initial.title!==task.snapshot.title)break;if(stable>=5&&!initial.uploadBusy)break;await sleep(250);initial=await this.native(tabId,fillProfile(task.platform,task.snapshot.type)!,'read',this.payload(task));}if((stable<5||initial.uploadBusy)&&!initial.images.length&&!initial.imageItems&&(!initial.body||initial.bodyMatched)&&(!initial.title||initial.title===task.snapshot.title))throw new SyncError('EDITOR_UNAVAILABLE','图文原稿状态尚未稳定，未交付附件');}
      if(initial.login==='logged_out')throw new SyncError('LOGIN_REQUIRED','请在任务页正常登录平台');
      if(!isVideo&&(initial.images.length||initial.imageItems))throw new SyncError('MEDIA_IDENTITY','图文编辑器已有其他图片，保留原稿',false);
      if(initial.hasVideoMedia)throw new SyncError('MEDIA_IDENTITY','视频编辑器已有附件，不能覆盖或重复上传',false);
      if(initial.body&&!initial.bodyMatched||initial.title&&initial.title!==task.snapshot.title)throw new SyncError('EDITOR_OCCUPIED','编辑器已有其他内容，停止填写',false);
    }
    if(!mediaFirst){for(let i=0;i<60;i++){const ready=await this.observe(task,tabId,'read',false);if(ready.editorFound||ready.login==='logged_out')break;await sleep(500);}const existing=await this.native(tabId,fillProfile(task.platform,task.snapshot.type)!,'read',this.payload(task));if(existing.imageItems&&existing.imageItems>uploaded.size||!knownUploadPrefix((await this.observe(task,tabId,'read',false)).mediaHashes,task.proof?.mediaHashes))throw new SyncError('MEDIA_IDENTITY','平台恢复了未归属本任务的图片，保留原稿，本次未上传',false);if(existing.body&&!existing.bodyMatched)throw new SyncError('EDITOR_OCCUPIED',task.platform==='zsxq'?'知识星球恢复了另一份旧草稿，已保护原稿，本次未填写或发布。请先在平台保存并处理原稿后再试；重复开始不会替换旧稿。':'平台恢复了其他草稿，本次没有覆盖或上传附件；请先在平台保留并处理该草稿');if(existing.title&&existing.title!==task.snapshot.title)throw new SyncError('EDITOR_OCCUPIED','平台已有其他标题，本次没有覆盖或上传附件');r=await this.observe(task,tabId,'fill');if(r.login==='logged_out')throw new SyncError('LOGIN_REQUIRED','平台登录已失效');r=await this.waitForFields(task,tabId,r);if(!r.bodyMatched)throw new SyncError('READBACK_FAILED','动态正文未通过稳定回读');if(!knownUploadPrefix(r.mediaHashes,task.proof?.mediaHashes))throw new SyncError('MEDIA_IDENTITY','平台已有未记录附件，停止重复上传',false);}
    if(!isVideo&&fillProfile(this.platform,task.snapshot.type)?.batchImages&&task.snapshot.media.length&&!uploaded.size){
      await this.uploadImagesBatch(task,tabId);for(const m of task.snapshot.media)uploaded.add(m.id);let ready=false;let stable=0;let stableImages='';
      for(let i=0;i<240;i++){await sleep(250);r=await this.observe(task,tabId,'read');if(r.imageItems!==undefined&&r.imageItems>task.snapshot.media.length)throw new SyncError('UNEXPECTED_MEDIA','平台恢复了额外图片，保留原稿和本次附件，请人工核对，禁止重传',false);if(r.editorFound&&(this.platform!=='weixin'||r.remoteMediaReady)&&r.mediaCount===task.snapshot.media.length&&!r.uploadBusy&&(r.imageItems===undefined||r.imageItems===task.snapshot.media.length)){const identity=r.mediaHashes.join('|');stable=identity===stableImages?stable+1:1;stableImages=identity;if(stable>=2){ready=true;break;}}else {stable=0;stableImages='';}}
      if(!ready)throw new SyncError('UPLOAD_UNCONFIRMED','批量图片结果待人工核对，不重复交付',false);
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:r!.bodyDigest,mediaHashes:r!.mediaHashes,uploadedMediaIds:[...uploaded]}});
    }
    const ordered=isVideo?[...task.snapshot.media].sort((a,b)=>Number(a.kind==='cover')-Number(b.kind==='cover')):task.snapshot.media;
    for(const media of ordered){
      if(uploaded.has(media.id))continue;
      if(!isVideo&&r&&r.mediaCount>uploaded.size)throw new SyncError('MEDIA_IDENTITY','已有附件尚未确认身份',false);
      const previousHashes=r?.mediaHashes||[];
      let previousCovers:string[]=[];let previousSlots:string[]=[];
      if(media.kind==='cover'){
        const beforeCover=await this.cover(tabId,'read');previousCovers=beforeCover.identities;previousSlots=beforeCover.slotHashes||[];
        await this.cover(tabId,'open');
        for(let i=0;i<30;i++){if((await this.cover(tabId,'read')).dialogOpen)break;await sleep(200);}
        await this.cover(tabId,'choose_upload');
      }
      await this.upload(task,tabId,media);uploaded.add(media.id);
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:r?.bodyDigest||await hash(''),mediaHashes:r?.mediaHashes||[],uploadedMediaIds:[...uploaded]},progress:'附件已进入平台编辑器，正在核对'});
      if(media.kind==='cover'){
        if(task.platform==='douyin'){let switched=false;for(let i=0;i<60;i++){try{await this.cover(tabId,'next_ratio',true);switched=true;break;}catch{await sleep(500);}}if(!switched)throw new SyncError('COVER_UNCONFIRMED','已交付竖封面，横封面切换待核对，禁止重新上传',false);}
        // A file selection is insufficient: the normal cover panel must enable its
        // confirmation action, then the persisted preview must change identity.
        let confirmed=false;for(let i=0;i<60;i++){try{await this.cover(tabId,'confirm');confirmed=true;break;}catch{await sleep(500);}}
        if(!confirmed)throw new SyncError('COVER_UNCONFIRMED','封面确认结果不明，先核对，不重新上传',false);
      }
      let accepted=false;
      for(let i=0;i<240;i++){
        await sleep(500);r=await this.observe(task,tabId,'read',media.kind==='cover'||task.snapshot.media.some(m=>m.kind==='cover'&&uploaded.has(m.id)));await updateTask(task.id,['preparing'],{progress:r.notice||'平台正在处理附件'});
        const coverResult=media.kind==='cover'?await this.cover(tabId,'read'):undefined;const newCover=!coverResult||!coverResult.identities.every((identity,index)=>identity===previousCovers[index])&&(task.platform!=='douyin'||coverResult.slotHashes.length===2&&coverResult.slotHashes.every((identity,index)=>identity!==previousSlots[index]));
        if(r.editorFound&&r.mediaCount===uploaded.size&&newCover){accepted=true;break;}
      }
      if(accepted&&!isVideo)await this.verifyUploadedImage(task,tabId,media.id);
      if(accepted&&media.kind==='video'&&(fillProfile(task.platform,task.snapshot.type)!.localVideoPreview||fillProfile(task.platform,task.snapshot.type)!.fileVideoReceipt)){
        const local=await(await db()).get('media',media.id);if(!local)throw new SyncError('MEDIA_MISSING','本地视频缺失',false);
        let chain=new Uint8Array(32);
        for(let offset=0;offset<local.blob.size;offset+=96*1024){const part=new Uint8Array(await local.blob.slice(offset,offset+96*1024).arrayBuffer());const joined=new Uint8Array(chain.length+part.length);joined.set(chain);joined.set(part,chain.length);chain=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));}
        const identity=(fillProfile(task.platform,task.snapshot.type)!.fileVideoReceipt?'native-video-chain256:':'blob-video-chain256:')+local.blob.size+':'+[...chain].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(r!.mediaHashes[0]!==await hash(identity))throw new SyncError('MEDIA_IDENTITY','平台本地视频预览与入队文件不一致',false);
      }
      if(!accepted)throw new SyncError('UPLOAD_UNCONFIRMED','平台上传结果待核对，不能重新上传',false);
      if(!isVideo&&previousHashes.length&&!sameMedia(r!.mediaHashes.slice(0,previousHashes.length),previousHashes))throw new SyncError('MEDIA_ORDER','平台附件身份或顺序变化',false);
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:r!.bodyDigest,mediaHashes:r!.mediaHashes,uploadedMediaIds:[...uploaded]}});
    }
    r=await this.observe(task,tabId,mediaFirst||isVideo?'fill':'read');if(!isVideo)r=await this.waitForFields(task,tabId,r);const p=fillProfile(task.platform,task.snapshot.type)!;
    if(!r.bodyMatched||!r.editorFound||(p.title&&r.title!==task.snapshot.title)||r.mediaCount!==task.snapshot.media.length||r.imageItems!==undefined&&r.imageItems!==task.snapshot.media.length)throw new SyncError('READBACK_FAILED','平台文字或附件未核对一致；已上传内容需先核对',!uploaded.size);
    if(task.platform==='channels'&&task.operation==='save_draft'){let remote:string[]=[];for(let i=0;i<60;i++){const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeChannelsDraft,args:['inspect']});remote=result[0]?.result?.remoteMediaHashes||[];if(remote.length===1)break;await sleep(500);}if(remote.length!==1)throw new SyncError('REMOTE_VIDEO_UNCONFIRMED','平台草稿视频身份尚未确认，先核对已有上传',false);const current=await(await db()).get('tasks',task.id);await updateTask(task.id,['preparing'],{proof:{...current!.proof!,remoteMediaHashes:remote}});}
    if(task.platform==='jike')await readJikeTarget(tabId,'verify',task.targetId);
    return r;
  }
  private async recoverVideoEditor(task:PublishTask,metadata?:VideoMetadata){
    const video=task.snapshot.media.find(m=>m.kind==='video');const expected=video?.duration&&video.width&&video.height?{duration:video.duration,width:video.width,height:video.height}:metadata;
    if(task.platform!=='douyin'||task.operation!=='fill'||task.status!=='unknown'||task.publicationAttemptedAt||task.error?.code!=='UPLOAD_UNCONFIRMED'||!task.tabId||!video||!expected||task.proof?.uploadedMediaIds?.length!==1||task.proof.uploadedMediaIds[0]!==video.id)throw new SyncError('UNSAFE_RECOVERY','此视频任务需人工核对，不能自动继续',false);
    const p=fillProfile(task.platform,'video')!;const r=await this.native(task.tabId,p,'read',{...this.payload(task),ownedVideoUpload:true,expectedVideoDuration:expected.duration,expectedVideoWidth:expected.width,expectedVideoHeight:expected.height});
    if(!r.videoReady||!r.videoIdentity||!r.editorFound||r.body&&!r.bodyMatched||r.title&&r.title!==task.snapshot.title)throw new SyncError('UPLOAD_STILL_PENDING','原页的视频身份、尺寸、时长或字段尚未核对，不重传',false);
    await updateTask(task.id,['unknown'],{status:'preparing',proof:{...task.proof,mediaHashes:[await hash(r.videoIdentity)]},progress:'已核对晚到视频，只继续尚未交付的附件和空字段'});
    try{const current=await(await db()).get('tasks',task.id);const result=await this.fillEditor(current!,task.tabId);const persisted=await(await db()).get('tasks',task.id);return {proof:{...persisted!.proof!,bodyDigest:result.bodyDigest,mediaHashes:result.mediaHashes},evidence:{kind:'editor_readback' as const,checkedAt:Date.now(),bodyMatched:true,mediaCount:result.mediaCount,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:'核对原任务晚到视频和尺寸时长后继续未交付封面，未重新上传视频、未保存或发布'}};}
    catch(error){const latest=await(await db()).get('tasks',task.id);if(latest?.status==='preparing')await updateTask(task.id,['preparing'],{status:'unknown',progress:'继续填写仍待核对，不重传',error:{code:error instanceof SyncError?error.code:'FILL_UNCONFIRMED',message:error instanceof Error?error.message:'恢复结果待核对',retrySafe:false}});throw error;}
  }
  async recoverEditor(task:PublishTask,metadata?:VideoMetadata):Promise<{proof:NonNullable<PublishTask['proof']>;evidence:Evidence}>{
    if(task.snapshot.type==='video')return this.recoverVideoEditor(task,metadata);
    if(task.platform==='x'&&task.snapshot.type==='post'&&task.error?.code==='MEDIA_IDENTITY'){
      if(!['fill','publish'].includes(task.operation||'')||!['unknown','failed'].includes(task.status)||!task.tabId||task.publicationAttemptedAt||task.supersededByTaskId||!task.snapshot.media.length||task.snapshot.media.some((m,i)=>m.kind!=='image'||task.proof?.uploadedMediaIds?.[i]!==m.id)||task.proof?.uploadedMediaIds?.length!==task.snapshot.media.length)throw new SyncError('UNSAFE_RECOVERY','X任务上传归属不完整或已尝试发布，不能恢复',false);
      const before=await this.observe(task,task.tabId);if(!before.editorFound||!before.bodyMatched||before.uploadBusy||before.mediaCount!==task.snapshot.media.length||before.imageItems!==task.snapshot.media.length)throw new SyncError('FILL_UNCONFIRMED','X原页正文或图片尚未一致，只能核对，未补填或上传',false);
      await this.verifyUploadedImage(task,task.tabId,task.snapshot.media.at(-1)!.id,true);
      const after=await this.observe(task,task.tabId);if(!after.bodyMatched||after.uploadBusy||after.bodyDigest!==before.bodyDigest||!sameMedia(after.mediaHashes,before.mediaHashes)||after.imageItems!==before.imageItems)throw new SyncError('FILL_UNCONFIRMED','X核对期间原页内容变化，保持待核对',false);
      return {proof:{bodyDigest:after.bodyDigest,mediaHashes:after.mediaHashes,uploadedMediaIds:task.proof.uploadedMediaIds},evidence:{kind:'editor_readback',checkedAt:Date.now(),title:after.title,bodyMatched:true,mediaCount:after.mediaCount,mediaMatched:true,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:'只读核对本任务原页正文、完整图片字节或确定转换及顺序；未补填、上传或发布'}};
    }
    if(!['fill','publish'].includes(task.operation||'')||task.snapshot.type!=='post'||!task.tabId||task.publicationAttemptedAt||!['UPLOAD_UNCONFIRMED','READBACK_FAILED','FILL_UNCONFIRMED','EDITOR_UNAVAILABLE','EDITOR_SCRIPT_FAILED','MEDIA_ORDER'].includes(task.error?.code||''))throw new SyncError('UNSAFE_RECOVERY','此任务必须人工核对，不能自动补填',false);
    if(!task.snapshot.media.length||task.snapshot.media.some(m=>m.kind!=='image')||task.proof?.uploadedMediaIds?.length!==task.snapshot.media.length||task.snapshot.media.some(m=>!task.proof?.uploadedMediaIds?.includes(m.id)))throw new SyncError('MEDIA_IDENTITY_UNCONFIRMED','附件所有权不完整，不能恢复',false);
    const p=fillProfile(task.platform,task.snapshot.type)!;const payload={...this.payload(task),verifyImageBytes:true};const observed=await this.native(task.tabId,p,'read',payload);
    const expected:string[]=[];for(const ref of task.snapshot.media){const media=await(await db()).get('media',ref.id);if(!media)throw new SyncError('MEDIA_MISSING','原图片不可读取',false);expected.push([...new Uint8Array(await crypto.subtle.digest('SHA-256',await media.blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join(''));}
    if(observed.images.length!==expected.length||observed.images.some((identity,index)=>identity.split(':').at(-1)!==expected[index]))throw new SyncError('MEDIA_IDENTITY_UNCONFIRMED','已上传图片完整字节或顺序仍不一致，禁止重传',false);
    if(observed.body&&!observed.bodyMatched||observed.title&&observed.title!==task.snapshot.title)throw new SyncError('EDITOR_OCCUPIED','原页已有其他正文或标题，停止补填',false);
    const filled=await this.native(task.tabId,p,'fill',payload);if(filled.images.length!==expected.length||filled.images.some((identity,index)=>identity.split(':').at(-1)!==expected[index]))throw new SyncError('MEDIA_IDENTITY_UNCONFIRMED','补填期间附件变化，保持待核对',false);const r=await this.observe(task,task.tabId);
    if(!r.bodyMatched||(p.title&&r.title!==task.snapshot.title)||r.mediaCount!==expected.length)throw new SyncError('FILL_UNCONFIRMED','补填字段尚未核对',false);
    return {proof:{bodyDigest:r.bodyDigest,mediaHashes:r.mediaHashes,uploadedMediaIds:task.proof.uploadedMediaIds},evidence:{kind:'editor_readback' as const,checkedAt:Date.now(),title:r.title,bodyMatched:true,mediaCount:r.mediaCount,mediaMatched:true,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:'先逐字节核对原图片，再补填空字段；未上传、未保存或发布'}};
  }
  async preparePublication(task:PublishTask){
    if(task.platform==='xiaohongshu'&&task.tabId){
      await this.verifyDraft(task);
      await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeXhsSuggestions,args:['dismiss']});
      await sleep(350);
      const check=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeXhsSuggestions,args:['check']});if(!check[0]?.result?.ready)throw new SyncError('PUBLISH_NOT_READY',check[0]?.result?.error||'小红书话题弹层尚未关闭，未提交');
    }
    if(task.platform==='jike'&&task.tabId)await prepareJikeTarget(task);await this.verifyDraft(task);if(task.snapshot.type==='video'&&['channels','bilibili'].includes(task.platform)){if(!task.tabId)throw new SyncError('TAB_UNAVAILABLE','视频任务页已关闭');const r=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeVideoOptions,args:[task.platform,{...(task.snapshot.videoSource?{source:task.snapshot.videoSource}:{}),sourceUrl:task.snapshot.sourceUrl||'',category:task.snapshot.bilibiliCategory||'',tags:task.snapshot.tags}]});if(!r[0]?.result?.applied)throw new SyncError('VIDEO_OPTIONS_PENDING','视频来源、分区或标签需在原平台确认',false);}return publicationProbe(task);}
  async publish(task:PublishTask){return submitPublication(task);}
  async verifyPublication(task:PublishTask){return verifyPublication(task);}
  async saveDraft(task:PublishTask):Promise<EditorObservation>{if(task.platform!=='channels'||!task.tabId)throw new SyncError('NO_NATIVE_DRAFT','此操作只填写，不能代替原生草稿保存或对外发布',false);const r=await this.observe(task,task.tabId);if(!r.bodyMatched||r.title!==task.snapshot.title||!sameMedia(r.mediaHashes,task.proof?.mediaHashes||[]))throw new SyncError('DRAFT_CONTENT_CHANGED','保存前内容已变化，先核对',false);const saved=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeChannelsDraft,args:['save',task.proof?.remoteMediaHashes]});if(!saved[0]?.result?.notice)throw new SyncError('SAVE_UNCONFIRMED','原生保存操作尚未确认，请先核对草稿箱',false);return {...r,notice:'已触发原生草稿保存，等待重新打开核对'};}
  async verifyDraft(task:PublishTask):Promise<Evidence>{
    if(task.platform==='channels'&&task.operation==='save_draft'){
      if(!task.tabId||task.proof?.remoteMediaHashes?.length!==1)throw new SyncError('DRAFT_IDENTITY_MISSING','保存前未完整记录平台视频身份，不能自动认领草稿',false);
      if(!await this.permission())throw new SyncError('PERMISSION_REQUIRED','平台权限已取消',false);
      const tab=await chrome.tabs.get(task.tabId);if(!tab.url||new URL(tab.url).origin!==platformFor(this.platform).origin)throw new SyncError('PAGE_CHANGED','任务页已离开平台，先人工核对',false);
      await chrome.tabs.update(task.tabId,{url:'https://channels.weixin.qq.com/platform/post/draftListManager'});
      let opened=false;
      for(let i=0;i<60;i++){await sleep(500);const result=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeChannelsDraft,args:['reopen',[],this.payload(task).text]});if(result[0]?.result?.opened){opened=true;break;}}
      if(!opened)throw new SyncError('DRAFT_NOT_FOUND','草稿箱没有唯一匹配内容，保持待核对，不再次保存',false);
      const profile=fillProfile(task.platform,task.snapshot.type)!;
      for(let i=0;i<60;i++){await sleep(500);const fields=await this.native(task.tabId,profile,'read',this.payload(task));const identity=await chrome.scripting.executeScript({target:{tabId:task.tabId},world:'MAIN',func:nativeChannelsDraft,args:['inspect']});if(fields.editorFound&&fields.bodyMatched&&fields.title===task.snapshot.title&&sameMedia(identity[0]?.result?.remoteMediaHashes||[],task.proof.remoteMediaHashes)){return {kind:'editor_reload',checkedAt:Date.now(),title:fields.title,bodyMatched:true,mediaCount:1,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:'原生草稿箱重开后正文、短标题和平台视频身份一致'};}}
      throw new SyncError('DRAFT_REOPEN_UNCONFIRMED','重开草稿后内容或视频身份不一致，保持待核对',false);
    }
    if(!task.tabId)throw new SyncError('VERIFY_REQUIRED','请恢复原任务上传页，核对已有内容',false);
    const r=await this.observe(task,task.tabId);const profile=fillProfile(task.platform,task.snapshot.type)!;
    if(task.snapshot.media.length&&(task.proof?.mediaHashes.length!==task.snapshot.media.length||task.proof?.uploadedMediaIds?.length!==task.snapshot.media.length))throw new SyncError('MEDIA_IDENTITY_UNCONFIRMED','中断前尚未完整记录平台媒体身份，请先人工核对已有上传，不能自动重传',false);
    if(!r.editorFound||!r.bodyMatched||(profile.title&&r.title!==task.snapshot.title)||r.mediaCount!==task.snapshot.media.length||r.imageItems!==undefined&&r.imageItems!==task.snapshot.media.length||(task.proof?.mediaHashes.length&&!sameMedia(r.mediaHashes,task.proof.mediaHashes)))throw new SyncError('FILL_UNCONFIRMED','原任务页文字或附件仍无法核对，请保留待核对状态',false);
    return {kind:'editor_readback',checkedAt:Date.now(),title:r.title,bodyMatched:true,mediaCount:r.mediaCount,url:safeUrl((await chrome.tabs.get(task.tabId)).url!)};
  }
}
