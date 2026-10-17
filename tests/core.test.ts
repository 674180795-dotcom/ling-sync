import { describe,it,expect,beforeEach } from 'vitest';
import { newDraft, groupIdFrom, safeUrl, transitionAllowed, recoveryStatus } from '../src/core/model';
import { db, saveDraft, enqueue, updateTask, recoverInterruptedTasks, deleteDraft,claimNextTask } from '../src/core/repository';
import { RequestSchema, trustedUi } from '../src/core/protocol';
import { renderMarkdown } from '../src/core/markdown';
import {Blob as NativeBlob} from 'node:buffer';
import {formatSignature,normaliseBody,sameMedia,targetMatches,mediaIdentity,knownUploadPrefix,semanticBody} from '../src/core/content-proof';
import {removeMedia} from '../src/core/client';

beforeEach(async()=>{const d=await db();for(const store of ['drafts','tasks','media','accounts','logs','settings'] as const)await d.clear(store);});
describe('草稿与快照',()=>{
  it('版本冲突不覆盖已经保存的内容',async()=>{
    const draft=newDraft();const first=await saveDraft({...draft,title:'第一版'},0);
    await saveDraft({...first,title:'另一个窗口'},first.revision);
    await expect(saveDraft({...first,title:'陈旧窗口'},first.revision)).rejects.toThrow('另一个窗口');
    expect((await(await db()).get('drafts',draft.id))?.title).toBe('另一个窗口');
  });
  it('入队去重且保持独立快照',async()=>{
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文'},0);
    const a=await enqueue(draft,'zsxq','12345678901234','batch');const b=await enqueue(draft,'zsxq','12345678901234','batch2');
    expect(a.id).toBe(b.id);draft.title='后来修改';expect((await(await db()).get('tasks',a.id))?.snapshot.title).toBe('测试');
  });
  it('失败任务再次入队仍返回原任务，避免随后重试生成重复提交',async()=>{
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文'},0);
    const first=await enqueue(draft,'zsxq','12345678901234','batch');
    await updateTask(first.id,['queued'],{status:'failed',error:{code:'TEST',message:'提交前失败',retrySafe:true}});
    const second=await enqueue(draft,'zsxq','12345678901234','batch2');
    expect(second.id).toBe(first.id);expect(await(await db()).getAll('tasks')).toHaveLength(1);
  });
  it('删除本地草稿保留任务快照引用的媒体',async()=>{
    const d=await db();const media={id:crypto.randomUUID(),name:'a.png',kind:'image' as const,mime:'image/png' as const,bytes:8};
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文',media:[media]},0);
    await d.put('media',{...media,draftId:draft.id,blob:new NativeBlob(['12345678']) as unknown as Blob});await enqueue(draft,'zsxq','12345678901234','batch');
    await deleteDraft(draft.id);expect(await d.get('media',media.id)).toBeDefined();expect(await d.get('drafts',draft.id)).toBeUndefined();
  });
});
describe('保存的不确定性',()=>{
  it('保存过程重启后进入unknown，不能回到queued',async()=>{
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文'},0);const t=await enqueue(draft,'zsxq','12345678901234','batch');
    await updateTask(t.id,['queued'],{status:'preparing'});await updateTask(t.id,['preparing'],{status:'ready_for_confirmation'});await updateTask(t.id,['ready_for_confirmation'],{status:'saving_draft'});
    await recoverInterruptedTasks();const actual=await(await db()).get('tasks',t.id);expect(actual?.status).toBe('unknown');expect(actual?.error?.retrySafe).toBe(false);
    await expect(updateTask(t.id,['unknown'],{status:'queued'})).rejects.toThrow('状态转换');
  });
  it('填写被中断后可安全重试，已核对任务保持终态',()=>{
    expect(recoveryStatus('preparing')).toBe('failed');expect(recoveryStatus('draft_saved')).toBe('draft_saved');expect(transitionAllowed('unknown','queued')).toBe(false);
  });
});
describe('授权与格式边界',()=>{
  it('公众号图片尺寸转换保留原生资产身份，不同图片仍不匹配',()=>{
    const base='https://mmbiz.qpic.cn/sz_mmbiz_png/assetA/';
    expect(mediaIdentity('weixin',base+'640?secret=redacted')).toBe(mediaIdentity('weixin',base+'0'));
    expect(mediaIdentity('weixin',base+'640')).not.toBe(mediaIdentity('weixin','https://mmbiz.qpic.cn/sz_mmbiz_png/assetB/640'));
    expect(mediaIdentity('zsxq','https://images.zsxq.com/asset?token=redacted')).toBe('https://images.zsxq.com/asset');
  });
  it('中断后只能跳过已记录身份的上传图片',()=>{
    expect(knownUploadPrefix(['a'],['a','b'])).toBe(true);
    expect(knownUploadPrefix(['a'],undefined)).toBe(false);
    expect(knownUploadPrefix(['c'],['a'])).toBe(false);
    expect(knownUploadPrefix([],['a'])).toBe(true);
  });
  it('全文核对保留有意义的空格和段落，忽略编辑器空行与占位节点',()=>{
    const doc=(html:string)=>new DOMParser().parseFromString(html,'text/html').body;
    expect(semanticBody(doc('<p>A B</p>'))).not.toBe(semanticBody(doc('<p>AB</p>')));
    expect(semanticBody(doc('<p>A</p><p>B</p>'))).not.toBe(semanticBody(doc('<p>AB</p>')));
    expect(semanticBody(doc('<p><br></p><h2>标题</h2><p><strong>A</strong> B</p><div contenteditable="false">占位</div>'))).toBe(semanticBody(doc('<h2>标题</h2>\n<p><strong>A</strong> B</p>')));
  });
  it('只接受扩展自己的工作台消息，不接受站点和内容脚本',()=>{
    const id='abcdefghijklmnopabcdefghijklmnop';expect(trustedUi({id,url:`chrome-extension://${id}/workbench.html`},id)).toBe(true);
    expect(trustedUi({id,url:'https://wx.zsxq.com/',tab:{id:1} as chrome.tabs.Tab},id)).toBe(false);expect(trustedUi({id,url:`chrome-extension://${id}/workbench.html`,tab:{id:1} as chrome.tabs.Tab},id)).toBe(true);
  });
  it('拒绝发布指令和畸形请求',()=>{
    expect(RequestSchema.safeParse({channel:'ling-sync',version:1,action:'PUBLISH',payload:{}}).success).toBe(false);
    expect(RequestSchema.safeParse({channel:'ling-sync',version:1,action:'PREPARE',payload:{id:'arbitrary'}}).success).toBe(false);
  });
  it('格式转换去掉可执行HTML和远程自动图片',()=>{
    const html=renderMarkdown('# 标题\n\n**加粗**\n<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">危险</a>\n![外部](https://example.com/x.png)');
    expect(html).toContain('<strong>加粗</strong>');expect(html).not.toMatch(/<script|onerror|javascript:|<img/);expect(html).toContain('外部');
  });
  it('星球链接只允许官方站点，日志URL不保留认证参数',()=>{
    expect(groupIdFrom('https://wx.zsxq.com/group/12345678901234')).toBe('12345678901234');expect(()=>groupIdFrom('https://evil.test/group/12345678901234')).toThrow();
    expect(safeUrl('https://wx.zsxq.com/article?groupId=12345678901234&token=secret&secret=hidden#fragment')).toBe('https://wx.zsxq.com/article?groupId=12345678901234');
  });
  it('拒绝多余正文、格式丢失以及图片替换或调序',()=>{
    const doc=(html:string)=>new DOMParser().parseFromString(html,'text/html').body;
    expect(normaliseBody('原文额外文字')).not.toBe(normaliseBody('原文'));
    expect(formatSignature(doc('<p><strong>原文</strong></p>'))).not.toBe(formatSignature(doc('<p>原文</p>')));
    expect(sameMedia(['a','b'],['b','a'])).toBe(false);expect(sameMedia(['a','c'],['a','b'])).toBe(false);
  });
  it('改变星球ID时拒绝同域的错误编辑器',()=>{
    expect(targetMatches('zsxq','12345678901234','https://wx.zsxq.com/article?groupId=12345678901234')).toBe(true);
    expect(targetMatches('zsxq','12345678901234','https://wx.zsxq.com/article?groupId=552521142424')).toBe(false);
  });
  it('删除图片并保存新版本后，陈旧快照不能入队',async()=>{
    const d=await db();const media={id:crypto.randomUUID(),name:'a.png',kind:'image' as const,mime:'image/png' as const,bytes:8};
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文',media:[media]},0);
    await d.put('media',{...media,draftId:draft.id,blob:new NativeBlob(['12345678']) as unknown as Blob});
    await saveDraft({...draft,media:[]},draft.revision);await removeMedia(media.id);
    await expect(enqueue(draft,'zsxq','12345678901234','batch')).rejects.toThrow('入队前已变化');expect(await d.getAll('tasks')).toHaveLength(0);
  });
  it('入队与删图交错时，任务引用的图片得到保留',async()=>{
    const d=await db();const media={id:crypto.randomUUID(),name:'a.png',kind:'image' as const,mime:'image/png' as const,bytes:8};
    const draft=await saveDraft({...newDraft(),title:'测试',markdown:'正文',media:[media]},0);
    await d.put('media',{...media,draftId:draft.id,blob:new NativeBlob(['12345678']) as unknown as Blob});
    const queued=enqueue(draft,'zsxq','12345678901234','batch');
    const change=(async()=>{await saveDraft({...draft,media:[]},draft.revision);await removeMedia(media.id);})();
    const result=await Promise.allSettled([queued,change]);
    if(result[0].status==='fulfilled')expect(await d.get('media',media.id)).toBeDefined();else expect(await d.getAll('tasks')).toHaveLength(0);
  });
});

