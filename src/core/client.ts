import { db } from './repository';
import { MediaRefSchema, platformFor,platformOrigins, platforms, type Account, type ContentDraft, type ContentType, type MediaRecord, type MediaRef, type VideoMetadata, type PlatformId, type PublishTask, type Settings, type WorkspaceData, type TargetOption } from './model';

export class ClientError extends Error { constructor(public code: string, message: string) { super(message); } }
async function call<T>(action: string, payload: unknown = {}): Promise<T> {
  let result;
  try { result = await chrome.runtime.sendMessage({ channel: 'ling-sync', version: 1, action, payload }); }
  catch { throw new ClientError('TRANSPORT', '后台暂时未连接，请重新打开灵同步后重试'); }
  if (!result?.ok) throw new ClientError(result?.error?.code || 'OPERATION_FAILED', result?.error?.message || '操作未完成');
  return result.value as T;
}
async function sourceContext(){const tab=await chrome.tabs.getCurrent();if(tab?.id!==undefined)return {windowId:tab.windowId,tabId:tab.id};const win=await chrome.windows.getCurrent();const active=(await chrome.tabs.query({windowId:win.id,active:true}))[0];return active?.id!==undefined&&win.id!==undefined?{windowId:win.id,tabId:active.id,surface:'sidepanel' as const}:undefined;}
export const api = {
  listTargets:async(platform:'zsxq'|'jike',query='',refresh=false)=>call<TargetOption[]>('LIST_TARGETS',{platform,query,refresh,source:await sourceContext()}),
  workspace: () => call<WorkspaceData>('WORKSPACE'),
  restoreBackup:(id:string)=>call<void>('RESTORE_BACKUP',{id}),
  exportBackup:(id:string)=>call<{text:string;targetId:string;createdAt:number}>('EXPORT_BACKUP',{id}),
  setPlatformSelection: (type:ContentType,platforms:PlatformId[])=>call<PlatformId[]>('SET_PLATFORM_SELECTION',{type,platforms}),
  preparePublication:(id:string)=>call<PublishTask>('PREPARE_PUBLICATION',{id}),
  checkPublication: (id:string)=>call<{ready:true;checkedAt:number}>('CHECK_PUBLICATION',{id}),
  saveDraft: (draft: ContentDraft, expectedRevision: number) => call<ContentDraft>('SAVE_DRAFT', { draft, expectedRevision }),
  removeDraft: (id: string) => call<void>('REMOVE_DRAFT', { id }),
  enqueue: (draftId: string, platforms: PlatformId[]) => call<PublishTask[]>('ENQUEUE', { draftId, platforms }),
  startSync: async (draftId: string, platforms: PlatformId[],publishPlatforms:PlatformId[]=[],overflow?:'skip'|'images') => call<PublishTask[]>('START_SYNC', { draftId, platforms,publishPlatforms,overflow,source:await sourceContext() }),
  continueQueue: async () => call<void>('CONTINUE_QUEUE',{source:await sourceContext()}),
  prepare: (id: string) => call<PublishTask>('PREPARE', { id }),
  confirmSave: (id: string) => call<PublishTask>('CONFIRM_SAVE', { id }),
  verify: async (id: string) => call<PublishTask>('VERIFY', { id,source:await sourceContext() }),
  retry: async (id: string) => call<PublishTask>('RETRY', { id,source:await sourceContext() }),
  recoverFill:async(id:string)=>{const task=await(await db()).get('tasks',id);const ref=task?.snapshot.media.find(m=>m.kind==='video');const media=ref?await getMedia(ref.id):undefined;const videoMetadata=media?await readVideoMetadata(media.blob):undefined;return call<PublishTask>('RECOVER_FILL',{id,...(videoMetadata?{videoMetadata}:{})});},
  resumePublication:async(id:string)=>call<PublishTask>('RESUME_PUBLICATION',{id,source:await sourceContext()}),
  confirmPublicationResult:(id:string,url:string,visibility:'public'|'processing')=>call<PublishTask>('CONFIRM_PUBLICATION_RESULT',{id,url,visibility}),
  openTask: (id: string) => call<void>('OPEN_TASK', { id }),
  async connect(platform: PlatformId) {
    const granted = await chrome.permissions.request({ origins: platformOrigins(platform).map(o=>o+'/*') });
    if (!granted) throw new ClientError('PERMISSION_DENIED', '站点访问未授权。可再次点击连接，只授权这个平台。');
    return call<Account>('CONNECT', { platform });
  },
  async disconnect(platform: PlatformId) { await chrome.permissions.remove({ origins: platformOrigins(platform).map(o=>o+'/*') }); },
  async connectAll() {
    const granted=await chrome.permissions.request({origins:platforms.filter(p=>p.id==='weixin'||p.id==='zsxq').map(p=>`${p.origin}/*`)});
    if(!granted)throw new ClientError('PERMISSION_DENIED','首批平台未授权，请按需要分别连接平台');
    return call<Account[]>('REFRESH_ACCOUNTS');
  },
  refreshAccounts: () => call<Account[]>('REFRESH_ACCOUNTS'),
  settings: (settings: Partial<Settings>) => call<Settings>('SETTINGS', settings),
};
export async function addMedia(file: File, draftId: string, kind?:MediaRef['kind']): Promise<MediaRef> {
  const metadata=kind==='video'?await readVideoMetadata(file):undefined;
  const ref = MediaRefSchema.parse({ id: crypto.randomUUID(), name: file.name, kind:kind||(file.type.startsWith('video/')?'video':'image'),mime: file.type, bytes: file.size,...metadata });
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const valid = ref.kind==='video' ? (ref.mime==='video/webm'?bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3:['ftyp','moov','wide','mdat'].includes(new TextDecoder().decode(bytes.slice(4,8)))) : ref.mime === 'image/png' ? bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    : ref.mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : ref.mime === 'image/gif' ? new TextDecoder().decode(bytes.slice(0, 3)) === 'GIF'
    : new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP';
  if (!valid) throw new ClientError('INVALID_MEDIA', '附件内容与文件类型不符，请选择支持的图片或 MP4/MOV/WebM 视频');
  if(navigator.storage?.estimate){const estimate=await navigator.storage.estimate();if(estimate.quota&&estimate.quota-(estimate.usage||0)<file.size*1.15)throw new ClientError('STORAGE','本地剩余空间不足，请移除不需要的附件或选择较小视频');}
  try { await (await db()).put('media', { ...ref, draftId, blob: file }); }
  catch { throw new ClientError('STORAGE', '图片未保存。请检查浏览器本地存储空间，原文件保持不变。'); }
  return ref;
}
export const getMedia = async (id: string): Promise<MediaRecord | undefined> => (await db()).get('media', id);
export const removeMedia = async (id: string) => {
  const d=await db(); const tx=d.transaction(['media','tasks'],'readwrite');
  if (!(await tx.objectStore('tasks').getAll()).some(task=>task.snapshot.media.some(media=>media.id===id))) await tx.objectStore('media').delete(id);
  await tx.done;
};

/** Local browser metadata only; does not upload, play or export the file. */
export async function readVideoMetadata(blob:Blob):Promise<VideoMetadata|undefined>{
 const video=document.createElement('video');video.preload='metadata';video.muted=true;const url=URL.createObjectURL(blob);
 try{return await new Promise(resolve=>{const finish=()=>{clearTimeout(timer);video.onloadedmetadata=null;video.onerror=null;resolve(Number.isFinite(video.duration)&&video.duration>0&&video.videoWidth>0&&video.videoHeight>0?{duration:video.duration,width:video.videoWidth,height:video.videoHeight}:undefined);};const timer=setTimeout(finish,12000);video.onloadedmetadata=finish;video.onerror=finish;video.src=url;});}finally{video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
