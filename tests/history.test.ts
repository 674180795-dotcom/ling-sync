import {beforeEach,it,expect,vi} from 'vitest';
import {db,saveDraft,enqueue,updateTask,pruneHistory,taskSummary,recoverInterruptedTasks} from '../src/core/repository';
import {newDraft,type PublishTask,type DraftBackup} from '../src/core/model';
beforeEach(async()=>{const d=await db();for(const name of d.objectStoreNames)await d.clear(name);});
async function seed(count:number,status:PublishTask['status']='published'){
 const draft=await saveDraft({...newDraft('post'),title:'历史',markdown:'大段原文'},0);const d=await db();const tasks:Array<PublishTask&{fingerprint:string}>=[];
 for(let i=0;i<count;i++){const t=await enqueue({...draft,revision:draft.revision},'zsxq',String(10000+i),'b'+i,false,'publish');const value={...t,status,createdAt:i,updatedAt:i,publicationAttemptedAt:status==='published'?i+1:undefined};await d.put('tasks',value);tasks.push(value);}
 return {draft,tasks};
}
it('第51条历史删除完整快照及日志，留下最小去重记录，不删除原稿',async()=>{
 const {draft,tasks}=await seed(51);const d=await db();await d.put('logs',{id:'old-log',taskId:tasks[0]!.id,time:0,level:'info',event:'done',message:'历史'});
 expect(await pruneHistory()).toEqual({limit:50,retained:50,protected:0});expect(await d.getAll('tasks')).toHaveLength(50);expect(await d.get('logs','old-log')).toBeUndefined();expect(await d.get('drafts',draft.id)).toEqual(draft);expect(await d.getAll('receipts')).toHaveLength(1);
 await expect(enqueue(draft,'zsxq','10000','new',true,'publish')).rejects.toThrow('不会再次提交');
});
it('unknown、submitted、filled与待恢复备份另行保留，启动恢复不丢备份',async()=>{
 const {tasks}=await seed(55,'failed');const d=await db();for(const [index,status] of ['unknown','submitted','filled'].entries())await d.put('tasks',{...tasks[index]!,status:status as PublishTask['status']});
 const backup:DraftBackup={id:'backup',taskId:tasks[3]!.id,targetId:tasks[3]!.targetId,tabId:7,url:'https://wx.zsxq.com/group/10003',accountKey:'avatar',text:'旧稿',digest:'digest',createdAt:1,updatedAt:1,state:'replacing'};await d.put('backups',backup);
 await recoverInterruptedTasks();expect((await d.get('backups','backup'))?.state).toBe('restore_pending');expect(await pruneHistory()).toMatchObject({retained:50,protected:4});for(const t of tasks.slice(0,4))expect(await d.get('tasks',t.id)).toBeDefined();
});
it('仅回收被清理记录的无引用附件，不误删编辑中刚加入的媒体',async()=>{
 const {draft,tasks}=await seed(51);const d=await db();const media=(name:string)=>({id:crypto.randomUUID(),name,kind:'image' as const,mime:'image/png' as const,bytes:1,draftId:draft.id,blob:new Blob(['a'])});
 const orphan=media('old'),shared=media('shared'),editing=media('editing');for(const m of [orphan,shared,editing])await d.put('media',m);
 await d.put('tasks',{...tasks[0]!,snapshot:{...draft,media:[orphan,shared]}});await d.put('drafts',{...draft,media:[shared]});await pruneHistory();
 expect(await d.get('media',orphan.id)).toBeUndefined();expect(await d.get('media',shared.id)).toBeDefined();expect(await d.get('media',editing.id)).toBeDefined();
});
it('工作台任务摘要不含正文、标签、附件清单或媒体哈希',async()=>{
 const {tasks}=await seed(1);const summary=taskSummary({...tasks[0]!,publicationGuard:'guard',proof:{bodyDigest:'digest',mediaHashes:['large'],uploadedMediaIds:['one']}});
 expect(summary.snapshot).toEqual({id:tasks[0]!.snapshot.id,type:'post',title:'历史'});expect(summary).not.toHaveProperty('publicationGuard');expect(summary.proof).not.toHaveProperty('mediaHashes');expect(JSON.stringify(summary)).not.toContain('大段原文');
});
it('批次中有unknown时保留同批次失败记录；已交付媒体的失败任务保留证明',async()=>{
 const {tasks}=await seed(53,'failed');const d=await db();await d.put('tasks',{...tasks[0]!,status:'unknown'});await d.put('tasks',{...tasks[1]!,batchId:tasks[0]!.batchId});await d.put('tasks',{...tasks[2]!,proof:{bodyDigest:'body',mediaHashes:['image'],uploadedMediaIds:['one']}});await pruneHistory();for(const t of tasks.slice(0,3))expect(await d.get('tasks',t.id)).toBeDefined();expect((await d.get('tasks',tasks[2]!.id))?.proof?.uploadedMediaIds).toEqual(['one']);
});