describe('队列领取与视频中断',()=>{
  it('并发消费者仅一个领取，完成后才领取后续任务',async()=>{
    const draft=await saveDraft({...newDraft(),title:'领取',markdown:'正文'},0);
    const first=await enqueue(draft,'weixin','','batch',true);await enqueue(draft,'zsxq','12345678901234','batch',true);
    const claims=await Promise.all([claimNextTask(),claimNextTask()]);expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed=claims.find(Boolean)!;expect(claimed.status).toBe('preparing');expect(claimed.id).toBe(first.id);
    await updateTask(claimed.id,['preparing'],{status:'ready_for_confirmation'});
    const saving=await claimNextTask();expect(saving?.id).toBe(claimed.id);expect(saving?.status).toBe('saving_draft');expect(await claimNextTask()).toBeUndefined();
    await updateTask(claimed.id,['saving_draft'],{status:'unknown'});expect((await claimNextTask())?.id).not.toBe(first.id);
  });
  it('视频填写时后台重启先核对已有上传，保留附件与领取记录',async()=>{
    const draft=await saveDraft({...newDraft('video'),title:'视频',markdown:'说明'},0);const task=await enqueue(draft,'douyin','','batch',true,'fill');await claimNextTask();
    const mediaId=crypto.randomUUID();await updateTask(task.id,['preparing'],{proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[mediaId]}});await recoverInterruptedTasks();
    const recovered=await(await db()).get('tasks',task.id);expect(recovered?.status).toBe('unknown');expect(recovered?.proof?.uploadedMediaIds).toEqual([mediaId]);expect(recovered?.error?.retrySafe).toBe(false);expect(await claimNextTask()).toBeUndefined();
  });
});
it('图片动态上传交付后重启也保持unknown，不能再次领取',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'图片动态'},0);const task=await enqueue(draft,'jike','','batch',true,'fill');await claimNextTask();await updateTask(task.id,['preparing'],{proof:{bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[crypto.randomUUID()]}});await recoverInterruptedTasks();expect((await(await db()).get('tasks',task.id))?.status).toBe('unknown');expect(await claimNextTask()).toBeUndefined();
});

