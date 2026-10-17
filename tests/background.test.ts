import { beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import {db,saveDraft,enqueue,updateTask} from '../src/core/repository';
import {newDraft} from '../src/core/model';
import {SyncError} from '../src/core/protocol';

const adapter=vi.hoisted(()=>({detectSession:vi.fn(),validate:vi.fn(),openEditor:vi.fn(),fillEditor:vi.fn(),saveDraft:vi.fn(),verifyDraft:vi.fn(),recoverEditor:vi.fn()}));
const permission=vi.hoisted(()=>vi.fn());
vi.mock('../src/platforms/adapters',()=>({adapters:Object.fromEntries(['weixin','zsxq','jike','douyin','kuaishou','channels','bilibili','x','xiaohongshu'].map(id=>[id,adapter])),hasPermission:permission}));
const publication=vi.hoisted(()=>({probe:vi.fn(),submit:vi.fn(),receipt:vi.fn()}));
vi.mock('../src/platforms/publication',async(importOriginal)=>({...await importOriginal<typeof import('../src/platforms/publication')>(),publicationProbe:publication.probe,submitPublication:publication.submit,readPublicationReceipt:publication.receipt}));
vi.mock('../src/platforms/publication-result',async()=>{const {SyncError}=await import('../src/core/protocol');return {verifyPublication:vi.fn(async()=>{throw new SyncError('PUBLISH_RESULT_PENDING','本状态测试不连接真实平台',false);})};});
let listener:(packet:unknown,sender:unknown,reply:(result:any)=>void)=>boolean;
let tabRemoved:(id:number)=>void;
let alarmWake:(alarm:{name:string})=>void;
const event=()=>({addListener:vi.fn()});
let localStore:Record<string,unknown>={};
beforeAll(async()=>{
  vi.stubGlobal('defineBackground',(start:()=>void)=>{start();return {};});
  vi.stubGlobal('chrome',{
    runtime:{id:'test-extension',getURL:(p:string)=>'chrome-extension://test-extension/'+p,onMessage:{addListener:(fn:typeof listener)=>listener=fn},onInstalled:event(),onStartup:event()},
    storage:{local:{get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,localStore[key]])),set:vi.fn(async(values:Record<string,unknown>)=>{Object.assign(localStore,values);})}},
    tabs:{onRemoved:{addListener:(fn:typeof tabRemoved)=>tabRemoved=fn},create:vi.fn(),update:vi.fn()},permissions:{onRemoved:event()},alarms:{onAlarm:{addListener:(fn:typeof alarmWake)=>alarmWake=fn},create:vi.fn()},sidePanel:{setPanelBehavior:vi.fn()},
  });
  await import('../src/entrypoints/background');
});
beforeEach(async()=>{
  const database=await db();for(const store of ['drafts','tasks','media','accounts','logs','settings'] as const)await database.clear(store);
  localStore={settings:{zsxqGroupId:'12345678901234',showPreview:true}};
  vi.clearAllMocks();publication.receipt.mockResolvedValue(undefined);permission.mockResolvedValue(true);adapter.validate.mockImplementation(()=>{});
  adapter.openEditor.mockResolvedValue(123);
  adapter.fillEditor.mockResolvedValue({bodyDigest:'a'.repeat(64),mediaHashes:[]});
  adapter.saveDraft.mockResolvedValue({notice:'已保存'});
  publication.probe.mockResolvedValue('b'.repeat(64));publication.submit.mockResolvedValue({kind:'publication_receipt',notice:'发布成功',bodyMatched:true,mediaCount:0,checkedAt:Date.now(),title:'测试',url:'https://wx.zsxq.com/'});
  adapter.verifyDraft.mockResolvedValue({kind:'editor_reload',checkedAt:Date.now(),title:'异常测试',bodyMatched:true,mediaCount:0,url:'https://wx.zsxq.com/article?groupId=12345678901234'});
});
const request=(action:string,payload:unknown)=>new Promise<any>(resolve=>listener({channel:'ling-sync',version:1,action,payload},{id:'test-extension',url:'chrome-extension://test-extension/workbench.html'},resolve));
it.each(['bilibili','x'] as const)('%s错误页仅在无上传无提交时建立新关联任务，原失败保留且不得再次重试',async(platform)=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'页面恢复样本'},0),t=await enqueue(draft,platform,'','error-page',false,'fill');
 await updateTask(t.id,['queued'],{status:'failed',tabId:777,error:{code:'PAGE_LOAD_FAILED',message:'浏览器错误页',retrySafe:true}});
 const r=await request('RETRY',{id:t.id});expect(r.ok).toBe(true);expect(r.value.id).not.toBe(t.id);expect(r.value.supersedesTaskId).toBe(t.id);expect(r.value.tabId).toBeUndefined();
 const old=await(await db()).get('tasks',t.id);expect(old).toMatchObject({status:'failed',supersededByTaskId:r.value.id,error:{code:'PAGE_LOAD_FAILED'}});expect((await request('RETRY',{id:t.id})).ok).toBe(false);
 await vi.waitFor(async()=>expect((await(await db()).get('tasks',r.value.id))?.status).toBe('filled'));expect(publication.submit).not.toHaveBeenCalled();
});
it.each(['upload','submit'])('错误页 retrySafe 标记不能覆盖已有 %s 证据',async(kind)=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'保留原页'},0),t=await enqueue(draft,'bilibili','','error-page',false,'fill');
 await updateTask(t.id,['queued'],{status:'failed',error:{code:'PAGE_LOAD_FAILED',message:'浏览器错误页',retrySafe:true},...(kind==='upload'?{proof:{bodyDigest:'',mediaHashes:[],uploadedMediaIds:[crypto.randomUUID()]}}:{publicationAttemptedAt:Date.now()})});
 expect((await request('RETRY',{id:t.id})).ok).toBe(false);expect(adapter.openEditor).not.toHaveBeenCalled();expect((await(await db()).getAll('tasks'))).toHaveLength(1);
});
it('未提交发布任务恢复仅补填，不自动发布；再次显式继续才可提交一次',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'补填'},0);const t=await enqueue(draft,'xiaohongshu','','recover-publish',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'unknown',tabId:123,error:{code:'READBACK_FAILED',message:'标题未就绪',retrySafe:false},proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]}});
 adapter.recoverEditor.mockResolvedValueOnce({proof:{bodyDigest:'b'.repeat(64),mediaHashes:[],uploadedMediaIds:[]},evidence:{kind:'editor_readback',checkedAt:Date.now(),url:'https://creator.xiaohongshu.com/',bodyMatched:true}});
 const response=await request('RECOVER_FILL',{id:t.id});expect(response.value).toMatchObject({status:'ready_for_confirmation',autoRun:false});expect(response.value.publicationAttemptedAt).toBeUndefined();expect(publication.submit).not.toHaveBeenCalled();expect((await request('RECOVER_FILL',{id:t.id})).ok).toBe(false);
 const resumed=await request('RESUME_PUBLICATION',{id:t.id});expect(resumed.value.status).toBe('submitted');expect(publication.submit).toHaveBeenCalledTimes(1);expect((await request('RESUME_PUBLICATION',{id:t.id})).ok).toBe(false);
});
async function pending() {
  const draft=await saveDraft({...newDraft(),title:'异常测试',markdown:'正文'},0);
  return enqueue(draft,'zsxq','12345678901234','batch');
}
describe('后台异常边界（平台适配器为Mock）',()=>{
  it('权限缺失时不创建任务、不操作平台',async()=>{
    const draft=await saveDraft({...newDraft(),title:'异常测试',markdown:'正文'},0);permission.mockResolvedValue(false);
    const response=await request('ENQUEUE',{draftId:draft.id,platforms:['zsxq']});
    expect(response.error.code).toBe('PERMISSION_REQUIRED');expect(await(await db()).getAll('tasks')).toHaveLength(0);expect(adapter.openEditor).not.toHaveBeenCalled();
  });
  it.each(['LOGIN_REQUIRED','MEDIA_UPLOAD_FAILED'])('%s 在提交前保留明确失败与任务标签',async(code)=>{
    const task=await pending();adapter.fillEditor.mockRejectedValue(new SyncError(code,'平台填写未完成'));
    const response=await request('PREPARE',{id:task.id});
    expect(response.value.status).toBe('failed');expect(response.value.tabId).toBe(123);expect(response.value.error.retrySafe).toBe(true);expect(adapter.saveDraft).not.toHaveBeenCalled();
  });
  it('保存后回执丢失保持unknown，重复确认和重试均不提交',async()=>{
    const task=await pending();await request('PREPARE',{id:task.id});
    adapter.saveDraft.mockRejectedValue(new SyncError('RECEIPT_LOST','已触发保存但回执丢失',false));
    const response=await request('CONFIRM_SAVE',{id:task.id});
    expect(response.value.status).toBe('unknown');expect(response.value.error.retrySafe).toBe(false);
    expect((await request('RETRY',{id:task.id})).ok).toBe(false);
    expect((await request('CONFIRM_SAVE',{id:task.id})).ok).toBe(false);
    expect(adapter.saveDraft).toHaveBeenCalledTimes(1);
    const checked=await request('VERIFY',{id:task.id});expect(checked.value.status).toBe('draft_saved');expect(adapter.saveDraft).toHaveBeenCalledTimes(1);
  });
  it('页面变化后保存检查失败保留unknown，不执行核对或重试',async()=>{
    const task=await pending();await request('PREPARE',{id:task.id});
    adapter.saveDraft.mockRejectedValue(new SyncError('PAGE_CHANGED','任务页已离开目标星球',false));
    const response=await request('CONFIRM_SAVE',{id:task.id});
    expect(response.value.status).toBe('unknown');expect(adapter.verifyDraft).not.toHaveBeenCalled();expect((await request('RETRY',{id:task.id})).ok).toBe(false);
  });
});

