import {listTargets} from '../platforms/targets';
import {mergeTags} from '../core/model';
import {workspaceChanged} from '../core/changes';
import {restoreZsxqBackup,cancelZsxqPreparationForRestore} from '../platforms/zsxq-backup';
import {batchSummary,needsTextImages} from '../core/post-routing';
import {textImages} from '../core/text-images';
import {overflowPlatforms,postOverflow,cardSnapshot} from '../core/post-limits';
import {validatePublicationOptions} from '../platforms/video-options';
import {verifyPublication} from '../platforms/publication-result';
import {publicationFor,publicationProbe,submitPublication,readPublicationReceipt} from '../platforms/publication';
import { adapters, hasPermission } from '../platforms/adapters';
import { platforms, platformFor, capabilityFor, normaliseSettings, normaliseSelection, publicationAvailable,safeUrl,platformOrigins,type Account, type PublishTask, type Settings, type PlatformSelections } from '../core/model';
import { db, deleteDraft, enqueue, log, recoverInterruptedTasks, saveDraft, updateTask,claimNextTask,pruneHistory,protectedTask,taskSummary,HISTORY_LIMIT } from '../core/repository';
import { RequestSchema, SyncError, validateSyncTitle, errorValue, trustedUi, type Request } from '../core/protocol';

