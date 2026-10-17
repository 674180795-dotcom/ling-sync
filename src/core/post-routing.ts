import {capabilityFor,publicationAvailable,type ContentDraft,type PlatformId,type Settings,type PublishTask} from './model';
// These native image-post composers require a picture. Bilibili/X/Jike/Star
// accept text, so they never receive an unsolicited text image.
export const imageRequiredPosts:PlatformId[]=['douyin','kuaishou','channels','xiaohongshu'];
export const needsTextImages=(draft:ContentDraft,platform:PlatformId)=>draft.type==='post'&&imageRequiredPosts.includes(platform)&&!draft.media.length;
export function syncOperation(platform:PlatformId,draft:ContentDraft,settings:Settings){return settings.directPublish&&publicationAvailable(platform,draft.type)?'publish':capabilityFor(platform,draft.type)?.operation||'fill';}
export function batchSummary<T extends Pick<PublishTask,'status'>>(tasks:T[]){
 const running=tasks.filter(t=>['queued','preparing','ready_for_confirmation','saving_draft','publishing'].includes(t.status));
 const issues=tasks.filter(t=>t.status==='failed'||t.status==='unknown');
 return {running:running.length,completed:tasks.length-running.length,issues,done:!!tasks.length&&!running.length,counts:Object.fromEntries(['filled','submitted','published','failed','unknown'].map(status=>[status,tasks.filter(t=>t.status===status).length])) as Record<'filled'|'submitted'|'published'|'failed'|'unknown',number>};
}