describe('一键自动队列（内部Mock，不能作为平台支持证据）',()=>{
  const finished=async(count:number)=>vi.waitFor(async()=>{const all=await(await db()).getAll('tasks');expect(all).toHaveLength(count);expect(all.every(t=>['draft_saved','filled','failed','unknown'].includes(t.status))).toBe(true);},{timeout:2000});
  it('一次开始自动逐站填写、存稿与核对，重复点击不增加任务',async()=>{
    const draft=await saveDraft({...newDraft(),title:'一键',markdown:'正文'},0);
    const payload={draftId:draft.id,platforms:['weixin','zsxq']};
    await Promise.all([request('START_SYNC',payload),request('START_SYNC',payload)]);await finished(2);
    expect(adapter.fillEditor).toHaveBeenCalledTimes(2);expect(adapter.saveDraft).toHaveBeenCalledTimes(2);expect(adapter.verifyDraft).toHaveBeenCalledTimes(2);
    expect(adapter.fillEditor.mock.invocationCallOrder[1]).toBeGreaterThan(adapter.verifyDraft.mock.invocationCallOrder[0]!);
  });
  it('旧queued保持静止，只在继续同步后执行',async()=>{
    const old=await pending();await new Promise(r=>setTimeout(r,30));expect(adapter.openEditor).not.toHaveBeenCalled();
    await request('CONTINUE_QUEUE',{});await finished(1);expect((await(await db()).get('tasks',old.id))?.status).toBe('draft_saved');
  });
  it('一个平台登录失败仍继续后面的平台',async()=>{
    adapter.fillEditor.mockRejectedValueOnce(new SyncError('LOGIN_REQUIRED','登录失效'));
    const draft=await saveDraft({...newDraft(),title:'顺序',markdown:'正文'},0);await request('START_SYNC',{draftId:draft.id,platforms:['weixin','zsxq']});await finished(2);
    const all=await(await db()).getAll('tasks');expect(all.map(t=>t.status).sort()).toEqual(['draft_saved','failed']);expect(adapter.saveDraft).toHaveBeenCalledTimes(1);
  });
  it('无草稿平台只填写，绝不触发保存',async()=>{
    const draft=await saveDraft({...newDraft('post'),markdown:'动态'},0);await request('START_SYNC',{draftId:draft.id,platforms:['jike']});await finished(1);
    expect((await(await db()).getAll('tasks'))[0]?.status).toBe('filled');expect(adapter.saveDraft).not.toHaveBeenCalled();expect(adapter.verifyDraft).not.toHaveBeenCalled();
  });
  it('自动保存回执丢失后unknown阻止重试，同批其他站继续',async()=>{
    adapter.saveDraft.mockRejectedValueOnce(new SyncError('RECEIPT_LOST','无回执',false));
    const draft=await saveDraft({...newDraft(),title:'回执',markdown:'正文'},0);await request('START_SYNC',{draftId:draft.id,platforms:['weixin','zsxq']});await finished(2);
    const unknown=(await(await db()).getAll('tasks')).find(t=>t.status==='unknown')!;expect(unknown).toBeDefined();await request('RETRY',{id:unknown.id});await request('START_SYNC',{draftId:draft.id,platforms:['weixin','zsxq']});expect(adapter.saveDraft).toHaveBeenCalledTimes(2);
  });
});

