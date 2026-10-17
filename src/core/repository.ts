import { openDB, type DBSchema } from 'idb';
import { DraftSchema, contentFingerprint, recoveryStatus, transitionAllowed, type Account, type ContentDraft, type Diagnostic, type DraftBackup, type TaskReceipt, type TaskSummary, type MediaRecord, type PublishTask, type Settings, type TaskStatus } from './model';
import {workspaceChanged} from './changes';

interface Data extends DBSchema {
  drafts: { key: string; value: ContentDraft };
  media: { key: string; value: MediaRecord; indexes: { draftId: string } };
  tasks: { key: string; value: PublishTask & { fingerprint: string } };
  accounts: { key: string; value: Account };
  settings: { key: string; value: Settings };
  logs: { key: string; value: Diagnostic };
  backups: { key:string;value:DraftBackup };
  receipts: {key:string;value:TaskReceipt};
}
let database: ReturnType<typeof openDB<Data>> | undefined;
export function db() {
  return database ??= openDB<Data>('ling-sync', 3, { upgrade(d,oldVersion,_newVersion,tx) {
    if(oldVersion<3){d.createObjectStore('backups',{keyPath:'id'});d.createObjectStore('receipts',{keyPath:'fingerprint'});}
    if(oldVersion===0){d.createObjectStore('drafts', { keyPath: 'id' });
    d.createObjectStore('media', { keyPath: 'id' }).createIndex('draftId', 'draftId');
    d.createObjectStore('tasks', { keyPath: 'id' }); d.createObjectStore('accounts', { keyPath: 'platform' });
    d.createObjectStore('settings'); d.createObjectStore('logs', { keyPath: 'id' });}
    if(oldVersion===1){
      void (async()=>{let cursor=await tx.objectStore('drafts').openCursor();while(cursor){await cursor.update(DraftSchema.parse(cursor.value));cursor=await cursor.continue();}})().catch(()=>tx.abort());
      void (async()=>{let cursor=await tx.objectStore('tasks').openCursor();while(cursor){await cursor.update({...cursor.value,snapshot:DraftSchema.parse(cursor.value.snapshot),autoRun:false,operation:cursor.value.operation||'save_draft'});cursor=await cursor.continue();}})().catch(()=>tx.abort());
      void (async()=>{let cursor=await tx.objectStore('media').openCursor();while(cursor){await cursor.update({...cursor.value,kind:cursor.value.kind||'image'});cursor=await cursor.continue();}})().catch(()=>tx.abort());
    }
  } });
}
export async function saveDraft(value: ContentDraft, expectedRevision: number) {
  const input = DraftSchema.parse(value); const d = await db(); const tx = d.transaction('drafts', 'readwrite');
  const stored = await tx.store.get(input.id);
  if ((stored?.revision ?? 0) !== expectedRevision) { await tx.done; throw new Error('草稿已在另一个窗口修改。请重新加载后再编辑；本窗口内容尚未覆盖。'); }
  const next = { ...input, revision: expectedRevision + 1, updatedAt: Date.now() };
  await tx.store.put(next); await tx.done; workspaceChanged();return next;
}
export async function deleteDraft(id: string) {
  const d = await db(); const tx = d.transaction(['drafts', 'media', 'tasks'], 'readwrite');
  const retained = new Set((await tx.objectStore('tasks').getAll()).flatMap(task=>task.snapshot.media.map(media=>media.id)));
  for (const key of await tx.objectStore('media').index('draftId').getAllKeys(id)) if (!retained.has(key)) await tx.objectStore('media').delete(key);
  await tx.objectStore('drafts').delete(id); await tx.done;workspaceChanged();
}
export async function enqueue(snapshot: ContentDraft, platform: PublishTask['platform'], targetId: string, batchId: string,autoRun=false,operation:PublishTask['operation']='save_draft',source?:PublishTask['source'],manualPreparation=false) {
  const d = await db(); const tx = d.transaction(['drafts','media','tasks','receipts'], 'readwrite');
  const persisted=await tx.objectStore('drafts').get(snapshot.id);
  if(!persisted||persisted.revision!==snapshot.revision){await tx.done;throw new Error('草稿入队前已变化，请刷新后再加入队列');}
  for(const media of snapshot.media){const record=await tx.objectStore('media').get(media.id);if(!record||record.blob.size!==media.bytes){await tx.done;throw new Error('入队图片不完整，请重新添加图片后再加入队列');}}
  const fingerprint = contentFingerprint(snapshot, platform, targetId);
  const receipt=await tx.objectStore('receipts').get(fingerprint);
  if(receipt&&(receipt.operation==='publish'||receipt.operation===operation)){await tx.done;throw new Error('此版本已同步，详细历史已按50条上限清理；不会再次提交。请先核对平台结果。');}
  const store=tx.objectStore('tasks');
  const existingTasks=await store.getAll();
  const matching=existingTasks.filter(t=>contentFingerprint(t.snapshot,t.platform,t.targetId)===fingerprint).sort((a,b)=>(b.queueOrder??b.createdAt)-(a.queueOrder??a.createdAt));
  // Old keys remain readable. Uncertainty and existing publication always win.
  const existing=matching.find(t=>t.status==='unknown')||matching.find(t=>t.operation==='publish')||matching.find(t=>t.operation===operation||(!t.operation&&operation==='save_draft'));
  const safePrior=operation==='publish'&&!existing?matching.find(t=>t.status==='failed'&&t.error?.retrySafe&&!t.publicationAttemptedAt&&!t.proof?.uploadedMediaIds?.length):undefined;
  const superseded=existing?.status==='failed'&&(existing.error?.retrySafe||autoRun&&existing.error?.code==='POST_LIMIT_SKIPPED'&&snapshot.textAsImages)&&!existing.publicationAttemptedAt&&!existing.proof?.uploadedMediaIds?.length&&(existing.snapshot.textAsImages!==snapshot.textAsImages||JSON.stringify(existing.snapshot.media)!==JSON.stringify(snapshot.media)||autoRun&&['EDITOR_OCCUPIED','BACKUP_PENDING','PERMISSION_REQUIRED','LOGIN_REQUIRED','PAGE_LOAD_FAILED'].includes(existing.error.code))?existing:safePrior;
  if(existing&&!superseded){const next=autoRun&&['queued','ready_for_confirmation'].includes(existing.status)?{...existing,autoRun:true,source:source||existing.source}:existing;if(next!==existing)await store.put(next);await tx.done;return next;}
  const parent=operation==='publish'?matching.find(t=>t.operation==='fill'&&t.status==='filled'):undefined;
  const manualSource=manualPreparation&&operation==='publish'?matching.find(t=>t.operation==='fill'&&t.status==='queued'&&!t.proof&&!t.publicationAttemptedAt&&!t.autoRun):undefined;
  if(operation==='publish'&&!parent&&!manualSource&&matching.length&&!superseded){await tx.done;throw new Error('原任务仍未完成，请先核对，不能直接发布');}
  const now = Date.now();const queueOrder=existingTasks.reduce((max,t)=>Math.max(max,t.queueOrder??t.createdAt),now)+1;
  const task = { id: crypto.randomUUID(), batchId, platform, targetId, snapshot: structuredClone(snapshot), status: 'queued' as const, createdAt: now, updatedAt: now, attemptId: crypto.randomUUID(), progress: autoRun?'等待自动同步':'等待继续同步', fingerprint:fingerprint+':'+operation,queueOrder,autoRun,operation,source,...(superseded||manualSource?{supersedesTaskId:(superseded||manualSource)!.id}:{}),...(parent?{parentTaskId:parent.id,tabId:parent.tabId,proof:parent.proof,targetName:parent.targetName}: {}) };
  await store.put(task);if(manualSource)await store.put({...manualSource,status:'failed',autoRun:false,progress:'已建立关联准备任务，原任务未执行',supersededByTaskId:task.id,error:{code:'MANUAL_PREPARATION',message:'已建立关联发布准备任务；原任务未执行',retrySafe:false}});if(superseded)await store.put({...superseded,supersededByTaskId:task.id}); await tx.done;workspaceChanged();return task;
}
export async function updateTask(id: string, expected: TaskStatus[], patch: Partial<PublishTask>) {
  const d = await db(); const tx = d.transaction('tasks', 'readwrite'); const task = await tx.store.get(id);
  if (!task || !expected.includes(task.status)) { await tx.done; throw new Error('任务状态已变化，请刷新后核对'); }
  if(task.status==='failed'&&task.supersededByTaskId&&['queued','ready_for_confirmation'].includes(patch.status||'')){await tx.done;throw new Error('此失败记录已有后续任务，请使用最新同步记录，不能再次提交原任务');}
  // A queue claim precedes preflight; it can return to preparation only before submit uncertainty.
  if(task.status==='publishing'&&patch.status==='ready_for_confirmation'&&task.publicationAttemptedAt){await tx.done;throw new Error('已有提交标记，不能退回发布准备或再次提交');}
  if (patch.status && patch.status !== task.status && !transitionAllowed(task.status, patch.status)) { await tx.done; throw new Error('不允许的任务状态转换'); }
  const next = { ...task, ...patch, id: task.id, updatedAt: Date.now() }; await tx.store.put(next); await tx.done; workspaceChanged();return next;
}
export async function claimNextTask() {
  const d=await db();const tx=d.transaction('tasks','readwrite');const tasks=await tx.store.getAll();
  if(tasks.some(t=>t.status==='preparing'||t.status==='saving_draft'||t.status==='publishing')){await tx.done;return undefined;}
  const next=tasks.filter(t=>t.autoRun&&(t.status==='queued'||t.status==='ready_for_confirmation')).sort((a,b)=>(a.queueOrder??a.createdAt)-(b.queueOrder??b.createdAt))[0];
  if(!next){await tx.done;return undefined;}
  const claimed={...next,status:next.status==='queued'?'preparing' as const:next.operation==='publish'?'publishing' as const:'saving_draft' as const,updatedAt:Date.now(),progress:'正在自动同步'};
  await tx.store.put(claimed);await tx.done;workspaceChanged();return claimed;
}
export async function recoverInterruptedTasks() {
  const d = await db();
  // 0.2.5 accidentally replaced existing failures when their page closed.
  // Restore only a known pre-fill old-draft block from its own diagnostic log.
  const repair=d.transaction(['tasks','logs'],'readwrite');const logs=await repair.objectStore('logs').getAll();
  for(const t of await repair.objectStore('tasks').getAll())if(t.status==='failed'&&['TAB_CLOSED','VERIFY_REQUIRED'].includes(t.error?.code||'')&&!t.publicationAttemptedAt&&!t.proof?.uploadedMediaIds?.length){
    const cause=logs.filter(l=>l.taskId===t.id&&l.time>=t.createdAt&&l.time<=t.updatedAt).sort((a,b)=>b.time-a.time)[0];
    if(cause?.level==='error'&&cause.event==='EDITOR_OCCUPIED')await repair.objectStore('tasks').put({...t,progress:'旧草稿受保护，本次未填写或发布',error:{code:cause.event,message:cause.message,retrySafe:true}});
  }
  await repair.done;
  const backupOwners=new Set((await d.getAll('backups')).map(b=>b.taskId));
  for(const t of await d.getAll('tasks'))if(t.status==='unknown'&&t.error?.code==='BACKUP_PENDING'&&!t.publicationAttemptedAt&&!t.proof&&!backupOwners.has(t.id))await d.put('tasks',{...t,status:'failed',autoRun:false,progress:'原稿保护前置检查未通过，尚未填写或发布',error:{...t.error,retrySafe:true}});
  const tx = d.transaction('tasks', 'readwrite');
  for (const task of await tx.store.getAll()) {
    const status = task.status==='preparing'&&(task.snapshot.type==='video'||!!task.proof?.uploadedMediaIds?.length)?'unknown':recoveryStatus(task.status);
    if (status !== task.status) await tx.store.put({ ...task, ...(task.editorRecovery&&task.editorRecovery.phase!=='verified'?{editorRecovery:{...task.editorRecovery,phase:'interrupted' as const}}:{}), status, updatedAt: Date.now(), progress: status === 'unknown' ? '平台操作被中断，请先核对已有内容' : '填写过程被中断，可安全重试', error: { code: 'INTERRUPTED', message: '扩展后台已重启', retrySafe: status === 'failed' } });
  }
  await tx.done;
  // A worker restart is not evidence of a failed restore. Preserve the recorded stage.
  for(const backup of await d.getAll('backups'))if(backup.state==='replacing'){const owner=await d.get('tasks',backup.taskId);if(owner&&!owner.publicationAttemptedAt&&!['preparing','queued','ready_for_confirmation'].includes(owner.status))await d.put('backups',{...backup,state:'restore_pending',updatedAt:Date.now(),note:'旧稿替换曾中断，请核对平台原稿；发布状态单独显示。'});}
  workspaceChanged();
}
export async function log(event: string, message: string, taskId?: string, level: Diagnostic['level'] = 'info') {
  const d = await db(); const tx = d.transaction('logs', 'readwrite');
  await tx.store.put({ id: crypto.randomUUID(), time: Date.now(), event, message, taskId, level });
  const logs = await tx.store.getAll(); if (logs.length > 500) for (const old of logs.sort((a,b) => a.time-b.time).slice(0, logs.length-500)) await tx.store.delete(old.id);
  await tx.done;
}

