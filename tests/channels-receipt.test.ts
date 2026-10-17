import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {nativeChannelsReceipt} from '../src/platforms/channels-result';
import {readPublicationReceipt} from '../src/platforms/publication';
import {newDraft,type PublishTask} from '../src/core/model';

const title='灵同步动态验收B2SPH',attemptedAt=Date.parse('2026-10-16T23:44:48+08:00');
const row=(text=title,time='2026年10月16日 23:44')=>'<div class="center-info"><div class="post-title">'+text+'</div><div class="desc"><div class="posted-info"><span class="post-time"><span class="time-label">'+time+'</span></span></div><span>仅自己可见</span></div></div>';
function show(root:Document|ShadowRoot=document){for(const element of root.querySelectorAll<HTMLElement>('*'))element.getClientRects=()=>({length:1}) as DOMRectList;}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T23:49:10+08:00'));vi.stubGlobal('location',{origin:'https://channels.weixin.qq.com',pathname:'/platform/post/finderNewLifePostList'});document.body.innerHTML=row();show();});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();document.body.innerHTML='';});
it('原任务提交标记及完整准备证明存在时只读恢复回执，不调用发送',async()=>{
 const execute=vi.fn(async({func,args}:any)=>[{result:func===nativeChannelsReceipt?nativeChannelsReceipt(...args as [{title:string;attemptedAt:number},boolean]):undefined}]);
 vi.stubGlobal('chrome',{tabs:{get:async()=>({url:'https://channels.weixin.qq.com/platform/post/finderNewLifePostList'})},scripting:{executeScript:execute}});
 const task={platform:'channels',snapshot:{...newDraft('post'),title,media:[]},tabId:7,publicationAttemptedAt:attemptedAt,publicationGuard:'guard',proof:{bodyDigest:'body',mediaHashes:[],uploadedMediaIds:[]}} as unknown as PublishTask;
 expect(await readPublicationReceipt(task)).toMatchObject({kind:'publication_receipt'});expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]![0].func).toBe(nativeChannelsReceipt);
 execute.mockClear();expect(await readPublicationReceipt({...task,publicationAttemptedAt:undefined})).toBeUndefined();expect(execute).not.toHaveBeenCalled();
});

it('本次提交分钟的唯一标题及正常管理时间只形成提交回执，保留限制标签',()=>{
 const click=vi.spyOn(HTMLElement.prototype,'click');const receipt=nativeChannelsReceipt({title,attemptedAt});
 expect(receipt).toMatchObject({postedAt:Date.parse('2026-10-16T23:44:00+08:00'),url:'https://channels.weixin.qq.com/platform/post/finderNewLifePostList',receiptOnly:true});
 expect(receipt.notice).toContain('仅自己可见');expect(receipt.notice).toContain('正文及图片尚待核对');expect(receipt).not.toHaveProperty('contentId');expect(click).not.toHaveBeenCalled();click.mockRestore();
});
it('WUJIE开放ShadowRoot内的列表可达且根遍历不会重复认领',()=>{
 document.body.innerHTML='<wujie-app></wujie-app>';const shadow=document.querySelector('wujie-app')!.attachShadow({mode:'open'});shadow.innerHTML=row();show();show(shadow);
 expect(nativeChannelsReceipt({title,attemptedAt}).receiptOnly).toBe(true);
});
it('同源iframe内的开放ShadowRoot可达，跨源iframe中的内容不提供回执',()=>{
 document.body.innerHTML='<iframe src="https://channels.weixin.qq.com/microfront"></iframe>';const iframe=document.querySelector('iframe')!;
 const doc=iframe.contentDocument!;doc.body?.remove();const body=doc.createElement('body');(doc.documentElement||doc.appendChild(doc.createElement('html'))).appendChild(body);
 body.innerHTML='<wujie-app></wujie-app>';const shadow=body.querySelector('wujie-app')!.attachShadow({mode:'open'});shadow.innerHTML=row();show();show(doc);show(shadow);
 expect(nativeChannelsReceipt({title,attemptedAt}).receiptOnly).toBe(true);
 iframe.hidden=true;expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('没有唯一');iframe.hidden=false;
 Object.defineProperty(iframe,'contentWindow',{value:{location:{origin:'https://unrelated.example'}},configurable:true});expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('没有唯一');
});
it.each(['2026年10月16日 23:43','2026年10月16日 23:55','2026年10月16日 23:50','2026年10月15日 23:44','2026年2月30日 23:44','刚刚',''])('旧同名、超出窗口、未来或无效时间拒绝：%s',(time)=>{
 document.body.innerHTML=row(title,time);show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toBeTruthy();
});
it('标题重复、缺失发表时间、原生编辑器仍在均拒绝',()=>{
 document.body.insertAdjacentHTML('beforeend',row());show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('没有唯一');
 document.body.innerHTML=row();document.querySelector('.time-label')!.remove();show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('时间未唯一');
 document.body.innerHTML=row()+'<div data-placeholder="添加描述, 1000个字符内">正文</div>';show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('仍显示正文编辑器');
});
it('错误来源及相似管理路径不产生回执',()=>{
 vi.stubGlobal('location',{origin:'https://channels.weixin.qq.com',pathname:'/platform/post/finderNewLifePostList/other'});expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('不在原图文管理');
 vi.stubGlobal('location',{origin:'https://other.example',pathname:'/platform/post/finderNewLifePostList'});expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('不在原图文管理');
});
it('隐藏的匹配标题不作为回执；可见标题的旧时间不会取用另一条的新时间',()=>{
 document.body.innerHTML='<div hidden>'+row()+'</div>'+row('其他标题');show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('没有唯一');
 document.body.innerHTML=row(title,'2026年10月16日 23:43')+row('其他标题');show();expect(nativeChannelsReceipt({title,attemptedAt},true).error).toContain('时间与本次提交不符');
});
it('没有原提交标记或未来的提交时间拒绝，合法下一分钟记录可确认',()=>{
 for(const value of [0,NaN,Infinity,Date.now()+1])expect(nativeChannelsReceipt({title,attemptedAt:value},true).error).toContain('原提交时间未确认');
 document.body.innerHTML=row(title,'2026年10月16日 23:45');show();expect(nativeChannelsReceipt({title,attemptedAt}).receiptOnly).toBe(true);
});