describe('窗口关闭与alarm恢复',()=>{
  it('关闭保存标签时保持unknown，后到回执不得覆盖或重发',async()=>{
    let complete:(v:unknown)=>void=()=>{};adapter.saveDraft.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const draft=await saveDraft({...newDraft(),title:'关闭测试',markdown:'正文'},0);const started=await request('START_SYNC',{draftId:draft.id,platforms:['zsxq']});const id=started.value[0].id;
    await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('saving_draft'));
    tabRemoved(123);await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('unknown'));complete({notice:'晚到保存回执'});
    await new Promise(r=>setTimeout(r,25));expect((await(await db()).get('tasks',id))?.status).toBe('unknown');expect(adapter.verifyDraft).not.toHaveBeenCalled();expect(adapter.saveDraft).toHaveBeenCalledTimes(1);
  });
  it('alarm会消费新自动任务，仍不触碰旧任务',async()=>{
    const draft=await saveDraft({...newDraft(),title:'唤醒',markdown:'正文'},0);const old=await enqueue(draft,'weixin','','old',false);const automatic=await enqueue(draft,'zsxq','12345678901234','new',true);
    alarmWake({name:'reconcile'});await vi.waitFor(async()=>expect((await(await db()).get('tasks',automatic.id))?.status).toBe('draft_saved'));expect((await(await db()).get('tasks',old.id))?.status).toBe('queued');
  });
});
describe('手动核对与新队列互斥',()=>{
  it('核对运行期间新任务保持queued，核对完成才原子领取',async()=>{
    const old=await pending();await request('PREPARE',{id:old.id});adapter.saveDraft.mockRejectedValueOnce(new SyncError('LOST','回执丢失',false));await request('CONFIRM_SAVE',{id:old.id});
    let finish:(v:any)=>void=()=>{};adapter.verifyDraft.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const verifying=request('VERIFY',{id:old.id});await vi.waitFor(()=>expect(adapter.verifyDraft).toHaveBeenCalledTimes(1));
    const draft=await saveDraft({...newDraft(),title:'新队列',markdown:'正文'},0);const started=await request('START_SYNC',{draftId:draft.id,platforms:['weixin']});const id=started.value[0].id;
    expect((await(await db()).get('tasks',id))?.status).toBe('queued');finish({kind:'editor_reload',checkedAt:Date.now(),title:'旧稿',bodyMatched:true,mediaCount:0,url:'https://wx.zsxq.com/'});await verifying;
    await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('draft_saved'));
  });
});
describe('图片上传后的标签关闭',()=>{
 it('交给平台图片后关闭标签仍保持unknown，不提供重试',async()=>{
  let finish:(v:any)=>void=()=>{};adapter.fillEditor.mockImplementationOnce(async(task)=>{await updateTask(task.id,['preparing'],{proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[crypto.randomUUID()]}});return new Promise(resolve=>{finish=resolve;});});
  const draft=await saveDraft({...newDraft('post'),markdown:'图片动态'},0);const response=await request('START_SYNC',{draftId:draft.id,platforms:['jike']});const id=response.value[0].id;
  await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.proof?.uploadedMediaIds).toHaveLength(1));tabRemoved(123);await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('unknown'));
  finish({bodyDigest:'a'.repeat(64),mediaHashes:[]});await new Promise(r=>setTimeout(r,20));expect((await request('RETRY',{id})).ok).toBe(false);expect((await(await db()).get('tasks',id))?.status).toBe('unknown');expect(adapter.saveDraft).not.toHaveBeenCalled();
 });
});

describe('直接发布队列（内部Mock，未公开发布）',()=>{
 it('明确选择发布后，先核对、持久化publishing，再调用一次发布；重复开始不重发',async()=>{
  publication.submit.mockImplementation(async(task)=>{expect((await(await db()).get('tasks',task.id))?.status).toBe('publishing');return {kind:'publication_receipt',notice:'发布成功'};});
  const draft=await saveDraft({...newDraft('post'),title:'发布测试',markdown:'正文'},0);const payload={draftId:draft.id,platforms:['zsxq'],publishPlatforms:['zsxq']};
  const response=await request('START_SYNC',payload);const id=response.value[0].id;await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('submitted'));
  await request('START_SYNC',payload);expect(publication.submit).toHaveBeenCalledTimes(1);expect(adapter.saveDraft).not.toHaveBeenCalled();expect(adapter.verifyDraft).toHaveBeenCalledTimes(1);
 });
 it('发布回执丢失进入unknown，同批其他平台继续，核对绝不重新点击或按填写冒认发布',async()=>{
  publication.submit.mockRejectedValueOnce(new Error('回执丢失'));
  const draft=await saveDraft({...newDraft('post'),markdown:'正文'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['zsxq','jike'],publishPlatforms:['zsxq','jike']});
  await vi.waitFor(async()=>expect((await(await db()).getAll('tasks')).map(t=>t.status).sort()).toEqual(['submitted','unknown']));
  const t=(await(await db()).getAll('tasks')).find(t=>t.status==='unknown')!;expect((await request('RETRY',{id:t.id})).ok).toBe(false);expect((await request('VERIFY',{id:t.id})).error.code).toBe('PUBLISH_RESULT_PENDING');expect(publication.submit).toHaveBeenCalledTimes(2);
 });
 it('未实现或不在同步目标里的发布请求，任何任务入队前拒绝',async()=>{
  const draft=await saveDraft({...newDraft('post'),markdown:'正文'},0);
  expect((await request('START_SYNC',{draftId:draft.id,platforms:['zsxq','weixin'],publishPlatforms:['x']})).ok).toBe(false);
  expect(await(await db()).getAll('tasks')).toHaveLength(0);expect(publication.submit).not.toHaveBeenCalled();
 });
 it('发布标签关闭后晚到回执不能把unknown升级为已提交',async()=>{
  let finish:(value:any)=>void=()=>{};publication.submit.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
  const draft=await saveDraft({...newDraft('post'),markdown:'关闭测试'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['zsxq'],publishPlatforms:['zsxq']});const id=r.value[0].id;
  await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('publishing'));tabRemoved(123);await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('unknown'));finish({kind:'publication_receipt',notice:'发布成功'});await new Promise(r=>setTimeout(r,30));expect((await(await db()).get('tasks',id))?.status).toBe('unknown');
 });
});