it('发布中断进入unknown，旧填写快照不会因切换发布选项自动升级',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'正文'},0);const t=await enqueue(draft,'jike','','batch',true,'fill');
 await expect(enqueue(draft,'jike','','new',true,'publish')).rejects.toThrow('原任务仍未完成');expect((await(await db()).get('tasks',t.id))?.operation).toBe('fill');
 await claimNextTask();await updateTask(t.id,['preparing'],{status:'ready_for_confirmation'});await updateTask(t.id,['ready_for_confirmation'],{status:'publishing'});await recoverInterruptedTasks();expect((await(await db()).get('tasks',t.id))?.status).toBe('unknown');expect(await claimNextTask()).toBeUndefined();
});
it('ready发布任务并发领取仅一次，持久发布状态在重启后不再次领取',async()=>{
 const draft=await saveDraft({...newDraft('post'),markdown:'正文'},0);const t=await enqueue(draft,'jike','','batch',true,'publish');await claimNextTask();await updateTask(t.id,['preparing'],{status:'ready_for_confirmation'});
 const claims=await Promise.all([claimNextTask(),claimNextTask()]);expect(claims.filter(Boolean)).toHaveLength(1);expect(claims.find(Boolean)?.status).toBe('publishing');await recoverInterruptedTasks();expect((await(await db()).get('tasks',t.id))?.status).toBe('unknown');
});

it('显式发布关联已填写任务，保留原任务与媒体身份，并发发布请求仅一个新任务',async()=>{
 const d=await saveDraft({...newDraft('post'),markdown:'正文'},0);const original=await enqueue(d,'jike','','fill',true,'fill');await claimNextTask();const proof={bodyDigest:'a'.repeat(64),mediaHashes:[],uploadedMediaIds:[]};await updateTask(original.id,['preparing'],{status:'filled',tabId:42,proof});
 const [a,b]=await Promise.all([enqueue(d,'jike','','pub1',true,'publish'),enqueue(d,'jike','','pub2',true,'publish')]);expect(a.id).toBe(b.id);expect(a.id).not.toBe(original.id);expect(a.parentTaskId).toBe(original.id);expect(a.tabId).toBe(42);expect(a.proof).toEqual(proof);expect((await(await db()).get('tasks',original.id))?.status).toBe('filled');expect(await(await db()).getAll('tasks')).toHaveLength(2);
});
it('任何未知同快照任务阻止派生发布，已提交发布不会生成新的填写任务',async()=>{
 const d=await saveDraft({...newDraft('post'),markdown:'正文'},0);const t=await enqueue(d,'jike','','a',true,'publish');await claimNextTask();await updateTask(t.id,['preparing'],{status:'unknown'});expect((await enqueue(d,'jike','','b',true,'publish')).id).toBe(t.id);expect((await enqueue(d,'jike','','c',true,'fill')).id).toBe(t.id);
});