const defaults: Settings = { zsxqGroupId:'', showPreview:false };
export default defineBackground(() => {
  const recovery = recoverInterruptedTasks().then(pruneHistory).catch(error=>log('recovery_failed',errorValue(error).message,undefined,'error'));
  let activeTask: string | undefined;
  let settingsWrite:Promise<unknown>=Promise.resolve();
  let drainPromise:Promise<void>|undefined;let drainRequested=false;
  const pendingResults=new Set<string>();let lastSubmittedAt:number|undefined;
  function scheduleDrain(){
    drainRequested=true;if(drainPromise||activeTask)return;
    drainPromise=(async()=>{
      await recovery;
      do {
        drainRequested=false;
        for(;;){
          if(activeTask){drainRequested=true;return;}
          // Reserve this worker before awaiting the database claim, so manual verification
          // cannot interleave and strand a persisted preparing/saving task.
          activeTask='queue-claim';
          try {
            const claimed=await claimNextTask();if(!claimed)break;activeTask=claimed.id;const next:PublishTask=await updateTask(claimed.id,[claimed.status],{timings:{...claimed.timings,startedAt:Date.now(),...(lastSubmittedAt?{dispatchDelayMs:Date.now()-lastSubmittedAt}:{})}});lastSubmittedAt=undefined;
            if(next.status==='publishing')await publish(next.id,true,true);
            else if(next.status==='saving_draft')await confirm(next.id,true,true);
            else {const result=await prepare(next.id,true,true);if(result.status==='ready_for_confirmation'){if(result.operation==='publish')await publish(next.id,true);else await confirm(next.id,false,true);}}
            await announceBatch(next.batchId);
          } catch(error) {
            const id=activeTask;if(id!=='queue-claim'){const latest=await task(id);if(['preparing','saving_draft','publishing','ready_for_confirmation'].includes(latest.status)){const uncertain=latest.status!=='preparing'&&latest.status!=='ready_for_confirmation'||!!latest.proof?.uploadedMediaIds?.length;await updateTask(id,[latest.status],{status:uncertain?'unknown':'failed',progress:uncertain?'平台操作中断，结果待核对':'同步未完成，继续其他平台',error:{...errorValue(error),retrySafe:!uncertain}});}await log('queue_task_failed',errorValue(error).message,id,'error');await announceBatch(latest.batchId);}else throw error;
          } finally {activeTask=undefined;}
        }
      } while(drainRequested);
      for(const id of [...pendingResults]){pendingResults.delete(id);try{const current=await task(id);if(['submitted','unknown'].includes(current.status))await verify(id);}catch{await log('publication_verification_pending','发布结果尚未核对，不重复提交',id);}}
      await pruneHistory();
    })().catch(error=>log('queue_failed',errorValue(error).message,undefined,'error'))
      .then(()=>undefined).finally(()=>{drainPromise=undefined;if(drainRequested&&!activeTask)scheduleDrain();});
  }
  async function announceBatch(batchId:string){
    const jobs=(await(await db()).getAll('tasks')).filter(t=>t.batchId===batchId);const summary=batchSummary(jobs);
    try{if(chrome.action?.setBadgeText){await chrome.action.setBadgeText({text:summary.running?String(summary.running):summary.issues.length?'!':''});await chrome.action.setBadgeBackgroundColor({color:summary.issues.length?'#c34838':'#3869d7'});}}catch{}
    if(!summary.done||!summary.issues.length)return;
    const source=jobs.find(t=>t.source)?.source;if(!source)return;
    // Return to the visible result only when our batch owns the foreground tab.
    // Never steal focus from an unrelated user page.
    try{const active=(await chrome.tabs.query({windowId:source.windowId,active:true}))[0];if(active?.id===source.tabId||jobs.some(t=>t.tabId===active?.id))await chrome.tabs.update(source.tabId,{active:true});}catch{}
  }
  async function task(id:string) { const value=await (await db()).get('tasks',id); if(!value) throw new SyncError('TASK_MISSING','任务不存在'); return value; }
  async function exclusive<T>(id:string, run:()=>Promise<T>,owned=false) {
    await recovery;
    if(activeTask&&!owned) throw new SyncError('TASK_BUSY','另一个任务正在操作平台，请稍后再试');
    if(owned&&activeTask!==id)throw new Error('Queue ownership mismatch');
    activeTask=id;try{return await run();}finally{if(!owned){await pruneHistory();activeTask=undefined;if(drainRequested)scheduleDrain();}}
  }
  async function accounts() {
    const d=await db();const result:Account[]=[];
    for(const p of platforms) { const a=await adapters[p.id].detectSession();await d.put('accounts',a);result.push(a); } return result;
  }
  async function workspace() {
    const d=await db(); const [drafts,tasks,storedAccounts,logs,backups]=await Promise.all([d.getAll('drafts'),d.getAll('tasks'),d.getAll('accounts'),d.getAll('logs'),d.getAll('backups')]);
    const stored=await chrome.storage.local.get(['settings','platformSelection_post','platformSelection_article','platformSelection_video']);
    const settings = stored.settings as Settings | undefined;
    const platformSelections:PlatformSelections={post:normaliseSelection(stored.platformSelection_post,'post'),article:normaliseSelection(stored.platformSelection_article,'article'),video:normaliseSelection(stored.platformSelection_video,'video')};
    const accounts:Account[]=[];
    for(const p of platforms) { const existing=storedAccounts.find(a=>a.platform===p.id); accounts.push(await hasPermission(p.id) ? existing || {platform:p.id,status:'unknown',checkedAt:0,targetId:''} : {platform:p.id,status:'permission_required',checkedAt:Date.now(),targetId:''}); }
    return {drafts:drafts.sort((a,b)=>b.updatedAt-a.updatedAt),tasks:tasks.sort((a,b)=>b.createdAt-a.createdAt).map(taskSummary),backups:backups.filter(b=>b.state!=='restored').map(({text:_text,digest:_digest,accountKey:_account,...summary})=>summary),history:{limit:HISTORY_LIMIT,retained:tasks.filter(t=>!protectedTask(t,backups)).length,protected:tasks.filter(t=>protectedTask(t,backups)).length},accounts,settings:normaliseSettings(settings),platformSelections,logs:logs.sort((a,b)=>b.time-a.time)};
  }
  async function prepare(id:string,claimed=false,owned=false) { return exclusive(id,async()=>{
    const original=await task(id);
    if(original.status!==(claimed?'preparing':'queued')) throw new SyncError('TASK_STATE','此任务目前不能开始填写');
    let current=claimed?original:await updateTask(id,['queued'],{status:'preparing',progress:'正在打开平台编辑器',error:undefined});
    try {
      validateSyncTitle(current.snapshot.title);
      adapters[current.platform].validate(current.snapshot,current.targetId);
      let tabId:number;
      if(current.parentTaskId){if(current.tabId===undefined)throw new SyncError('PREPARED_PAGE_REQUIRED','原填写页已关闭，请保留历史并重新准备内容',false);await chrome.tabs.get(current.tabId);tabId=current.tabId;}else tabId=await adapters[current.platform].openEditor(current);
      current=await updateTask(id,['preparing'],{tabId,progress:current.parentTaskId?'正在核对并复用原填写页':'正在写入内容和附件',timings:{...current.timings,editorReadyAt:Date.now()}});
      let observed;
      if(current.parentTaskId){const checked=await adapters[current.platform].verifyDraft(current);current=await task(id);observed={bodyDigest:current.proof!.bodyDigest,mediaHashes:current.proof!.mediaHashes};await log('prepared_page_reused','只读核对并复用原填写页，未重传附件',id);}
      else observed=await adapters[current.platform].fillEditor(current,tabId);
      if(current.operation==='fill')return updateTask(id,['preparing'],{status:'filled',timings:{...current.timings,filledAt:Date.now()},progress:'已填写，待发布',proof:{...((await task(id)).proof),bodyDigest:observed.bodyDigest,mediaHashes:observed.mediaHashes},error:undefined});
      await log('editor_prepared','字段填写及回读通过，正在继续目标操作',id);
      return updateTask(id,['preparing'],{status:'ready_for_confirmation',timings:{...current.timings,filledAt:Date.now()},progress:current.operation==='publish'?'已填写，正在检查发布条件':'已填写，正在继续保存草稿',proof:{...((await task(id)).proof),bodyDigest:observed.bodyDigest,mediaHashes:observed.mediaHashes}});
    } catch(error) {
      const detail=errorValue(error);await log(detail.code,detail.message,id,'error');
      const latest=await task(id);if(latest.status!=='preparing')return latest;
      if(['LOGIN_REQUIRED','VERIFICATION_REQUIRED'].includes(detail.code)&&latest.tabId)await chrome.tabs.update(latest.tabId,{active:true});
      const retrySafe=detail.retrySafe&&!latest.proof?.uploadedMediaIds?.length;
      const stopped=await updateTask(id,['preparing'],{status:retrySafe?'failed':'unknown',progress:retrySafe?'填写未完成':'已操作平台，结果待核对',error:{...detail,retrySafe}});await restoreOriginal(stopped);return task(id);
    }
  },owned); }
  async function confirm(id:string,claimed=false,owned=false) {return exclusive(id,async()=>{
    const original=await task(id);
    if(original.status!==(claimed?'saving_draft':'ready_for_confirmation')) throw new SyncError('TASK_STATE','只有待确认任务可以保存草稿');
    // Commit uncertainty before any site-side save action. All subsequent failures are unknown.
    let current=claimed?original:await updateTask(id,['ready_for_confirmation'],{status:'saving_draft',progress:'正在保存草稿并重新打开核对'});
    try {
      const receipt=await adapters[current.platform].saveDraft(current);
      current=await updateTask(id,['saving_draft'],{saveNotice:receipt.notice});
      const evidence=await adapters[current.platform].verifyDraft(current);
      await log('draft_verified','平台页面重新打开后标题、正文和媒体数量核对通过',id);
      return updateTask(id,['saving_draft'],{status:'draft_saved',progress:'草稿已保存并通过重新打开核对',evidence,error:undefined});
    } catch(error) {
      const detail=errorValue(error);await log(detail.code,detail.message,id,'error');
      const latest=await task(id);if(latest.status!=='saving_draft')return latest;
      return updateTask(id,['saving_draft'],{status:'unknown',progress:'保存结果待核对，请检查平台草稿',error:{...detail,retrySafe:false}});
    }
  },owned);}
  async function publish(id:string,owned=false,claimed=false){return exclusive(id,async()=>{
    let current=await task(id);
    if(current.status!==(claimed?'publishing':'ready_for_confirmation')||current.operation!=='publish')throw new SyncError('TASK_STATE','当前任务不能发布');
    // A queue claim is not a submit. Zsxq rebuilds use preparation states before the durable submit marker.
    if(claimed&&current.platform==='zsxq'&&current.snapshot.type==='post'&&!current.publicationAttemptedAt)current=await updateTask(id,['publishing'],{status:'ready_for_confirmation',progress:'正在检查发布条件，尚未提交'});
    try {
      validateSyncTitle(current.snapshot.title);
      // Full readback before side effects, then durable uncertainty before click.
      const a=adapters[current.platform];const guard=a.preparePublication?await a.preparePublication(current):(await a.verifyDraft(current),await publicationProbe(current));
      current=await updateTask(id,[current.status],{publicationGuard:guard});
    } catch(error){const detail=errorValue(error);const stopped=await updateTask(id,[current.status],{status:current.publicationAttemptedAt?'unknown':'failed',progress:'发布条件未满足，尚未提交',error:{...detail,retrySafe:false}});await restoreOriginal(stopped);return task(id);}
    current=await updateTask(id,[current.status],{status:'publishing',publicationAttemptedAt:Date.now(),progress:'正在发布，等待平台回执'});
    try {
      const a=adapters[current.platform];const evidence=await(a.publish?a.publish(current):submitPublication(current));
      current=await updateTask(id,['publishing'],{status:'submitted',timings:{...current.timings,submittedAt:Date.now()},progress:'平台已确认提交发布，待核对发布结果',evidence,error:undefined});
    } catch(error){const latest=await task(id);if(latest.status!=='publishing')return latest;if(errorValue(error).code==='VERIFICATION_REQUIRED'&&latest.tabId)await chrome.tabs.update(latest.tabId,{active:true});current=await updateTask(id,['publishing'],{status:'unknown',progress:'发布结果待核对，禁止重复发布',error:{...errorValue(error),retrySafe:false}});}
    if(current.status==='submitted')lastSubmittedAt=current.timings?.submittedAt;
    if(current.platform==='zsxq'&&(await(await db()).getAll('backups')).some(b=>b.taskId===id&&b.state!=='restored')){try{return await readPublication(current);}catch{await restoreOriginal(current);return task(id);}}
    pendingResults.add(id);if(!drainPromise)scheduleDrain();return current;

  },owned);}
  async function verify(id:string,source?:PublishTask['source']) {return exclusive(id,async()=>{
    const current=await task(id);
    if(current.status==='filled'&&current.operation==='fill'){try{const evidence=await adapters[current.platform].verifyDraft(current);return updateTask(id,['filled'],{evidence,progress:'已重新核对填写，待发布'});}catch(error){return updateTask(id,['filled'],{status:'unknown',progress:'原填写页内容或附件已变化，请人工核对，不重传',error:{code:'FILL_CHANGED',message:errorValue(error).message,retrySafe:false}});}}
    if(!['unknown','submitted','ready_for_confirmation'].includes(current.status)) throw new SyncError('TASK_STATE','当前任务无需核对');
    if(current.operation==='publish')return readPublication(current,source);
    const evidence=await adapters[current.platform].verifyDraft(current);
    if(current.status==='ready_for_confirmation') throw new SyncError('CONFIRM_REQUIRED','已重新打开核对，请通过确认保存流程完成任务');
    return updateTask(id,['unknown'],{status:current.operation==='fill'?'filled':'draft_saved',progress:current.operation==='fill'?'已填写，待发布':'平台草稿重新打开核对通过',evidence,error:undefined});
  });}
  async function restoreOriginal(current:PublishTask){
    if(current.platform!=='zsxq')return;
    for(const backup of await(await db()).getAll('backups'))if(backup.taskId===current.id&&backup.state!=='restored'){try{await restoreZsxqBackup(current,backup);}catch(error){await(await db()).put('backups',{...backup,state:'restore_pending',updatedAt:Date.now(),note:errorValue(error).message});workspaceChanged();}}
  }
  async function readPublication(current:PublishTask,source=current.source){
    if(!['unknown','submitted'].includes(current.status))return current;
    if(current.status==='unknown'){const receipt=await readPublicationReceipt(current);if(receipt){current=await updateTask(current.id,['unknown'],{status:'submitted',evidence:receipt,progress:'平台已确认发布，公开结果待核对',timings:{...current.timings,submittedAt:receipt.checkedAt},error:undefined});}}
    const a=adapters[current.platform],verificationTask={...current,source};let evidence;try{evidence=await(a.verifyPublication?a.verifyPublication(verificationTask):verifyPublication(verificationTask));}catch(error){if(current.status==='submitted'){await log('publication_result_pending',errorValue(error).message,current.id);return current;}throw error;}
    if(evidence.kind==='publication_receipt')return updateTask(current.id,[current.status],{status:'submitted',error:undefined,evidence,progress:evidence.notice||'已确认平台接收，内容完整性仍待核对',...(evidence.contentId?{publicationResult:{id:evidence.contentId,url:evidence.url,visibility:'public' as const,checkedAt:evidence.checkedAt}}:{})});
    const published=await updateTask(current.id,[current.status],{status:'published',timings:{...current.timings,verifiedAt:Date.now()},progress:'已发布并核对正文与媒体',evidence,publicationResult:{id:evidence.contentId!,url:evidence.url,visibility:'public',checkedAt:evidence.checkedAt},error:undefined});
    await restoreOriginal(published);return task(current.id);
  }
  async function handle(r:Request):Promise<unknown> {
    await recovery; const d=await db();
    if('source' in r.payload&&r.payload.source){const originTab=await chrome.tabs.get(r.payload.source.tabId);if(originTab.windowId!==r.payload.source.windowId||(r.payload.source.surface!=='sidepanel'&&originTab.url!==undefined&&!originTab.url.startsWith(chrome.runtime.getURL(''))))throw new SyncError('SOURCE_WINDOW','来源编辑窗口已变化');}
    switch(r.action) {
      case 'LIST_TARGETS':return listTargets(r.payload.platform,r.payload.query,r.payload.refresh,r.payload.source);
      case 'WORKSPACE': return workspace();
      case 'EXPORT_BACKUP': {const backup=await d.get('backups',r.payload.id);if(!backup)throw new SyncError('BACKUP_MISSING','原稿备份不存在');return {text:backup.text,targetId:backup.targetId,createdAt:backup.createdAt};}
      case 'RESTORE_BACKUP': {const backup=await d.get('backups',r.payload.id);if(!backup)throw new SyncError('BACKUP_MISSING','原稿备份不存在');return exclusive(backup.taskId,async()=>{let current:PublishTask=await task(backup.taskId);current=await cancelZsxqPreparationForRestore(current,backup);return restoreZsxqBackup(current,backup);});}
      case 'SET_PLATFORM_SELECTION': {const selected=normaliseSelection(r.payload.platforms,r.payload.type);await chrome.storage.local.set({['platformSelection_'+r.payload.type]:selected});workspaceChanged();return selected;}
      case 'PREPARE_PUBLICATION':return exclusive(r.payload.id,async()=>{
        let current=await task(r.payload.id);
        const queued=current.status==='queued'&&current.operation==='fill'&&!current.autoRun&&!current.proof;
        if(current.snapshot.type!=='post'||!publicationAvailable(current.platform,'post')||!['queued','filled','failed','ready_for_confirmation'].includes(current.status)||current.status==='queued'&&!queued||current.publicationAttemptedAt||current.supersededByTaskId||current.error?.code==='CANCELLED_FOR_RESTORE'||!queued&&(!current.proof?.bodyDigest||current.tabId===undefined))throw new SyncError('NEEDS_PREPARATION','仅能准备未开始的手动任务或原页完整且从未提交的动态；未知任务只核对。',false);
        validateSyncTitle(current.snapshot.title);if(!queued)await chrome.tabs.get(current.tabId!);
        if(current.operation==='fill'){
          current=await enqueue(current.snapshot,current.platform,current.targetId,crypto.randomUUID(),false,'publish',current.source,true);
          if(current.operation!=='publish'||current.publicationAttemptedAt||!['queued','ready_for_confirmation','failed'].includes(current.status))throw new SyncError('UNSAFE_RECOVERY','关联任务已有不确定操作，不能重新准备',false);
          activeTask=current.id;
          if(current.status==='queued'){current=await prepare(current.id,false,true);if(current.status!=='ready_for_confirmation')return current;}
          else current=await updateTask(current.id,[current.status],{status:'ready_for_confirmation',autoRun:false});
        }else current=await updateTask(current.id,[current.status],{status:'ready_for_confirmation',autoRun:false});
        try{const a=adapters[current.platform];const guard=a.preparePublication?await a.preparePublication(current):(await a.verifyDraft(current),await publicationProbe(current));return updateTask(current.id,['ready_for_confirmation'],{publicationGuard:guard,autoRun:false,error:undefined,progress:'发布准备完成，等待用户验收；尚未提交'});}
        catch(error){await updateTask(current.id,['ready_for_confirmation'],{status:'failed',autoRun:false,error:{...errorValue(error),retrySafe:false},progress:'发布准备未完成，尚未提交'});throw error;}
      });
      case 'CHECK_PUBLICATION': return exclusive(r.payload.id,async()=>{const current=await task(r.payload.id);if(current.snapshot.type!=='post'||!publicationAvailable(current.platform,'post')||!['filled','failed','ready_for_confirmation'].includes(current.status)||current.supersededByTaskId||current.error?.code==='CANCELLED_FOR_RESTORE'||current.publicationAttemptedAt||!current.proof?.bodyDigest||current.tabId===undefined)throw new SyncError('NEEDS_PREPARATION','请先完成动态填写，再检查发布条件；已提交或未知任务仅核对结果。',false);validateSyncTitle(current.snapshot.title);await adapters[current.platform].verifyDraft(current,true);await publicationProbe(current);return {ready:true,checkedAt:Date.now()};});
      case 'SAVE_DRAFT': return saveDraft(r.payload.draft,r.payload.expectedRevision);
      case 'REMOVE_DRAFT': { const tasks=await d.getAll('tasks'); if(tasks.some(t=>t.snapshot.id===r.payload.id && !['draft_saved','filled','submitted','published','failed'].includes(t.status))) throw new SyncError('DRAFT_IN_USE','草稿仍有未结束任务，请保留其图片与正文'); return deleteDraft(r.payload.id); }
      case 'SETTINGS': {const pending=settingsWrite.then(async()=>{const prior=normaliseSettings((await chrome.storage.local.get('settings')).settings as Partial<Settings>|undefined),patch={...r.payload};if(patch.zsxqGroupId!==undefined&&patch.zsxqTargets===undefined&&patch.zsxqGroupId!==prior.zsxqGroupId)patch.zsxqTargets=patch.zsxqGroupId?[patch.zsxqGroupId]:[];const settings=normaliseSettings({...prior,...patch});await chrome.storage.local.set({settings});workspaceChanged();return settings;});settingsWrite=pending.catch(()=>undefined);return pending;}
      case 'REFRESH_ACCOUNTS': return accounts();
      case 'CONNECT': await chrome.tabs.create({url:platformFor(r.payload.platform).home,active:true}); return adapters[r.payload.platform].detectSession();
      case 'ENQUEUE': case 'START_SYNC': {
        const storedDraft=await d.get('drafts',r.payload.draftId); if(!storedDraft) throw new SyncError('DRAFT_MISSING','请先保存本地草稿');
        const settings=((await chrome.storage.local.get('settings')).settings||defaults) as Settings;
        const draft={...storedDraft,tags:mergeTags(settings.fixedTags,storedDraft.tags)};validateSyncTitle(draft.title);if(draft.tags.length>30)throw new SyncError('TAG_LIMIT','固定标签与普通标签合计最多30个'); const batch=crypto.randomUUID();const tasks:PublishTask[]=[];
        let generated:Awaited<ReturnType<typeof textImages>>|undefined;
        const automatic=r.action==='START_SYNC';
        if(automatic&&overflowPlatforms(draft,r.payload.platforms).length&&!r.payload.overflow)throw new SyncError('OVERFLOW_CHOICE_REQUIRED','有平台正文与标签超限，请选择跳过或正文转图片。');
        if(r.action==='START_SYNC')for(const platform of r.payload.publishPlatforms){validatePublicationOptions(platform,draft);if(!r.payload.platforms.includes(platform)||!publicationAvailable(platform,draft.type))throw new SyncError('PUBLISH_UNIMPLEMENTED','直接发布目标不在已实现的当前选择中');}
        if(!automatic)for(const platform of [...new Set(r.payload.platforms)]) { const targetId=platform==='zsxq'?settings.zsxqGroupId:''; adapters[platform].validate(draft,targetId);if(!await hasPermission(platform,draft.type))throw new SyncError('PERMISSION_REQUIRED',`请先连接${platformFor(platform).name}`); }
        for(const platform of [...new Set(r.payload.platforms)]){
         const targetIds=platform==='zsxq'?normaliseSettings(settings).zsxqTargets!:platform==='jike'?[settings.jikeCircle||'']:[''];
         if(!targetIds.length)throw new SyncError('TARGET_REQUIRED','请选择目标星球');
         for(const targetId of targetIds){
          const wantsPublish=r.action==='START_SYNC'&&r.payload.publishPlatforms.includes(platform);
          if(wantsPublish&&!publicationAvailable(platform,draft.type))throw new SyncError('PUBLISH_UNIMPLEMENTED',`${platformFor(platform).name}此内容类型尚未开放直接发布`);
          const operation=wantsPublish?'publish':capabilityFor(platform,draft.type)?.operation||'fill';
          let snapshot=draft;
          let renderError:unknown;let skipReason='';
          const overflow=automatic?postOverflow(draft,platform):undefined;
          if(overflow){
            if(r.action==='START_SYNC'&&r.payload.overflow==='images'&&overflow.canConvert){try{generated??=await textImages(draft);snapshot=cardSnapshot(draft,generated,platform);}catch(error){skipReason=errorValue(error).message;}}
            else skipReason=overflow.canConvert?`正文和标签共${overflow.length}字符，超过${overflow.limit}上限；按本次选择跳过。`:`标签本身${overflow.tagsLength}字符，超过${overflow.limit}上限；请精简标签，已跳过。`;
          }else if(automatic&&normaliseSettings(settings).autoTextImages&&needsTextImages(draft,platform)){try{generated??=await textImages(draft);snapshot={...draft,media:generated};}catch(error){renderError=error;}}
          let next:PublishTask;try{next=await enqueue(snapshot,platform,targetId,batch,automatic&&!skipReason&&!renderError,operation,r.payload.source);}catch(error){if(automatic)scheduleDrain();throw error;}
          if(skipReason&&next.status==='queued'&&next.batchId===batch)next=await updateTask(next.id,['queued'],{status:'failed',autoRun:false,progress:'已跳过，未打开平台',error:{code:'POST_LIMIT_SKIPPED',message:skipReason,retrySafe:false}});
          else if(renderError&&next.status==='queued'&&next.batchId===batch)next=await updateTask(next.id,['queued'],{status:'failed',progress:'文字图片未生成，其他平台继续',error:{code:'TEXT_IMAGE_FAILED',message:errorValue(renderError).message,retrySafe:true}});

          if(next.batchId===batch&&(platform==='zsxq'||platform==='jike')){const choices=((await chrome.storage.local.get('targetOptions')).targetOptions||{}) as Record<string,Array<{id:string;name:string}>>;const targetName=next.targetName||choices[platform]?.find((o:{id:string})=>o.id===targetId)?.name||targetId;next=await updateTask(next.id,[next.status],{targetName});}
          tasks.push(next);
         }
        }
        if(automatic)scheduleDrain();return tasks;
      }
      case 'CONTINUE_QUEUE': {for(const t of await d.getAll('tasks'))if(['queued','ready_for_confirmation'].includes(t.status)&&t.operation!=='publish')await updateTask(t.id,[t.status],{autoRun:true,source:r.payload.source||t.source});scheduleDrain();return;}
      case 'PREPARE': return prepare(r.payload.id);
      case 'CONFIRM_SAVE': return confirm(r.payload.id);
      case 'VERIFY': return verify(r.payload.id,r.payload.source);
      case 'RETRY': { const t=await task(r.payload.id);if(t.status!=='failed'||!t.error?.retrySafe||t.supersededByTaskId||t.publicationAttemptedAt||t.proof?.uploadedMediaIds?.length)throw new SyncError('UNSAFE_RETRY','此任务不能安全重试，请先核对平台结果',false);if(['bilibili','x'].includes(t.platform)&&t.error.code==='PAGE_LOAD_FAILED'){const linked=await enqueue(t.snapshot,t.platform,t.targetId,crypto.randomUUID(),true,t.operation,r.payload.source||t.source);scheduleDrain();return linked;}const retried=await updateTask(t.id,['failed'],{status:'queued',autoRun:true,attemptId:crypto.randomUUID(),progress:'等待自动重新填写',error:undefined,source:r.payload.source||t.source});scheduleDrain();return retried; }
      case 'RECOVER_FILL':return exclusive(r.payload.id,async()=>{const current=await task(r.payload.id);if(!['unknown','failed'].includes(current.status)||current.status==='failed'&&current.error?.code!=='FILL_UNCONFIRMED'||current.supersededByTaskId||!['fill','publish'].includes(current.operation||'')||current.publicationAttemptedAt||!adapters[current.platform].recoverEditor)throw new SyncError('UNSAFE_RECOVERY','此任务只能核对原结果',false);const result=await adapters[current.platform].recoverEditor!(current,r.payload.videoMetadata);return updateTask(current.id,['unknown','failed','preparing'],{status:current.operation==='publish'?'ready_for_confirmation':'filled',autoRun:false,progress:current.platform==='x'&&current.error?.code==='MEDIA_IDENTITY'?'原页正文、图片及顺序已只读核对；尚未发布':'原媒体已核对，空字段已补填；尚未发布',proof:result.proof,evidence:result.evidence,error:undefined});});
      case 'RESUME_PUBLICATION': {return exclusive(r.payload.id,async()=>{const current=await task(r.payload.id);if(current.operation!=='publish'||!['failed','ready_for_confirmation'].includes(current.status)||current.publicationAttemptedAt||current.supersededByTaskId||current.error?.code==='CANCELLED_FOR_RESTORE')throw new SyncError('UNSAFE_RETRY','只有尚未点击发布的准备任务可以继续，已提交或未知结果不能重发',false);if(!current.proof?.bodyDigest||current.tabId===undefined)throw new SyncError('NEEDS_PREPARATION','此任务尚未完成填写，请重新准备后发布；原失败原因已保留',false);await updateTask(current.id,[current.status],{status:'ready_for_confirmation',error:undefined,source:r.payload.source||current.source,progress:'只读核对原页后继续发布'});return publish(current.id,true);});}
      case 'CONFIRM_PUBLICATION_RESULT': {
        const current=await task(r.payload.id);if(current.operation!=='publish'||!['unknown','submitted','failed'].includes(current.status))throw new SyncError('TASK_STATE','当前任务无需人工发布结果确认');
        const result=new URL(r.payload.url);const origins=[platformFor(current.platform).origin,...(current.platform==='bilibili'?['https://t.bilibili.com','https://www.bilibili.com']:[]),...(current.platform==='xiaohongshu'?['https://www.xiaohongshu.com']:[]),...(current.platform==='douyin'?['https://www.douyin.com']:[]),...(current.platform==='kuaishou'?['https://www.kuaishou.com']:[])];
        if(!origins.includes(result.origin)||result.username||result.password)throw new SyncError('RESULT_ORIGIN','请填写此目标平台的正常结果链接');
        const id=current.platform==='weixin'?(result.pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/)?.[1]||(result.pathname==='/s'&&result.searchParams.get('__biz')&&result.searchParams.get('mid')?[result.searchParams.get('__biz'),result.searchParams.get('mid'),result.searchParams.get('idx')||'1'].join(':'):'')):result.pathname.match(/\/(?:post|status|topic|topic_detail|opus|explore|discovery\/item|video|short-video|photo)\/([A-Za-z0-9_-]+)/)?.[1]||['id','topicId','noteId','feedId','objectId'].map(k=>result.searchParams.get(k)).find(Boolean);
        if(r.payload.visibility==='public'&&(!id||id.length<5||/\/(?:create|edit|publish|upload|draft)(?:[/?]|$)/i.test(result.pathname)||id===current.targetId))throw new SyncError('RESULT_ID','已公开需要具体内容的详情链接，不能使用平台首页');
        const url=safeUrl(result.href),checkedAt=Date.now();const confirmed=await updateTask(current.id,[current.status],{status:r.payload.visibility==='public'?'published':'submitted',progress:r.payload.visibility==='public'?'用户已人工核对发布内容与媒体':'用户确认平台已接收，审核或处理尚未完成',publicationResult:{id:id||'',url,visibility:r.payload.visibility,checkedAt},evidence:{kind:r.payload.visibility==='public'?'publication_result':'publication_receipt',checkedAt,...(r.payload.visibility==='public'?{title:current.snapshot.title,bodyMatched:true,mediaCount:current.snapshot.media.length,mediaMatched:true}:{}),url,contentId:id||'',verificationSource:'user',notice:'用户通过人工确认表单核对结果'},error:undefined});if(confirmed.status==='published')await restoreOriginal(confirmed);await pruneHistory();return confirmed;
      }
      case 'OPEN_TASK': {
        const t=await task(r.payload.id);
        if(t.tabId) {try{const tab=await chrome.tabs.get(t.tabId);if(tab.url&&platformOrigins(t.platform,t.snapshot.type).includes(new URL(tab.url).origin)){await chrome.tabs.update(t.tabId,{active:true});return;}}catch{}}
        const url=t.publicationResult?.url||(t.platform==='zsxq'?(t.snapshot.type==='post'?`https://wx.zsxq.com/group/${t.targetId}`:`https://wx.zsxq.com/article?groupId=${t.targetId}`):t.platform==='bilibili'&&t.snapshot.type==='post'?'https://t.bilibili.com/':t.platform==='xiaohongshu'?'https://creator.xiaohongshu.com/new/note-manager':platformFor(t.platform).home);
        await chrome.tabs.create({url,active:true});return;

      }
    }
  }
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.channel!=='ling-sync')return false;
    if(!trustedUi(sender,chrome.runtime.id)){reply({ok:false,error:{code:'UNTRUSTED_SENDER',message:'只允许灵同步页面发起操作'}});return false;}
    const parsed=RequestSchema.safeParse(message);if(!parsed.success){reply({ok:false,error:{code:'INVALID_MESSAGE',message:'请求格式无效'}});return false;}
    handle(parsed.data).then(value=>reply({ok:true,value}),error=>reply({ok:false,error:errorValue(error)}));return true;
  });
  chrome.sidePanel.onClosed?.addListener(({windowId})=>{if(windowId!==undefined){const key='editor-session:'+windowId;void chrome.storage.session.get(key).then(data=>chrome.storage.session.set({[key]:{...(data[key] as object||{}),closed:true}}));}});
  chrome.runtime.onInstalled.addListener(()=>{
    void chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});
    void chrome.alarms.create('reconcile',{periodInMinutes:1});
  });
  chrome.runtime.onStartup.addListener(()=>{void chrome.alarms.create('reconcile',{periodInMinutes:1});});
  chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='reconcile')scheduleDrain();});
  void recovery.then(scheduleDrain);
  chrome.permissions.onRemoved.addListener(()=>{void log('permission_removed','用户取消站点访问；后续任务会重新检查权限');});
  chrome.tabs.onRemoved.addListener(tabId=>{void (async()=>{
    await recovery;
    for(const t of await (await db()).getAll('tasks')) if(t.tabId===tabId) {
      const status=t.status==='saving_draft'||t.status==='publishing'||t.status==='preparing'&&(t.snapshot.type==='video'||!!t.proof?.uploadedMediaIds?.length)?'unknown':['preparing','ready_for_confirmation'].includes(t.status)?'failed':t.status;
      // A terminal failure/unknown already has a meaningful cause. Closing its
      // page only removes the page reference; never turn it into a safe retry.
      const interrupted=status!==t.status;
      await updateTask(t.id,[t.status],{tabId:undefined,status,...(interrupted?{progress:status==='unknown'?'任务页关闭，平台操作结果待核对':'任务页已关闭，可重新填写',error:{code:'TAB_CLOSED',message:'任务标签页被关闭',retrySafe:status==='failed'}}:{})}).then(restoreOriginal).catch(()=>{});
    }
  })().catch(()=>{});});
});