describe('人工发布核对和只读继续发布',()=>{
 it('人工结果拒绝外站或首页，只把明确内容链接记录为用户核对，不重新发帖',async()=>{
  const draft=await saveDraft({...newDraft('post'),title:'人工确认',markdown:'正文'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['jike'],publishPlatforms:['jike']});const id=r.value[0].id;await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('submitted'));
  expect((await request('CONFIRM_PUBLICATION_RESULT',{id,url:'https://evil.example/post/123456789',visibility:'public'})).ok).toBe(false);
  expect((await request('CONFIRM_PUBLICATION_RESULT',{id,url:'https://web.okjike.com/',visibility:'public'})).ok).toBe(false);
  const checked=await request('CONFIRM_PUBLICATION_RESULT',{id,url:'https://web.okjike.com/u/user/post/012345678901234567890123',visibility:'public'});expect(checked.value.status).toBe('published');expect(checked.value.evidence.verificationSource).toBe('user');expect(publication.submit).toHaveBeenCalledTimes(1);
 });
 it('审核中人工确认不会伪装成已公开或正文媒体核对',async()=>{
  const draft=await saveDraft({...newDraft('post'),title:'审核确认',markdown:'正文'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['jike'],publishPlatforms:['jike']});const id=r.value[0].id;await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('submitted'));
  const checked=await request('CONFIRM_PUBLICATION_RESULT',{id,url:'https://web.okjike.com/following',visibility:'processing'});expect(checked.value.status).toBe('submitted');expect(checked.value.publicationResult.visibility).toBe('processing');expect(checked.value.evidence.bodyMatched).toBeUndefined();expect(publication.submit).toHaveBeenCalledTimes(1);
 });
 it('发布前条件失败可只读恢复并提交一次；任何已尝试发布的任务不能继续点击',async()=>{
  publication.probe.mockRejectedValueOnce(new Error('字段未就绪'));const draft=await saveDraft({...newDraft('post'),title:'继续条件',markdown:'正文'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['jike'],publishPlatforms:['jike']});const id=r.value[0].id;await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('failed'));await new Promise(r=>setTimeout(r,20));
  expect(publication.submit).not.toHaveBeenCalled();const resumed=await request('RESUME_PUBLICATION',{id});expect(resumed.value.status).toBe('submitted');expect(adapter.fillEditor).toHaveBeenCalledTimes(1);expect(publication.submit).toHaveBeenCalledTimes(1);expect(resumed.value.publicationAttemptedAt).toBeDefined();expect((await request('RESUME_PUBLICATION',{id})).ok).toBe(false);
 });
});

