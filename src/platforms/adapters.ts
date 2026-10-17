import {WeixinPostAdapter} from './weixin-post-adapter';
import {ZsxqPostAdapter} from './zsxq-post-adapter';
import {XPostAdapter} from './x-post-adapter';
import {createTaskTab} from './task-tab';
import { db, updateTask } from '../core/repository';
import { platformFor, platformOrigins, safeUrl, type Account, type ContentDraft, type Evidence, type PlatformId, type PublishTask } from '../core/model';
import { SyncError } from '../core/protocol';
import {sameMedia,targetMatches,knownUploadPrefix} from '../core/content-proof';
import type { BridgeCommand, EditorObservation, PlatformAdapter } from './contracts';
import { fillWeixinArticle } from './native-weixin-editor';
import { mediaChunks } from '../core/media-stream';
import { FillAdapter } from './fill-adapter';
import { uploadZsxqImage } from './native-image-picker';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function hasPermission(platform: PlatformId,type?:ContentDraft['type']) {if(platform==='bilibili'&&type===undefined)return await chrome.permissions.contains({origins:['https://member.bilibili.com/*']})||await chrome.permissions.contains({origins:['https://t.bilibili.com/*']});return chrome.permissions.contains({origins:platformOrigins(platform,type).map(o=>o+'/*')});}
async function ready(tabId: number) {
  for (let i=0;i<90;i++) { const tab = await chrome.tabs.get(tabId); if(tab.status === 'complete') return tab; await wait(500); }
  throw new SyncError('PAGE_TIMEOUT', '平台页面尚未加载完成，请检查网络后重试');
}
async function bridge<T>(tabId: number, command: BridgeCommand): Promise<T> {
  if (!await hasPermission(command.platform)) throw new SyncError('PERMISSION_REQUIRED','此平台的访问授权已取消，请重新连接');
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || (command.operation==='detect'?new URL(tab.url).origin!==platformFor(command.platform).origin:!targetMatches(command.platform,command.targetId||'',tab.url))) throw new SyncError('PAGE_CHANGED','任务标签页已离开目标平台或目标星球，请打开正确的任务编辑页');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/bridge.js'] });
  const result = await chrome.tabs.sendMessage(tabId, { channel: 'ling-sync-bridge', version: 1, command });
  if(!result?.ok) throw new SyncError('PLATFORM_UI', result?.error || '平台编辑器未响应');
  return result.value as T;
}
function command(task: PublishTask, operation: BridgeCommand['operation']): BridgeCommand {
  return { operation, platform: task.platform,targetId:task.targetId,proof:task.proof, taskId: task.id, attemptId: task.attemptId, title: task.snapshot.title, markdown: task.snapshot.markdown, mediaCount: task.snapshot.media.length };
}
class DomAdapter implements PlatformAdapter {
  constructor(readonly platform: PlatformId) {}
  async detectSession(): Promise<Account> {
    const base = { platform: this.platform, checkedAt: Date.now(), targetId: '' };
    if (!await hasPermission(this.platform)) return {...base,status:'permission_required'};
    const tabs = await chrome.tabs.query({url:`${platformFor(this.platform).origin}/*`});
    const tab = tabs.find(t=>t.id && t.url?.startsWith(platformFor(this.platform).origin+'/'));
    if(!tab?.id) return {...base,status:'unknown',note:'打开平台后刷新连接状态'};
    try { const read = await bridge<EditorObservation>(tab.id, {operation:'detect',platform:this.platform,taskId:'session',attemptId:'session'}); return {...base,status:read.login,label:read.label,note:read.login==='unknown'?'尚未识别账号，请进入平台首页或编辑页再检测':undefined}; }
    catch { return {...base,status:'unknown',note:'平台页面加载或安全验证尚未完成'}; }
  }
  validate(draft: ContentDraft, targetId: string) {
    if (draft.type!=='article') throw new SyncError('UNSUPPORTED_TYPE','此适配器当前只提供文章草稿流程');
    if(draft.media.some(m=>m.kind!=='image'))throw new SyncError('UNSUPPORTED_MEDIA','文章只接受正文图片');
    if(!draft.title.trim() || !draft.markdown.trim()) throw new SyncError('EMPTY_CONTENT','请填写标题和正文');
    if(this.platform==='zsxq' && !/^\d{5,30}$/.test(targetId)) throw new SyncError('TARGET_REQUIRED','请先在账号页面选择知识星球目标');
    if(this.platform==='weixin' && draft.title.length>64) throw new SyncError('TITLE_TOO_LONG','公众号文章标题最多64字，请缩短标题');
    if(this.platform==='zsxq' && draft.title.length>60) throw new SyncError('TITLE_TOO_LONG','知识星球长文标题最多60字，请缩短标题');
    if(this.platform==='zsxq' && draft.markdown.length>100000) throw new SyncError('BODY_TOO_LONG','当前知识星球适配器接受最多100000字符的Markdown原文');
  }
  async openEditor(task: PublishTask) {
    if (!await hasPermission(this.platform)) throw new SyncError('PERMISSION_REQUIRED','请先授权并连接此平台');
    let tab: chrome.tabs.Tab | undefined;
    if(task.tabId) { try { tab=await chrome.tabs.get(task.tabId); } catch {} }
    if (!tab?.id || !tab.url || !targetMatches(task.platform,task.targetId,tab.url)) {
      const url = this.platform==='zsxq' ? `https://wx.zsxq.com/article?groupId=${task.targetId}` : platformFor(this.platform).home;
      tab=await createTaskTab(task,url);
    }
    if(!tab.id) throw new SyncError('TAB_UNAVAILABLE','无法创建任务标签页');
    await chrome.tabs.update(tab.id,{active:true}); await ready(tab.id);
    if (this.platform==='weixin' && !tab.url?.includes('/cgi-bin/appmsg?t=media/appmsg_edit')) {
      const sourceId=tab.id;
      const opened=await chrome.scripting.executeScript({target:{tabId:sourceId},world:'MAIN',func:()=>{
        const entry=[...document.querySelectorAll<HTMLElement>('.new-creation__menu-item')].find(e=>e.querySelector('.new-creation__menu-title')?.textContent?.trim()==='文章');
        if (!entry) return false;
        const original=window.open;let destination:string|undefined;
        window.open=function(url) { const value=new URL(String(url),location.href);if(value.origin!=='https://mp.weixin.qq.com')throw new Error('编辑入口来源变化');destination=value.href;return null; };
        try { entry.click(); } finally { window.open=original; }
        if(!destination)return false;location.assign(destination);return true;
      }});
      if(!opened[0]?.result) throw new SyncError('LOGIN_REQUIRED','请先在任务标签页正常登录公众号，进入首页后再重试');
      for(let i=0;i<40;i++) { const current=await chrome.tabs.get(sourceId);if(current.url?.includes('appmsg_edit'))break;await wait(250); }
      await ready(sourceId); return sourceId;
    }
    return tab.id;
  }
  async fillEditor(task: PublishTask, tabId: number) {
    const initial = await bridge<EditorObservation>(tabId,command(task,'read'));
    if(initial.login==='logged_out') throw new SyncError('LOGIN_REQUIRED','请在这个任务标签页正常登录平台，再重试填写');
    await bridge(tabId,command(task,'open_editor'));
    let result:EditorObservation;
    if(this.platform==='weixin') {
      const prepared=await bridge<{html:string;expectedBody:string}>(tabId,command(task,'prepare_fill'));
      await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:fillWeixinArticle,args:[task.snapshot.title,prepared.html,prepared.expectedBody]});
      result=await bridge<EditorObservation>(tabId,command(task,'read'));
      for(let i=0;i<25&&!result.bodyMatched;i++) {await wait(200);result=await bridge<EditorObservation>(tabId,command(task,'read'));}
      if(!result.bodyMatched||!result.formatMatched||result.title!==task.snapshot.title)throw new SyncError('READBACK_FAILED','公众号标题、正文或格式粘贴未通过回读');
    } else result = await bridge<EditorObservation>(tabId,command(task,'fill'));
    if(result.mediaCount > task.snapshot.media.length) throw new SyncError('MEDIA_MISMATCH','平台正文包含额外图片，请核对后再继续');
    if(!knownUploadPrefix(result.mediaHashes,task.proof?.mediaHashes))throw new SyncError('MEDIA_IDENTITY','当前图片缺少本任务的持久化上传凭据，不能按数量跳过。请核对任务页并使用空白编辑器重新填写');
    await updateTask(task.id,['preparing'],{proof:{bodyDigest:result.bodyDigest,mediaHashes:result.mediaHashes}});
    // Only append missing attachments; retries retain the task-owned editor and completed uploads.
    for(const media of task.snapshot.media.slice(result.mediaCount)) {
      const previousHashes=result.mediaHashes;
      const stored = await (await db()).get('media',media.id);
      if(!stored || stored.blob.size!==media.bytes) throw new SyncError('MEDIA_MISSING','本地图片不完整，请回编辑页重新添加图片并创建新任务');
      if (this.platform === 'zsxq') {
        await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:uploadZsxqImage,args:[task.targetId,media.name,media.mime,Array.from(new Uint8Array(await stored.blob.arrayBuffer()))]});
        for(let i=0;i<90;i++) {
          await wait(500); result=await bridge<EditorObservation>(tabId,command(task,'read'));
          if(result.mediaCount>previousHashes.length) break;
        }
      } else {
      await bridge(tabId,{...command(task,'upload_begin'),media});
      for await(const part of mediaChunks(stored.blob))await bridge(tabId,{...command(task,'upload_chunk'),media,index:part.index,chunk:part.chunk});
      result=await bridge<EditorObservation>(tabId,{...command(task,'upload_commit'),media});
      }
      if(result.mediaHashes.length!==previousHashes.length+1||!sameMedia(result.mediaHashes.slice(0,previousHashes.length),previousHashes))throw new SyncError('MEDIA_ORDER','图片未按附件顺序追加，请在平台核对图片后重新填写');
      await updateTask(task.id,['preparing'],{proof:{bodyDigest:result.bodyDigest,mediaHashes:result.mediaHashes}});
    }
    if(!result.bodyMatched || !result.formatMatched || result.title!==task.snapshot.title || result.mediaCount!==task.snapshot.media.length) throw new SyncError('READBACK_FAILED','标题、正文、格式或图片回读不符，请核对任务编辑页');
    return result;
  }
  async saveDraft(task: PublishTask) {
    if(!task.tabId) throw new SyncError('TAB_MISSING','任务标签页已关闭');
    return bridge<EditorObservation>(task.tabId,command(task,'save'));
  }
  async verifyDraft(task: PublishTask): Promise<Evidence> {
    if(!task.tabId) throw new SyncError('VERIFY_REQUIRED','请先打开任务平台页',false);
    const tab = await chrome.tabs.get(task.tabId);
    if(!tab.url || !targetMatches(task.platform,task.targetId,tab.url)) throw new SyncError('PAGE_CHANGED','任务页已变化，请恢复正确平台/星球的草稿编辑页后核对',false);
    // Native persisted content must survive a page reload, without filling again.
    await chrome.tabs.reload(task.tabId); await ready(task.tabId);
    if (task.platform === 'zsxq') await bridge(task.tabId,command(task,'reopen_draft'));
    let result: EditorObservation | undefined;
    for(let i=0;i<25;i++) {
      try { result = await bridge<EditorObservation>(task.tabId,command(task,'read')); if(result.editorFound && result.title===task.snapshot.title && result.bodyMatched && result.formatMatched && result.bodyDigest===task.proof?.bodyDigest && sameMedia(result.mediaHashes,task.proof?.mediaHashes||[])) break; } catch {}
      await wait(500);
    }
    if(!result?.editorFound || result.title!==task.snapshot.title || !result.bodyMatched || !result.formatMatched || result.bodyDigest!==task.proof?.bodyDigest || !sameMedia(result.mediaHashes,task.proof?.mediaHashes||[])) throw new SyncError('DRAFT_UNCONFIRMED','重新打开后正文、格式或图片身份/顺序未核对一致。请从平台草稿列表打开对应文章，再点核对；不要重新保存。',false);
    return {kind:'editor_reload',checkedAt:Date.now(),title:result.title,bodyMatched:true,mediaCount:result.mediaCount,url:safeUrl((await chrome.tabs.get(task.tabId)).url!),notice:task.saveNotice};
  }
}
const weixinArticle=new DomAdapter('weixin'),weixinPost=new WeixinPostAdapter();
const weixinFor=(task:PublishTask)=>task.snapshot.type==='post'?weixinPost:weixinArticle;
const weixinAdapter:PlatformAdapter={detectSession:()=>weixinArticle.detectSession(),validate:(draft,target)=>draft.type==='post'?weixinPost.validate(draft):weixinArticle.validate(draft,target),openEditor:task=>weixinFor(task).openEditor(task),fillEditor:(task,tabId)=>weixinFor(task).fillEditor(task,tabId),saveDraft:task=>weixinFor(task).saveDraft(task),verifyDraft:task=>weixinFor(task).verifyDraft(task),recoverEditor:task=>{if(task.snapshot.type!=='post')throw new SyncError('UNSAFE_RECOVERY','此恢复仅用于公众号贴图',false);return weixinPost.recoverEditor(task);}};
const zsxqArticle=new DomAdapter('zsxq'),zsxqPost=new ZsxqPostAdapter();
const zsxqFor=(task:PublishTask)=>task.snapshot.type==='post'?zsxqPost:zsxqArticle;
const zsxqAdapter:PlatformAdapter={detectSession:()=>zsxqArticle.detectSession(),validate:(draft,target)=>draft.type==='post'?zsxqPost.validate(draft,target):zsxqArticle.validate(draft,target),openEditor:task=>zsxqFor(task).openEditor(task),fillEditor:(task,tabId)=>zsxqFor(task).fillEditor(task,tabId),saveDraft:task=>zsxqFor(task).saveDraft(task),verifyDraft:task=>zsxqFor(task).verifyDraft(task),recoverEditor:task=>zsxqPost.recoverEditor(task),preparePublication:task=>zsxqPost.preparePublication(task),publish:task=>zsxqPost.publish(task),verifyPublication:task=>zsxqPost.verifyPublication(task)};
export const adapters: Record<PlatformId,PlatformAdapter> = {weixin:weixinAdapter,zsxq:zsxqAdapter,jike:new FillAdapter('jike'),douyin:new FillAdapter('douyin'),kuaishou:new FillAdapter('kuaishou'),channels:new FillAdapter('channels'),bilibili:new FillAdapter('bilibili'),x:new XPostAdapter(),xiaohongshu:new FillAdapter('xiaohongshu')};
