import { z } from 'zod';
import { DraftSchema, PlatformIdSchema, ContentTypeSchema, TITLE_MAX } from './model';

const base = z.object({ channel: z.literal('ling-sync'), version: z.literal(1) });
const source=z.object({windowId:z.number().int().nonnegative(),tabId:z.number().int().nonnegative(),surface:z.literal('sidepanel').optional()}).optional();
const id = z.object({ id: z.uuid(), source });
export const RequestSchema = z.discriminatedUnion('action', [
  base.extend({action:z.literal('LIST_TARGETS'),payload:z.object({platform:z.enum(['zsxq','jike']),query:z.string().max(100).default(''),refresh:z.boolean().default(false),source})}),
  base.extend({ action: z.literal('WORKSPACE'), payload: z.object({}) }),
  base.extend({ action: z.literal('SET_PLATFORM_SELECTION'), payload: z.object({type:ContentTypeSchema,platforms:z.array(PlatformIdSchema).max(9)}) }),
  base.extend({ action: z.literal('CHECK_PUBLICATION'), payload: id }),
  base.extend({ action: z.literal('PREPARE_PUBLICATION'), payload: id }),
  base.extend({action:z.literal('RESTORE_BACKUP'),payload:id}),
  base.extend({action:z.literal('EXPORT_BACKUP'),payload:id}),
  base.extend({ action: z.literal('SAVE_DRAFT'), payload: z.object({ draft: DraftSchema, expectedRevision: z.number().int().nonnegative() }) }),
  base.extend({ action: z.literal('REMOVE_DRAFT'), payload: id }),
  base.extend({ action: z.literal('ENQUEUE'), payload: z.object({ draftId: z.uuid(), platforms: z.array(PlatformIdSchema).min(1).max(9), source }) }),
  base.extend({ action: z.literal('START_SYNC'), payload: z.object({ draftId: z.uuid(), platforms: z.array(PlatformIdSchema).min(1).max(9), publishPlatforms:z.array(PlatformIdSchema).max(9).default([]), overflow:z.enum(['skip','images']).optional(), source }) }),
  base.extend({ action: z.literal('CONTINUE_QUEUE'),payload:z.object({source}) }),
  base.extend({ action: z.literal('PREPARE'), payload: id }),
  base.extend({ action: z.literal('CONFIRM_SAVE'), payload: id }),
  base.extend({ action: z.literal('VERIFY'), payload: id }),
  base.extend({ action: z.literal('RETRY'), payload: id }),
  base.extend({ action:z.literal('RESUME_PUBLICATION'),payload:id}),
  base.extend({action:z.literal('RECOVER_FILL'),payload:id.extend({videoMetadata:z.object({duration:z.number().positive().max(86400),width:z.number().int().positive().max(16384),height:z.number().int().positive().max(16384)}).optional()})}),
  base.extend({action:z.literal('CONFIRM_PUBLICATION_RESULT'),payload:z.object({id:z.uuid(),url:z.url().max(2000),visibility:z.enum(['public','processing'])})}),
  base.extend({ action: z.literal('OPEN_TASK'), payload: id }),
  base.extend({ action: z.literal('CONNECT'), payload: z.object({ platform: PlatformIdSchema }) }),
  base.extend({ action: z.literal('REFRESH_ACCOUNTS'), payload: z.object({}) }),
  base.extend({ action: z.literal('SETTINGS'), payload: z.object({ fixedTags:z.array(z.string().max(100)).max(30).optional(),zsxqTargets:z.array(z.string().regex(/^\d{5,30}$/)).max(100).optional(),jikeCircle:z.string().max(100).optional(),zsxqGroupId: z.string().regex(/^(\d{5,30})?$/).optional(), showPreview: z.boolean().optional(), directPublishPlatforms:z.array(PlatformIdSchema).max(9).optional(), directPublish:z.boolean().optional(), autoTextImages:z.boolean().optional() }) }),
]);
export type Request = z.infer<typeof RequestSchema>;
export class SyncError extends Error {
  constructor(public code: string, message: string, public retrySafe = true) { super(message); this.name = 'SyncError'; }
}
export function validateSyncTitle(title:string){if(title.length>TITLE_MAX)throw new SyncError('TITLE_TOO_LONG',`标题最多${TITLE_MAX}字，请先缩短标题；原稿仍完整保留。`);}
export function trustedUi(sender: chrome.runtime.MessageSender, extensionId: string) {
  return sender.id === extensionId && !!sender.url && sender.url.startsWith(`chrome-extension://${extensionId}/`) && ['workbench.html', 'sidepanel.html', 'options.html'].includes(new URL(sender.url).pathname.slice(1));
}
export function errorValue(error: unknown) {
  if (error instanceof SyncError) return { code: error.code, message: error.message, retrySafe: error.retrySafe };
  const message = error instanceof Error ? error.message : '操作未完成';
  if (/Frame with ID \d+ is showing error page|chrome-error:\/\/|net::ERR_/.test(message)) return {code:'PAGE_LOAD_FAILED',message:'平台任务页加载失败，尚未确认进入编辑器；请核对原页网络或登录状态。',retrySafe:true};
  return { code: message.includes('另一个窗口') ? 'CONFLICT' : /安全验证|需要验证|要求验证|扫码验证/.test(message)?'VERIFICATION_REQUIRED':'OPERATION_FAILED', message: message.replace(/https?:\/\/[^\s]+/g, '[站点地址]'), retrySafe: true };
}