describe('不确定上传的字段恢复',()=>{
 it('核对失败保留unknown，禁止通用重试；恢复只调用专用核对接口',async()=>{
  const draft=await saveDraft({...newDraft('post'),markdown:'恢复正文'},0);const t=await enqueue(draft,'jike','','recovery',false,'fill');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'unknown',error:{code:'UPLOAD_UNCONFIRMED',message:'待核对',retrySafe:false}});
  adapter.recoverEditor.mockRejectedValueOnce(new SyncError('MEDIA_IDENTITY_UNCONFIRMED','图片不一致',false));expect((await request('RECOVER_FILL',{id:t.id})).ok).toBe(false);expect((await(await db()).get('tasks',t.id))?.status).toBe('unknown');expect((await request('RETRY',{id:t.id})).ok).toBe(false);
  adapter.recoverEditor.mockResolvedValueOnce({proof:{bodyDigest:'a'.repeat(64),mediaHashes:[]},evidence:{kind:'editor_readback',checkedAt:Date.now(),url:'https://web.okjike.com/',bodyMatched:true}});expect((await request('RECOVER_FILL',{id:t.id})).value.status).toBe('filled');expect(adapter.fillEditor).not.toHaveBeenCalled();expect(adapter.saveDraft).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();expect((await request('RECOVER_FILL',{id:t.id})).ok).toBe(false);
 });
});
it('已填写页后来出现额外附件时转unknown，不重传或改写历史快照',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'历史填写'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['jike']});const id=r.value[0].id;await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('filled'));adapter.verifyDraft.mockRejectedValueOnce(new SyncError('FILL_UNCONFIRMED','附件变化',false));const checked=await request('VERIFY',{id});expect(checked.value.status).toBe('unknown');expect(checked.value.error.code).toBe('FILL_CHANGED');expect(adapter.fillEditor).toHaveBeenCalledTimes(1);expect((await request('RETRY',{id})).ok).toBe(false);expect((await(await db()).get('tasks',id))?.snapshot.markdown).toBe('历史填写');
});
it('文字卡片渲染故障只阻断需要图片的平台，后面的纯文本动态继续',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'渲染异常'},0);const r=await request('START_SYNC',{draftId:draft.id,platforms:['douyin','jike']});expect(r.ok).toBe(true);
 await vi.waitFor(async()=>expect((await(await db()).getAll('tasks')).map(t=>t.status).sort()).toEqual(['failed','filled']));const failure=(await(await db()).getAll('tasks')).find(t=>t.platform==='douyin')!;expect(failure.error?.code).toBe('TEXT_IMAGE_FAILED');expect(adapter.fillEditor).toHaveBeenCalledTimes(1);
});
it('关闭失败页保留旧稿保护原因和禁止重试策略，不改成标签关闭',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'保护旧稿'},0);const t=await enqueue(draft,'zsxq','12345678901234','protection',false,'publish');await updateTask(t.id,['queued'],{status:'preparing',tabId:456});const failed=await updateTask(t.id,['preparing'],{status:'failed',progress:'原稿受保护，本次未发布',error:{code:'EDITOR_OCCUPIED',message:'知识星球恢复了旧稿',retrySafe:false}});
 tabRemoved(456);await vi.waitFor(async()=>expect((await(await db()).get('tasks',t.id))?.tabId).toBeUndefined());const after=await(await db()).get('tasks',t.id);expect(after?.error).toEqual(failed.error);expect(after?.progress).toBe(failed.progress);expect(after?.status).toBe('failed');expect((await request('RETRY',{id:t.id})).ok).toBe(false);
});
it('关闭已未知的任务页不丢失原回执错误或改写不确定状态',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'发布未知'},0);const t=await enqueue(draft,'x','','receipt',false,'publish');await updateTask(t.id,['queued'],{status:'preparing',tabId:789});await updateTask(t.id,['preparing'],{status:'unknown',progress:'回执待核对',error:{code:'PUBLISH_UNCONFIRMED',message:'平台回执未确认',retrySafe:false}});
 tabRemoved(789);await vi.waitFor(async()=>expect((await(await db()).get('tasks',t.id))?.tabId).toBeUndefined());expect((await(await db()).get('tasks',t.id))?.error?.code).toBe('PUBLISH_UNCONFIRMED');expect((await(await db()).get('tasks',t.id))?.progress).toBe('回执待核对');expect((await request('RETRY',{id:t.id})).ok).toBe(false);
});
it('升级恢复仅用本任务旧稿保护日志修正被覆盖的错误，未提交且历史内容不变',async()=>{
 const {recoverInterruptedTasks}=await import('../src/core/repository');const draft=await saveDraft({...newDraft('post'),markdown:'保护历史'},0);const t=await enqueue(draft,'zsxq','12345678901234','repair',false,'publish');await updateTask(t.id,['queued'],{status:'failed',error:{code:'TAB_CLOSED',message:'页关闭',retrySafe:true}});const d=await db();await d.put('logs',{id:crypto.randomUUID(),taskId:t.id,event:'EDITOR_OCCUPIED',level:'error',message:'原稿已恢复，未覆盖',time:t.createdAt});
 await recoverInterruptedTasks();const after=await d.get('tasks',t.id);expect(after?.error?.code).toBe('EDITOR_OCCUPIED');expect(after?.snapshot).toEqual(t.snapshot);expect(after?.status).toBe('failed');expect(publication.submit).not.toHaveBeenCalled();
});
it('旧稿日志之后已经进入发布准备时，不用过期旧错误覆盖当前关闭原因',async()=>{
 const {recoverInterruptedTasks}=await import('../src/core/repository');const draft=await saveDraft({...newDraft('post'),markdown:'已准备'},0);const t=await enqueue(draft,'zsxq','12345678901234','latest-log',false,'publish');await updateTask(t.id,['queued'],{status:'failed',updatedAt:t.createdAt+3,error:{code:'TAB_CLOSED',message:'页关闭',retrySafe:false}});const d=await db();for(const entry of [{event:'EDITOR_OCCUPIED',level:'error' as const,time:t.createdAt},{event:'editor_prepared',level:'info' as const,time:t.createdAt+1}])await d.put('logs',{...entry,id:crypto.randomUUID(),taskId:t.id,message:entry.event});const current=await d.get('tasks',t.id);await d.put('tasks',{...current!,updatedAt:t.createdAt+3});await recoverInterruptedTasks();expect((await d.get('tasks',t.id))?.error?.code).toBe('TAB_CLOSED');
});
it('未完成填写的旧稿失败不能继续发布，更不能覆盖原错误；只能重新准备',async()=>{
 adapter.fillEditor.mockRejectedValueOnce(new SyncError('EDITOR_OCCUPIED','已有旧稿'));const draft=await saveDraft({...newDraft('post'),markdown:'新的动态'},0);const response=await request('START_SYNC',{draftId:draft.id,platforms:['zsxq'],publishPlatforms:['zsxq']});const id=response.value[0].id;
 await vi.waitFor(async()=>expect((await(await db()).get('tasks',id))?.status).toBe('failed'));const before=await(await db()).get('tasks',id);expect((await request('RESUME_PUBLICATION',{id})).error?.code).toBe('NEEDS_PREPARATION');expect((await(await db()).get('tasks',id))?.error).toEqual(before?.error);expect(publication.submit).not.toHaveBeenCalled();
 const restarted=await request('START_SYNC',{draftId:draft.id,platforms:['zsxq'],publishPlatforms:['zsxq']});expect(restarted.value[0].id).not.toBe(id);await vi.waitFor(async()=>expect((await(await db()).get('tasks',restarted.value[0].id))?.status).toBe('submitted'));expect(publication.submit).toHaveBeenCalledTimes(1);expect((await(await db()).get('tasks',id))?.error?.code).toBe('EDITOR_OCCUPIED');expect((await request('RETRY',{id})).ok).toBe(false);expect((await request('RESUME_PUBLICATION',{id})).ok).toBe(false);expect(publication.submit).toHaveBeenCalledTimes(1);
});

