import { z } from 'zod';
import {CardStyleSchema} from './card-renderer';

export const PlatformIdSchema = z.enum(['weixin', 'zsxq', 'jike', 'douyin', 'kuaishou', 'channels', 'bilibili', 'x', 'xiaohongshu']);
export type PlatformId = z.infer<typeof PlatformIdSchema>;
export const StatusSchema = z.enum(['queued', 'preparing', 'ready_for_confirmation', 'saving_draft', 'draft_saved', 'filled', 'publishing', 'submitted', 'published', 'failed', 'unknown']);
export type TaskStatus = z.infer<typeof StatusSchema>;
export const MediaRefSchema = z.object({ id: z.uuid(), name: z.string().max(250), kind:z.enum(['image','video','cover']).default('image'), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif','video/mp4','video/webm','video/quicktime']), bytes: z.number().int().positive().max(1024*1024*1024), duration:z.number().nonnegative().optional(),width:z.number().int().positive().optional(),height:z.number().int().positive().optional() }).refine(m=>m.kind==='video'?m.mime.startsWith('video/'):m.mime.startsWith('image/')&&m.bytes<=15*1024*1024,{message:'图片最多15MiB，视频最多1GiB（本地限制）'});
export type VideoMetadata={duration:number;width:number;height:number};
export type MediaRef = z.infer<typeof MediaRefSchema>;
export const ContentTypeSchema=z.enum(['post','article','video']);
export type ContentType=z.infer<typeof ContentTypeSchema>;
export type PlatformSelections = Record<ContentType, PlatformId[]>;
export const TITLE_MAX = 20;
export function fitTitle(value:string,limit=TITLE_MAX){const clipped=value.slice(0,Math.max(0,limit));const end=clipped.charCodeAt(clipped.length-1);return end>=0xD800&&end<=0xDBFF?clipped.slice(0,-1):clipped;}
export function limitTitleEdit(previous:string,value:string){
  if(value.length<=TITLE_MAX||previous.length>TITLE_MAX&&value.length<previous.length)return value;
  if(previous.length>TITLE_MAX)return previous;
  let prefix=0,suffix=0;while(prefix<previous.length&&prefix<value.length&&previous[prefix]===value[prefix])prefix++;
  while(suffix<previous.length-prefix&&suffix<value.length-prefix&&previous[previous.length-1-suffix]===value[value.length-1-suffix])suffix++;
  const inserted=value.slice(prefix,value.length-suffix),accepted=fitTitle(inserted,TITLE_MAX-prefix-suffix);
  return inserted&&!accepted?previous:value.slice(0,prefix)+accepted+previous.slice(previous.length-suffix);
}
export const DraftSchema = z.object({
  id: z.uuid(), revision: z.number().int().nonnegative(), type: z.preprocess(v=>v==='image_post'?'post':v,ContentTypeSchema),
  title: z.string().max(500), markdown: z.string().max(500_000), media: z.array(MediaRefSchema).max(50), tags:z.array(z.string().max(100)).max(30).default([]),
  videoSource:z.enum(['original','repost']).optional(),sourceUrl:z.string().max(2000).optional(),bilibiliCategory:z.string().max(100).optional(),
  cardStyle:CardStyleSchema.optional(),
  textAsImages:z.boolean().optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
export type ContentDraft = z.infer<typeof DraftSchema>;
export type Account = { platform: PlatformId; status: 'permission_required' | 'logged_out' | 'connected' | 'unknown'; label?: string; checkedAt: number; targetId: string; note?: string };
export type TargetOption = {id:string;name:string};
export type EditorSource = {windowId:number;tabId:number;surface?:'sidepanel'};
export const mergeTags=(fixed:string[]=[],ordinary:string[]=[])=>[...new Set([...fixed,...ordinary].map(t=>t.trim().replace(/^#+/,'')).filter(Boolean))];
export type Settings = { fixedTags?:string[]; zsxqTargets?:string[]; jikeCircle?:string; zsxqGroupId: string; showPreview: boolean; directPublishPlatforms?:PlatformId[]; directPublish?:boolean; autoTextImages?:boolean };
export type TaskError = { code: string; message: string; retrySafe: boolean };
export type Evidence = { kind: 'editor_reload'|'editor_readback'|'publication_receipt'|'publication_result'; checkedAt: number; title?: string; bodyMatched?: boolean; mediaCount?: number; mediaMatched?:boolean; contentId?:string; url: string; notice?: string; verificationSource?:'page'|'user' };
export type PublishTask = {
  id: string; batchId: string; platform: PlatformId; targetId: string; snapshot: ContentDraft;
  status: TaskStatus; createdAt: number; updatedAt: number; attemptId: string; tabId?: number; source?:EditorSource; targetName?:string;
  supersededByTaskId?:string; supersedesTaskId?:string; parentTaskId?:string; publicationResult?:{id:string;url:string;visibility:'public'|'processing';checkedAt:number}; progress: string; publicationGuard?:string; publicationAttemptedAt?:number; editorRefreshAttemptedAt?:number; editorRecovery?:{phase:'marked'|'reloaded'|'refilling'|'verified'|'interrupted';accountKey:string;targetId:string;proof:NonNullable<PublishTask['proof']>;startedAt:number}; error?: TaskError; evidence?: Evidence; saveNotice?: string;
  proof?: { bodyDigest:string; mediaHashes:string[];uploadedMediaIds?:string[];remoteMediaHashes?:string[] };
  nativeCover?:{previewIdentity:string;width:number;height:number;pixels?:string;remoteIdentity?:string;phase:'captured'|'confirming'};
  queueOrder?:number; autoRun?:boolean; operation?:'save_draft'|'fill'|'publish';
  timings?:Partial<Record<'startedAt'|'editorReadyAt'|'filledAt'|'submittedAt'|'verifiedAt'|'dispatchDelayMs',number>>;
};
export type Diagnostic = { id: string; taskId?: string; time: number; level: 'info' | 'error'; event: string; message: string };
export type DraftBackup = { id:string; taskId:string; targetId:string; tabId:number; url:string; accountKey:string; text:string; digest:string; createdAt:number; updatedAt:number; state:'captured'|'replacing'|'restore_pending'|'restored'; note?:string };
export type BackupSummary = Omit<DraftBackup,'text'|'digest'|'accountKey'>;
export type TaskReceipt = { fingerprint:string; taskId:string; operation:Operation; status:TaskStatus; createdAt:number; url?:string };
export type TaskSummary = Omit<PublishTask,'snapshot'|'proof'|'publicationGuard'> & {snapshot:Pick<ContentDraft,'id'|'type'|'title'|'textAsImages'>;proof?:Pick<NonNullable<PublishTask['proof']>,'bodyDigest'|'uploadedMediaIds'>};
export type WorkspaceData = { drafts: ContentDraft[]; tasks: TaskSummary[]; accounts: Account[]; settings: Settings; logs: Diagnostic[]; platformSelections?:PlatformSelections; backups?:BackupSummary[]; history?:{limit:number;retained:number;protected:number} };
export type MediaRecord = MediaRef & { draftId: string; blob: Blob };
export type Operation='save_draft'|'fill'|'publish';
export type Capability={type:ContentType;operation:Operation;verification:'verified'|'pending'|'unimplemented';note?:string};
export type PlatformCapabilities = { id: PlatformId; name: string; shortName: string; origin: string; home: string; contentTypes: ContentType[]; capabilities:Capability[]; operations: Operation[]; verification: 'pending' | 'verified'; limits: { titleCharacters: number; imageBytes: number; localImageCount: number }; description: string };
export const platforms: PlatformCapabilities[] = [
  { id: 'weixin', name: '微信公众号', shortName: '公', origin: 'https://mp.weixin.qq.com', home: 'https://mp.weixin.qq.com/', contentTypes: ['article','post'], capabilities:[{type:'article',operation:'save_draft',verification:'verified'},{type:'post',operation:'fill',verification:'verified',note:'Ego已实测自动文字图填写；0.2.12短文单图发表及公开详情自动核对通过'}], operations: ['save_draft','fill'], verification: 'verified', limits: {titleCharacters:64,imageBytes:15*1024*1024,localImageCount:50}, description: '文章草稿已实测' },
  { id: 'zsxq', name: '知识星球', shortName: '星', origin: 'https://wx.zsxq.com', home: 'https://wx.zsxq.com/', contentTypes: ['article','post'], capabilities:[{type:'article',operation:'save_draft',verification:'verified'},{type:'post',operation:'fill',verification:'verified'}], operations: ['save_draft','fill'], verification: 'verified', limits: {titleCharacters:60,imageBytes:15*1024*1024,localImageCount:50}, description: '长文草稿已实测' },
  ...([
    ['jike','即刻','即','https://web.okjike.com','https://web.okjike.com/',['post']],
    ['douyin','抖音','抖','https://creator.douyin.com','https://creator.douyin.com/',['post','video']],
    ['kuaishou','快手','快','https://cp.kuaishou.com','https://cp.kuaishou.com/',['post','video']],
    ['channels','视频号','视','https://channels.weixin.qq.com','https://channels.weixin.qq.com/',['post','video']],
    ['bilibili','B站','B','https://member.bilibili.com','https://member.bilibili.com/',['post','article','video']],
    ['x','X','X','https://x.com','https://x.com/',['post','article','video']],
    ['xiaohongshu','小红书','红','https://creator.xiaohongshu.com','https://creator.xiaohongshu.com/',['post','video']],
  ] as const).map(([id,name,shortName,origin,home,types])=>({id,name,shortName,origin,home,contentTypes:[...types],capabilities:types.map(type=>({type,operation:'fill' as const,verification:((['jike','x','channels','douyin','kuaishou','bilibili','xiaohongshu'].includes(id)&&type==='post')||(['douyin','kuaishou','channels','bilibili','x'].includes(id)&&type==='video'))?'verified' as const:(type==='video'||type==='post')?'pending' as const:'unimplemented' as const})),operations:['fill' as const],verification:'pending' as const,limits:{titleCharacters:500,imageBytes:15*1024*1024,localImageCount:50},description:'适配器待验证'})),
];
export const plannedPlatforms = ['播客', '跨设备同步'];
const publishCandidates:Partial<Record<PlatformId,ContentType[]>>={weixin:['post'],zsxq:['post'],jike:['post'],x:['post','video'],channels:['post','video'],douyin:['post','video'],kuaishou:['post','video'],bilibili:['post','video'],xiaohongshu:['post','video']};
for(const p of platforms)for(const type of p.contentTypes)p.capabilities.push({type,operation:'publish',verification:type==='post'&&['jike','weixin','zsxq'].includes(p.id)?'verified':publishCandidates[p.id]?.includes(type)?'pending':'unimplemented',note:type==='post'?['jike','weixin','zsxq'].includes(p.id)?'0.2.12已实测独立短文与单张PNG发布及公开详情自动核对；即刻含指定圈子，星球使用原尺寸完整RGBA或已证明的媒体身份':'0.2.12公开结果验证范围与停留阶段见本版报告；已填写、已提交与已核对分别显示':undefined});
for(const p of platforms)if(p.capabilities.some(c=>c.operation==='publish'&&c.verification!=='unimplemented'))p.operations.push('publish');
export function capabilityFor(id:PlatformId,type:ContentType,operation?:Operation){return platformFor(id).capabilities.find(c=>c.type===type&&(operation?c.operation===operation:c.operation!=='publish'));}
export function publicationAvailable(id:PlatformId,type:ContentType){const c=capabilityFor(id,type,'publish');return !!c&&c.verification!=='unimplemented';}
export function selectablePlatforms(type:ContentType){return platforms.filter(p=>{const c=capabilityFor(p.id,type);return c&&c.verification!=='unimplemented';}).map(p=>p.id);}
export function normaliseSelection(value:unknown,type:ContentType):PlatformId[]{const available=selectablePlatforms(type);return Array.isArray(value)?available.filter(id=>value.includes(id)):[];}
export function normaliseSettings(settings?:Partial<Settings>):Settings{return {fixedTags:mergeTags(settings?.fixedTags),zsxqTargets:settings?.zsxqTargets??(settings?.zsxqGroupId?[settings.zsxqGroupId]:[]),jikeCircle:settings?.jikeCircle||'',zsxqGroupId:settings?.zsxqGroupId||'',showPreview:settings?.showPreview??false,directPublishPlatforms:settings?.directPublishPlatforms||[],autoTextImages:settings?.autoTextImages??true,directPublish:settings?.directPublish??!!settings?.directPublishPlatforms?.length};}
export function platformOrigins(id:PlatformId,type?:ContentType){return id==='bilibili'&&type==='post'?['https://t.bilibili.com']:type===undefined&&id==='bilibili'?[platformFor(id).origin,'https://t.bilibili.com']:[platformFor(id).origin];}

export function newDraft(type:ContentType='article'): ContentDraft {
  const now = Date.now();
  return { id: crypto.randomUUID(), revision: 0, type, title: '', markdown: '', media: [],tags:[], createdAt: now, updatedAt: now };
}
export function platformFor(id: PlatformId) { return platforms.find(p => p.id === id)!; }
export function groupIdFrom(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (/^\d{5,30}$/.test(text)) return text;
  const url = new URL(text);
  if (url.origin !== 'https://wx.zsxq.com') throw new Error('请输入 wx.zsxq.com 的星球链接或星球 ID');
  const id = url.searchParams.get('groupId') || url.pathname.match(/^\/group\/(\d+)\/?$/)?.[1];
  if (!id || !/^\d{5,30}$/.test(id)) throw new Error('未从链接识别出星球 ID');
  return id;
}
export function safeUrl(value: string): string {
  const url = new URL(value); url.username = ''; url.password = ''; url.hash = '';
  const publicWeixin=url.origin==='https://mp.weixin.qq.com'&&url.pathname==='/s';
  for (const k of [...url.searchParams.keys()]) if (!['groupId', 'articleId', 'appmsgid', 'draftId', 'id','topicId','noteId','feedId','objectId',...(publicWeixin?['__biz','mid','idx','sn']:[])].includes(k)) url.searchParams.delete(k);
  return url.href;
}
export function transitionAllowed(from: TaskStatus, to: TaskStatus) {
  const transitions: Record<TaskStatus, TaskStatus[]> = {
    queued: ['preparing', 'failed'], preparing: ['ready_for_confirmation', 'filled', 'failed','unknown'],
    ready_for_confirmation: ['saving_draft', 'publishing', 'failed', 'preparing'],
    saving_draft: ['draft_saved', 'unknown'], publishing:['submitted','unknown','failed','ready_for_confirmation'],submitted:['published','unknown'],published:[], draft_saved: [],filled:['unknown'], failed: ['queued','ready_for_confirmation','published','submitted'], unknown: ['failed','draft_saved','filled','published','submitted','preparing','ready_for_confirmation'],
  };
  return transitions[from].includes(to);
}
export function recoveryStatus(status: TaskStatus): TaskStatus {
  if (status === 'saving_draft'||status==='publishing') return 'unknown';
  if (status === 'preparing') return 'failed';
  return status;
}
export function contentFingerprint(d: ContentDraft, platform: PlatformId, targetId: string) {
  return `${d.id}:${d.revision}:${platform}:${targetId}`;
}
