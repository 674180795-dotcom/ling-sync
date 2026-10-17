import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {db,saveDraft,enqueue,updateTask} from '../src/core/repository';
import {newDraft,type DraftBackup} from '../src/core/model';
import {backupBeforeFill,nativeZsxqBackup,restoreZsxqBackup} from '../src/platforms/zsxq-backup';
const show=()=>{for(const e of document.querySelectorAll('*'))e.getClientRects=()=>({length:1}) as DOMRectList;};
const account='https://images.zsxq.com/account';
beforeEach(async()=>{vi.stubGlobal('crypto',webcrypto);const d=await db();for(const name of d.objectStoreNames)await d.clear(name);document.body.innerHTML=`<div class="user-container"><img src="${account}?token=not-recorded"></div><div class="create-topic-panel"><div class="content-container"><img class="avatar" src="${account}"><div class="ql-editor" contenteditable="true"><p>旧稿</p><p><br></p><p>原文</p></div></div><div class="close-icon"></div></div>`;show();vi.stubGlobal('location',{origin:'https://wx.zsxq.com',pathname:'/group/12345'});});
afterEach(()=>vi.unstubAllGlobals());
it('纯文本检查保留段落，账号标识不含签名；目标、账号、复杂格式变化拒绝',async()=>{
 const read=await nativeZsxqBackup('inspect',{targetId:'12345'});expect(read).toMatchObject({plain:true,text:'旧稿\n\n原文',accountKey:account});
 await expect(nativeZsxqBackup('replace',{targetId:'99999',text:read.text})).rejects.toThrow('星球变化');await expect(nativeZsxqBackup('replace',{targetId:'12345',accountKey:'other',text:read.text})).rejects.toThrow('账号已变化');
 document.querySelector('.ql-editor')!.innerHTML='<p><strong>格式</strong></p>';show();expect((await nativeZsxqBackup('inspect',{targetId:'12345'})).plain).toBe(false);await expect(nativeZsxqBackup('replace',{targetId:'12345',text:'格式'})).rejects.toThrow('复杂格式');
});
it('持久备份和replacing状态必须先于原稿替换，失败仍保留全文',async()=>{
 const draft=await saveDraft({...newDraft('post'),title:'新动态',markdown:'新文'},0);const t=await enqueue(draft,'zsxq','12345','batch',false,'publish');const task=await updateTask(t.id,['queued'],{status:'preparing',tabId:7});
 const execute=vi.fn(async({args}:any)=>{if(args[0]==='inspect')return [{result:{text:'旧稿\n原文',plain:true,accountKey:account,mediaCount:0,editorFound:true}}];const saved=(await(await db()).getAll('backups'))[0]!;expect(saved).toMatchObject({taskId:t.id,text:'旧稿\n原文',state:'replacing'});throw new Error('页面中断');});
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});await expect(backupBeforeFill(task,7)).rejects.toThrow('页面中断');const backup=(await(await db()).getAll('backups'))[0]!;expect(backup.state).toBe('restore_pending');expect(backup.text).toBe('旧稿\n原文');
 execute.mockResolvedValueOnce([{result:{text:'其他内容',plain:true,accountKey:account,mediaCount:0,editorFound:true}}] as any);await expect(backupBeforeFill(task,7)).rejects.toThrow('待核对');expect(execute).toHaveBeenCalledTimes(4);
});
it('恢复未知发布结果时不操作页面、不重发；校验损坏备份时停止',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'同步文'},0);const t=await enqueue(draft,'zsxq','12345','batch',false,'publish');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('原稿')))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const b:DraftBackup={id:'backup',taskId:t.id,targetId:t.targetId,tabId:7,url:'https://wx.zsxq.com/group/12345',accountKey:account,text:'原稿',digest,createdAt:1,updatedAt:1,state:'restore_pending'};const execute=vi.fn();vi.stubGlobal('chrome',{scripting:{executeScript:execute}});
 await expect(restoreZsxqBackup({...t,status:'unknown',publicationAttemptedAt:2},b)).rejects.toThrow('尚未确认');await expect(restoreZsxqBackup({...t,status:'published'},{...b,text:'损坏'})).rejects.toThrow('校验不一致');expect(execute).not.toHaveBeenCalled();
});
it('已确认发布后恢复仅写空编辑器并关闭重开核对，不调用发布',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'同步文'},0);const t=await enqueue(draft,'zsxq','12345','batch',false,'publish');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('原稿')))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const b:DraftBackup={id:'backup',taskId:t.id,targetId:t.targetId,tabId:7,url:'https://wx.zsxq.com/group/12345',accountKey:account,text:'原稿',digest,createdAt:1,updatedAt:1,state:'restore_pending'};await(await db()).put('backups',b);let text='';const actions:string[]=[];
 vi.stubGlobal('chrome',{tabs:{get:async()=>({url:'https://wx.zsxq.com/group/12345'})},permissions:{contains:async()=>true},scripting:{executeScript:async({args}:any)=>{actions.push(args[0]);if(args[0]==='restore')text=args[1].replacement;return [{result:{text,plain:true,accountKey:account,mediaCount:0,editorFound:args[0]!=='closed'}}];}}});
 await restoreZsxqBackup({...t,status:'published'},b);expect(actions.slice(0,6)).toEqual(['open','inspect','inspect','restore','close','closed']);expect(actions.filter(a=>a==='open')).toHaveLength(5);expect((await(await db()).get('backups','backup'))?.state).toBe('restored');
 text='用户的新内容';await expect(restoreZsxqBackup({...t,status:'published'},b)).rejects.toThrow('其他内容');expect(text).toBe('用户的新内容');
});
it('后台重启保留已提交任务与已记录备份阶段，不制造新的恢复失败',async()=>{
 const {recoverInterruptedTasks}=await import('../src/core/repository');const draft=await saveDraft({...newDraft('post'),markdown:'已发送'},0);const t=await enqueue(draft,'zsxq','12345','restart',false,'publish');await(await db()).put('tasks',{...t,status:'submitted',publicationAttemptedAt:2});const b:DraftBackup={id:'restart-backup',taskId:t.id,targetId:t.targetId,tabId:7,url:'https://wx.zsxq.com/group/12345',accountKey:account,text:'旧稿',digest:'proof',createdAt:1,updatedAt:1,state:'replacing'};await(await db()).put('backups',b);await recoverInterruptedTasks();expect(await(await db()).get('backups',b.id)).toEqual(b);expect((await(await db()).get('tasks',t.id))?.status).toBe('submitted');
});
it('平台空白时历史备份不阻止新稿，也不宣称旧稿已恢复',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'新内容'},0);const t=await enqueue(draft,'zsxq','12345','empty',false,'publish');const b:DraftBackup={id:'old-pending',taskId:'old-unknown',targetId:'12345',tabId:8,url:'https://wx.zsxq.com/group/12345',accountKey:account,text:'旧稿',digest:'old-digest',createdAt:1,updatedAt:1,state:'restore_pending'};await(await db()).put('backups',b);const execute=vi.fn(async()=>[{result:{text:'',plain:true,accountKey:account,mediaCount:0,editorFound:true}}]);vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});await backupBeforeFill(t,7);expect(execute).toHaveBeenCalledTimes(1);expect(await(await db()).get('backups',b.id)).toEqual(b);
});
const sha=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const historicalBackup=async(id:string,text:string,state:DraftBackup['state']='restore_pending'):Promise<DraftBackup>=>({id,taskId:'old-'+id,targetId:'12345',tabId:8,url:'https://wx.zsxq.com/group/12345',accountKey:account,text,digest:await sha(text),createdAt:1,updatedAt:1,state});
const publishTask=async()=>enqueue(await saveDraft({...newDraft('post'),markdown:'本次新内容'},0),'zsxq','12345','isolated',false,'publish');
const readResult=(text:string,patch:Record<string,unknown>={})=>({text,plain:true,accountKey:account,mediaCount:0,editorFound:true,...patch});
it('多个未决备份按账号全文和摘要找匹配，首条不相关记录保持不变',async()=>{
 const task=await publishTask(),d=await db();const unrelated=await historicalBackup('a-first','更早的旧稿'),matching=await historicalBackup('z-match','当前原稿');await d.put('backups',unrelated);await d.put('backups',matching);
 const execute=vi.fn(async({args}:any)=>[{result:readResult(args[0]==='replace'?'':'当前原稿')}]);vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});
 await backupBeforeFill(task,7);expect(execute.mock.calls.map(([call])=>call.args[0])).toEqual(['inspect','inspect','replace']);expect(await d.get('backups',unrelated.id)).toEqual(unrelated);expect((await d.get('backups',matching.id))?.state).toBe('restored');
 const current=(await d.getAll('backups')).filter(b=>b.taskId===task.id);expect(current).toHaveLength(1);expect(current[0]).toMatchObject({text:'当前原稿',digest:matching.digest,state:'replacing'});
});
it('稳定回读已恢复原文后建立独立备份，不修改不相关未决记录或旧任务',async()=>{
 const task=await publishTask(),d=await db();const pending=await historicalBackup('pending','另一份未决原文'),restored=await historicalBackup('restored','已恢复原文','restored');await d.put('backups',pending);await d.put('backups',restored);const originalTask=await d.get('tasks',task.id);
 const execute=vi.fn(async({args}:any)=>{if(args[0]==='replace'){const captured=(await d.getAll('backups')).find(b=>b.taskId===task.id);expect(captured).toMatchObject({text:restored.text,state:'replacing'});return [{result:readResult('')}];}return [{result:readResult(restored.text)}];});vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});
 await backupBeforeFill(task,7);expect(await d.get('backups',pending.id)).toEqual(pending);expect(await d.get('backups',restored.id)).toEqual(restored);expect(await d.get('tasks',task.id)).toEqual(originalTask);expect((await d.getAll('backups')).filter(b=>b.taskId===task.id)).toHaveLength(1);
});
it.each(['unknown','damaged','media','complex','account','target'] as const)('未决备份隔离拒绝无完整归属的原稿：%s',async(kind)=>{
 const task=await publishTask(),d=await db();const pending=await historicalBackup('pending','未决原稿'),known=await historicalBackup('known','已恢复原文','restored');const stored={...known,...(kind==='damaged'?{digest:'damaged'}:{}),...(kind==='target'?{targetId:'99999'}:{})};await d.put('backups',pending);await d.put('backups',stored);
 const observed=readResult(kind==='unknown'?'未知的原文':known.text,{...(kind==='media'?{mediaCount:1}:{}),...(kind==='complex'?{plain:false}:{}),...(kind==='account'?{accountKey:'https://images.zsxq.com/other-account'}:{})});const execute=vi.fn(async()=>[{result:observed}]);vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});
 await expect(backupBeforeFill(task,7)).rejects.toMatchObject({code:'BACKUP_PENDING'});expect(execute).toHaveBeenCalledTimes(1);expect(await d.get('backups',pending.id)).toEqual(pending);expect(await d.get('backups',stored.id)).toEqual(stored);expect((await d.getAll('backups')).filter(b=>b.taskId===task.id)).toHaveLength(0);
});
it.each(['text','account','media','complex'] as const)('备份前第二次回读变化停止，不写新备份或更改旧状态：%s',async(kind)=>{
 const task=await publishTask(),d=await db();const pending=await historicalBackup('pending','未决原稿'),known=await historicalBackup('known','已恢复原文','restored');await d.put('backups',pending);await d.put('backups',known);
 const execute=vi.fn().mockResolvedValueOnce([{result:readResult(known.text)}]).mockResolvedValueOnce([{result:readResult(kind==='text'?'延迟恢复的其他草稿':known.text,{...(kind==='account'?{accountKey:'changed'}:{}),...(kind==='media'?{mediaCount:1}:{}),...(kind==='complex'?{plain:false}:{})})}]);vi.stubGlobal('chrome',{permissions:{contains:async()=>true},scripting:{executeScript:execute}});
 await expect(backupBeforeFill(task,7)).rejects.toMatchObject({code:'BACKUP_PENDING',retrySafe:false});expect(execute).toHaveBeenCalledTimes(2);expect(await d.get('backups',pending.id)).toEqual(pending);expect(await d.get('backups',known.id)).toEqual(known);expect((await d.getAll('backups')).filter(b=>b.taskId===task.id)).toHaveLength(0);
});