it('三种选择独立存储，设置更新不覆盖，重读恢复并过滤未实现平台',async()=>{
 await request('SET_PLATFORM_SELECTION',{type:'post',platforms:['zsxq','x','x','xiaohongshu']});
 await request('SET_PLATFORM_SELECTION',{type:'article',platforms:['weixin','x']});
 await request('SET_PLATFORM_SELECTION',{type:'video',platforms:['bilibili','x']});
 await request('SETTINGS',{zsxqGroupId:'12345678901234',showPreview:false,directPublish:false});
 const r=await request('WORKSPACE',{});expect(r.value.platformSelections).toEqual({post:['zsxq','x','xiaohongshu'],article:['weixin'],video:['bilibili','x']});
 expect(await(await db()).getAll('tasks')).toHaveLength(0);expect(adapter.openEditor).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();
 expect((await request('SET_PLATFORM_SELECTION',{type:'other',platforms:['x']})).ok).toBe(false);
});
it('选择保存失败返回错误，不伪报成功或改写其他设置',async()=>{
 const before=structuredClone(localStore);vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error('storage failed'));
 expect((await request('SET_PLATFORM_SELECTION',{type:'post',platforms:['x']})).ok).toBe(false);expect(localStore).toEqual(before);
});
it.each(['post','article','video'] as const)('%s旧长标题保留，21字拒绝入队，20字通过共同检查',async type=>{
 const long=await saveDraft({...newDraft(type),title:'字'.repeat(21),markdown:'正文'},0);
 expect((await request('START_SYNC',{draftId:long.id,platforms:['zsxq']})).error.code).toBe('TITLE_TOO_LONG');expect(await(await db()).getAll('tasks')).toHaveLength(0);
 expect((await(await db()).get('drafts',long.id))?.title).toHaveLength(21);
 const old=await enqueue(long,'zsxq','12345678901234','old');expect((await request('PREPARE',{id:old.id})).value.error.code).toBe('TITLE_TOO_LONG');expect(adapter.openEditor).not.toHaveBeenCalled();
 const short=await saveDraft({...long,title:'字'.repeat(20)},long.revision);expect((await request('ENQUEUE',{draftId:short.id,platforms:['zsxq']})).ok).toBe(true);
});
it('动态发布检查只读，成功或失败均保留原任务与错误，不上传或提交',async()=>{
 const draft=await saveDraft({...newDraft('post'),title:'只读检查',markdown:'正文'},0);const t=await enqueue(draft,'zsxq','12345678901234','read',false,'publish');
 await updateTask(t.id,['queued'],{status:'failed',tabId:123,proof:{bodyDigest:'a'.repeat(64),mediaHashes:[]},error:{code:'PUBLISH_NOT_READY',message:'原错误',retrySafe:false}});
 const before=await(await db()).get('tasks',t.id);expect((await request('CHECK_PUBLICATION',{id:t.id})).value.ready).toBe(true);
 publication.probe.mockRejectedValueOnce(new Error('按钮未就绪'));expect((await request('CHECK_PUBLICATION',{id:t.id})).ok).toBe(false);
 expect(await(await db()).get('tasks',t.id)).toEqual(before);expect(adapter.fillEditor).not.toHaveBeenCalled();expect(adapter.saveDraft).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();
});
it('缺填写证明、旧关联记录、unknown和已提交记录不能进入发布前检查',async()=>{
 const draft=await saveDraft({...newDraft('post'),title:'边界',markdown:'正文'},0);const t=await enqueue(draft,'zsxq','12345678901234','check',false,'publish');
 await updateTask(t.id,['queued'],{status:'failed'});expect((await request('CHECK_PUBLICATION',{id:t.id})).ok).toBe(false);
 const d=await db();const failed=(await d.get('tasks',t.id))!;
 for(const patch of [{status:'unknown'},{status:'submitted'},{status:'filled',publicationAttemptedAt:1},{status:'failed',supersededByTaskId:crypto.randomUUID()}]){
  await d.put('tasks',{...failed,proof:{bodyDigest:'a'.repeat(64),mediaHashes:[]},tabId:123,...patch} as any);expect((await request('CHECK_PUBLICATION',{id:t.id})).ok).toBe(false);
 }
 expect(publication.probe).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();
});
it('普通回执核对延迟到队尾，下一平台本地调度开销小于1秒',async()=>{const draft=await saveDraft({...newDraft('post'),markdown:'串行调度'},0);const result=await request('START_SYNC',{draftId:draft.id,platforms:['jike','x'],publishPlatforms:['jike','x']});await vi.waitFor(async()=>expect((await(await db()).getAll('tasks')).filter(t=>t.batchId===result.value[0].batchId).every(t=>t.status==='submitted')).toBe(true));const rows=(await(await db()).getAll('tasks')).filter(t=>t.batchId===result.value[0].batchId).sort((a,b)=>a.queueOrder!-b.queueOrder!);expect(rows[1]!.timings?.dispatchDelayMs).toBeLessThan(1000);expect(rows[1]!.timings?.dispatchDelayMs).toBeGreaterThanOrEqual(0);});
it('已取消并恢复旧稿的任务即使残留旧填写证明，也禁止继续发布',async()=>{const draft=await saveDraft({...newDraft('post'),markdown:'已取消'},0);const t=await enqueue(draft,'zsxq','12345','cancelled',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'failed',tabId:123,proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]},error:{code:'CANCELLED_FOR_RESTORE',message:'已取消',retrySafe:false}});const result=await request('RESUME_PUBLICATION',{id:t.id});expect(result).toMatchObject({ok:false,error:{code:'UNSAFE_RETRY'}});expect(publication.probe).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();});
it('超限未选择时整批不入队，明确跳过后不打开该平台，其他目标继续',async()=>{const draft=await saveDraft({...newDraft('post'),markdown:'a'.repeat(1001),tags:['t']},0);const payload={draftId:draft.id,platforms:['xiaohongshu','jike']};expect((await request('START_SYNC',payload)).error.code).toBe('OVERFLOW_CHOICE_REQUIRED');expect(await(await db()).getAll('tasks')).toHaveLength(0);expect(adapter.openEditor).not.toHaveBeenCalled();const result=await request('START_SYNC',{...payload,overflow:'skip'});expect(result.ok).toBe(true);await vi.waitFor(async()=>expect((await(await db()).getAll('tasks')).find(t=>t.platform==='jike')?.status).toBe('filled'));const x=(await(await db()).getAll('tasks')).find(t=>t.platform==='xiaohongshu')!;expect(x).toMatchObject({status:'failed',autoRun:false,error:{code:'POST_LIMIT_SKIPPED'}});expect(x.tabId).toBeUndefined();expect(adapter.openEditor).toHaveBeenCalledTimes(1);});
it('超限转图后台快照保留全文，原稿和原附件不变，标签独立且X不超过4图',async()=>{const {Blob}=await import('node:buffer');const previousCanvas=globalThis.OffscreenCanvas;const ctx={font:'',fillStyle:'',textBaseline:'',measureText:(s:string)=>({width:[...s].length*40}),fillRect:vi.fn(),fillText:vi.fn()};vi.stubGlobal('OffscreenCanvas',class{getContext(){return ctx;}convertToBlob(){return Promise.resolve(new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}));}});try{const draft=await saveDraft({...newDraft('post'),title:'原稿',markdown:'a'.repeat(1001),tags:['t']},0);const result=await request('START_SYNC',{draftId:draft.id,platforms:['xiaohongshu','jike','x'],overflow:'images'});expect(result.ok).toBe(true);await vi.waitFor(async()=>expect((await(await db()).getAll('tasks')).every(t=>t.status==='filled')).toBe(true));const x=(await(await db()).getAll('tasks')).find(t=>t.platform==='xiaohongshu')!;const j=(await(await db()).getAll('tasks')).find(t=>t.platform==='jike')!;expect(x.snapshot).toMatchObject({markdown:draft.markdown,tags:['t'],textAsImages:true});expect(x.snapshot.media.length).toBeGreaterThan(1);expect(j.snapshot.textAsImages).toBeUndefined();expect(j.snapshot.media).toEqual([]);const premium=(await(await db()).getAll('tasks')).find(t=>t.platform==='x')!;expect(premium.snapshot).toMatchObject({markdown:draft.markdown,tags:['t'],media:[]});expect(premium.snapshot.textAsImages).toBeUndefined();expect((await(await db()).get('drafts',draft.id))?.media).toEqual([]);}finally{vi.stubGlobal('OffscreenCanvas',previousCanvas);}});
it('手动准备filled动态建立关联任务且停止待发布；重复准备不新增也不提交',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'准备验收'},0);const source=await enqueue(draft,'jike','','manual',false,'fill');await updateTask(source.id,['queued'],{status:'preparing',tabId:123});await updateTask(source.id,['preparing'],{status:'filled',proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]}});
 (chrome.tabs as any).get=vi.fn(async()=>({id:123,url:'https://web.okjike.com/'}));const r=await request('PREPARE_PUBLICATION',{id:source.id});expect(r).toMatchObject({ok:true});expect(r.value).toMatchObject({operation:'publish',status:'ready_for_confirmation',autoRun:false,parentTaskId:source.id});expect(r.value.publicationAttemptedAt).toBeUndefined();const again=await request('PREPARE_PUBLICATION',{id:source.id});expect(again.value.id).toBe(r.value.id);expect(await(await db()).getAll('tasks')).toHaveLength(2);expect(publication.submit).not.toHaveBeenCalled();
});
it('手动准备未开始的任务通过关联任务填写，保留原记录且不自动发布',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'从零准备'},0);const source=await enqueue(draft,'zsxq','123456','manual',false,'fill');const r=await request('PREPARE_PUBLICATION',{id:source.id});expect(r).toMatchObject({ok:true});expect(r.value).toMatchObject({status:'ready_for_confirmation',autoRun:false,supersedesTaskId:source.id});expect((await(await db()).get('tasks',source.id))?.supersededByTaskId).toBe(r.value.id);expect(adapter.fillEditor).toHaveBeenCalledOnce();expect(publication.submit).not.toHaveBeenCalled();
});
it('已上传或已提交的unknown任务不能通过准备接口解锁',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'旧任务保护'},0);const t=await enqueue(draft,'bilibili','','old',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});const old=await updateTask(t.id,['preparing'],{status:'unknown',proof:{bodyDigest:'proof',mediaHashes:[],uploadedMediaIds:[crypto.randomUUID()]}});expect((await request('PREPARE_PUBLICATION',{id:t.id})).ok).toBe(false);expect(await(await db()).get('tasks',t.id)).toEqual(old);expect(adapter.openEditor).not.toHaveBeenCalled();expect(publication.submit).not.toHaveBeenCalled();
});