export const HISTORY_LIMIT=50;
export function protectedTask(task:PublishTask,backups:DraftBackup[]=[]){return !['draft_saved','published','failed'].includes(task.status)||!!task.proof?.uploadedMediaIds?.length&&!['draft_saved','published'].includes(task.status)||!!task.editorRecovery&&task.editorRecovery.phase!=='verified'||backups.some(b=>b.taskId===task.id&&b.state!=='restored');}
export function taskSummary(task:PublishTask):TaskSummary{
 const {snapshot,proof,publicationGuard:_guard,...rest}=task;
 return {...rest,snapshot:{id:snapshot.id,type:snapshot.type,title:snapshot.title,...(snapshot.textAsImages?{textAsImages:true}:{})},...(proof?{proof:{bodyDigest:proof.bodyDigest,uploadedMediaIds:proof.uploadedMediaIds}}:{})};
}
/** Only settled details are bounded. Uncertainty, live composers and backups remain actionable. */
export async function pruneHistory(){
 const d=await db();const tx=d.transaction(['tasks','drafts','media','logs','backups','receipts'],'readwrite');
 const tasks=await tx.objectStore('tasks').getAll(),backups=await tx.objectStore('backups').getAll();
 const protectedIds=new Set(tasks.filter(t=>protectedTask(t,backups)).map(t=>t.id));
 const protectedBatches=new Set(tasks.filter(t=>protectedIds.has(t.id)).map(t=>t.batchId));for(const t of tasks)if(protectedBatches.has(t.batchId))protectedIds.add(t.id);
 // A live child still needs its parent's proof and linkage.
 for(const t of tasks)if(protectedIds.has(t.id)){if(t.parentTaskId)protectedIds.add(t.parentTaskId);if(t.supersedesTaskId)protectedIds.add(t.supersedesTaskId);}
 const settled=tasks.filter(t=>!protectedIds.has(t.id)).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
 const remove=settled.slice(HISTORY_LIMIT);const ids=new Set(remove.map(t=>t.id));
 for(const t of remove){
   if(t.publicationAttemptedAt||['published','draft_saved'].includes(t.status)){const fingerprint=contentFingerprint(t.snapshot,t.platform,t.targetId);const prior=await tx.objectStore('receipts').get(fingerprint);if(!prior||prior.operation!=='publish'&&t.operation==='publish')await tx.objectStore('receipts').put({fingerprint,taskId:t.id,operation:t.operation||'save_draft',status:t.status,createdAt:t.createdAt,url:t.publicationResult?.url||t.evidence?.url});}
   await tx.objectStore('tasks').delete(t.id);
 }
 for(const entry of await tx.objectStore('logs').getAll())if(entry.taskId&&ids.has(entry.taskId))await tx.objectStore('logs').delete(entry.id);
 for(const backup of backups)if(backup.state==='restored'&&ids.has(backup.taskId))await tx.objectStore('backups').delete(backup.id);
 const referenced=new Set([...(await tx.objectStore('drafts').getAll()).flatMap(d=>d.media.map(m=>m.id)),...tasks.filter(t=>!ids.has(t.id)).flatMap(t=>t.snapshot.media.map(m=>m.id))]);
 for(const id of new Set(remove.flatMap(t=>t.snapshot.media.map(m=>m.id))))if(!referenced.has(id))await tx.objectStore('media').delete(id);
 await tx.done;if(remove.length)workspaceChanged();return {limit:HISTORY_LIMIT,retained:Math.min(settled.length,HISTORY_LIMIT),protected:protectedIds.size};
}