it('知识星球已就绪队列的原子领取先回到准备状态，恢复期间仍无提交标记',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'队列恢复'},0);const t=await enqueue(draft,'zsxq','123456','claimed',true,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'ready_for_confirmation',tabId:123,proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]}});
 (adapter as any).preparePublication=vi.fn(async(current:any)=>{expect(current.status).toBe('ready_for_confirmation');expect(current.publicationAttemptedAt).toBeUndefined();await updateTask(current.id,['ready_for_confirmation'],{status:'preparing'});await updateTask(current.id,['preparing'],{status:'ready_for_confirmation'});return 'guard';});
 try{alarmWake({name:'reconcile'});await vi.waitFor(async()=>expect((await(await db()).get('tasks',t.id))?.status).toBe('submitted'));expect(publication.submit).toHaveBeenCalledOnce();expect((await(await db()).get('tasks',t.id))?.publicationAttemptedAt).toBeDefined();}finally{delete (adapter as any).preparePublication;}
});
it('已持久化提交标记的任务不能从publishing退回发布准备',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'不重发'},0);const t=await enqueue(draft,'zsxq','123456','attempted',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'ready_for_confirmation'});await updateTask(t.id,['ready_for_confirmation'],{status:'publishing',publicationAttemptedAt:Date.now()});await expect(updateTask(t.id,['publishing'],{status:'ready_for_confirmation'})).rejects.toThrow('已有提交标记');expect((await(await db()).get('tasks',t.id))?.status).toBe('publishing');expect(publication.submit).not.toHaveBeenCalled();
});
it('固定标签入队去重并冻结；多星球生成独立任务且修改设置不改旧快照',async()=>{
 localStore.settings={zsxqGroupId:'123456',zsxqTargets:['123456','234567'],fixedTags:['常用','重复'],showPreview:false};localStore.targetOptions={zsxq:[{id:'123456',name:'甲星球'},{id:'234567',name:'乙星球'}]};
 const draft=await saveDraft({...newDraft('post'),markdown:'多目标',tags:['重复','本次']},0);
 const response=await request('ENQUEUE',{draftId:draft.id,platforms:['zsxq']});expect(response.ok).toBe(true);expect(response.value).toHaveLength(2);expect(response.value.map((t:any)=>t.targetId)).toEqual(['123456','234567']);expect(response.value.map((t:any)=>t.targetName)).toEqual(['甲星球','乙星球']);
 for(const t of response.value)expect(t.snapshot.tags).toEqual(['常用','重复','本次']);
 await request('SETTINGS',{zsxqGroupId:'123456',zsxqTargets:['123456'],fixedTags:['新标签'],showPreview:false});
 expect((await(await db()).get('tasks',response.value[0].id))?.snapshot.tags).toEqual(['常用','重复','本次']);expect((await(await db()).get('drafts',draft.id))?.tags).toEqual(['重复','本次']);expect(adapter.openEditor).not.toHaveBeenCalled();
});
it('即刻圈子作为任务目标冻结且不同圈子不被错误去重',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'圈子'},0);localStore.settings={zsxqGroupId:'',showPreview:false,jikeCircle:'人工智能讨论组'};const a=await request('ENQUEUE',{draftId:draft.id,platforms:['jike']});localStore.settings={zsxqGroupId:'',showPreview:false,jikeCircle:'大产品小细节'};const b=await request('ENQUEUE',{draftId:draft.id,platforms:['jike']});expect(a.value[0].targetId).toBe('人工智能讨论组');expect(b.value[0].targetId).toBe('大产品小细节');expect(a.value[0].id).not.toBe(b.value[0].id);
});

it('固定标签与平台目标独立增量保存，并发设置不覆盖其他字段；兼容旧单星球设置',async()=>{
 localStore.settings={zsxqGroupId:'123456',zsxqTargets:['123456','234567'],fixedTags:['旧固定'],jikeCircle:'原圈子',directPublish:true,showPreview:true};
 const [tags,circle]=await Promise.all([request('SETTINGS',{fixedTags:['新固定']}),request('SETTINGS',{jikeCircle:'人工智能讨论组'})]);expect(tags.ok&&circle.ok).toBe(true);expect(localStore.settings).toMatchObject({fixedTags:['新固定'],jikeCircle:'人工智能讨论组',zsxqTargets:['123456','234567'],directPublish:true,showPreview:true});await request('SETTINGS',{zsxqGroupId:'345678',showPreview:false});expect(localStore.settings).toMatchObject({zsxqTargets:['345678'],fixedTags:['新固定'],jikeCircle:'人工智能讨论组',directPublish:true});
});
it('旧提交任务只读核对使用当前来源窗口，但不改写任务原来源或触发发布',async()=>{
 const {verifyPublication}=await import('../src/platforms/publication-result');const draft=await saveDraft({...newDraft('post'),markdown:'已有结果'},0),originalSource={windowId:1,tabId:11};const t=await enqueue(draft,'jike','','verify-source',false,'publish',originalSource);await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'unknown',publicationAttemptedAt:1});(chrome.tabs as any).get=vi.fn(async()=>({id:99,windowId:9,url:'chrome-extension://test-extension/workbench.html'}));vi.mocked(verifyPublication).mockResolvedValueOnce({kind:'publication_result',checkedAt:Date.now(),url:'https://web.okjike.com/u/owner/post/012345678901234567890123',contentId:'012345678901234567890123',bodyMatched:true,mediaMatched:true,mediaCount:0});const result=await request('VERIFY',{id:t.id,source:{windowId:9,tabId:99}});expect(result.value.status).toBe('published');expect(verifyPublication).toHaveBeenLastCalledWith(expect.objectContaining({source:{windowId:9,tabId:99}}));expect((await(await db()).get('tasks',t.id))?.source).toEqual(originalSource);expect(publication.submit).not.toHaveBeenCalled();
});

it('仅填写转发布的关联任务保留原目标名称，不随新目标设置变更',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'原目标'},0),source=await enqueue(draft,'zsxq','123456','target-name',false,'fill');await updateTask(source.id,['queued'],{status:'preparing',tabId:123,targetName:'原星球'});await updateTask(source.id,['preparing'],{status:'filled',proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]}});localStore.targetOptions={zsxq:[{id:'123456',name:'设置中的其他显示名称'}]};const r=await request('PREPARE_PUBLICATION',{id:source.id});expect(r.value).toMatchObject({targetId:'123456',targetName:'原星球',parentTaskId:source.id,status:'ready_for_confirmation'});expect(publication.submit).not.toHaveBeenCalled();
});
it('公开核对通过后原稿恢复失败，只保留独立恢复提示，发布成功不得改成失败',async()=>{
 const {verifyPublication}=await import('../src/platforms/publication-result');const draft=await saveDraft({...newDraft('post'),markdown:'已经公开'},0),t=await enqueue(draft,'zsxq','123456','published-restore',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'unknown',publicationAttemptedAt:1});const backupId=crypto.randomUUID(),d=await db();await d.put('backups',{id:backupId,taskId:t.id,targetId:'123456',tabId:777,url:'https://wx.zsxq.com/group/123456',accountKey:'https://images.zsxq.com/owner',text:'原稿',digest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('原稿')))].map(x=>x.toString(16).padStart(2,'0')).join(''),createdAt:1,updatedAt:1,state:'replacing'});(chrome.tabs as any).get=vi.fn(async()=>{throw new Error('原稿页面已关闭');});vi.mocked(verifyPublication).mockResolvedValueOnce({kind:'publication_result',checkedAt:Date.now(),url:'https://wx.zsxq.com/group/123456/topic/123456789',contentId:'123456789',bodyMatched:true,mediaMatched:true,mediaCount:0});try{const r=await request('VERIFY',{id:t.id});expect(r.value.status).toBe('published');expect((await d.get('tasks',t.id))?.error).toBeUndefined();expect((await d.get('backups',backupId))?.state).toBe('restore_pending');expect((await d.get('backups',backupId))?.note).toContain('原稿页面已关闭');expect(publication.submit).not.toHaveBeenCalled();}finally{await d.delete('backups',backupId);}
});

it('X待核对结果只凭页面回执转已提交，保留原尝试和快照且不重发',async()=>{
 const {verifyPublication}=await import('../src/platforms/publication-result');const draft=await saveDraft({...newDraft('post'),title:'独立样本',markdown:'正文'},0),t=await enqueue(draft,'x','','x-result-receipt',false,'publish');await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'unknown',publicationAttemptedAt:123,error:{code:'PUBLISH_UNCONFIRMED',message:'回执未捕获',retrySafe:false}});vi.mocked(verifyPublication).mockResolvedValueOnce({kind:'publication_receipt',checkedAt:Date.now(),url:'https://x.com/owner/status/1234567890123456789',contentId:'1234567890123456789',bodyMatched:true,mediaMatched:false,mediaCount:1});const result=await request('VERIFY',{id:t.id});expect(result.value).toMatchObject({status:'submitted',publicationAttemptedAt:123,evidence:{mediaMatched:false}});expect(result.value.snapshot).toEqual(draft);expect(result.value.error).toBeUndefined();expect(publication.submit).not.toHaveBeenCalled();expect((await request('RETRY',{id:t.id})).ok).toBe(false);
});
