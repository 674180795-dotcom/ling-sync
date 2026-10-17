import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {nativeXLongText,XPostAdapter} from '../src/platforms/x-post-adapter';
import {FillAdapter} from '../src/platforms/fill-adapter';
import {publicationProbe} from '../src/platforms/publication';
import {newDraft,type PublishTask} from '../src/core/model';
vi.mock('../src/platforms/publication',async original=>({...await original<typeof import('../src/platforms/publication')>(),publicationProbe:vi.fn(async()=> 'guard')}));
beforeEach(()=>{vi.stubGlobal('location',{origin:'https://x.com'});document.body.innerHTML='<div role="dialog" aria-modal="true"><div data-testid="tweetTextarea_0" contenteditable="true"><div>长文本</div><div>第二段 #标签</div></div><button data-testid="tweetButton">Post</button></div>';for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.clearAllMocks();});
it('完整长文本和标签进入可发送的原生编辑器才判定本次接受；不点击',()=>{const click=vi.fn();document.querySelector('button')!.onclick=click;expect(nativeXLongText('长文本\n第二段 #标签').eligibility).toBe('accepted');expect(click).not.toHaveBeenCalled();expect(nativeXLongText('长文本\n第二段').eligibility).toBe('unknown');});
it('禁用按钮或未知状态不判定无会员，正文中的升级文案也不冒充平台提示',()=>{document.querySelector('button')!.disabled=true;expect(nativeXLongText('长文本\n第二段 #标签').eligibility).toBe('unknown');document.querySelector('button')!.disabled=false;document.querySelector('[contenteditable]')!.textContent='Upgrade to Premium to write longer posts';expect(nativeXLongText('Upgrade to Premium to write longer posts').eligibility).toBe('accepted');});
it('只有本次编辑器明确要求升级发送长帖才判定无资格',()=>{const warning=document.createElement('div');warning.setAttribute('role','alert');warning.textContent='Upgrade to Premium to write longer posts';warning.getClientRects=()=>({length:1}) as DOMRectList;document.querySelector('[role=dialog]')!.append(warning);expect(nativeXLongText('长文本\n第二段 #标签').eligibility).toBe('ineligible');});
it('原生编辑器截断文本和重复编辑器均不能判定长文可发',()=>{expect(nativeXLongText('长文本\n第二段 #标签\n未进入原生编辑器的一段').eligibility).toBe('unknown');document.querySelector('[role=dialog]')!.append(document.querySelector('[contenteditable]')!.cloneNode(true));for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;expect(nativeXLongText('长文本\n第二段 #标签').eligibility).toBe('unknown');});
const task=()=>({id:crypto.randomUUID(),platform:'x',tabId:7,status:'ready_for_confirmation',snapshot:{...newDraft('post'),title:'标题',markdown:'长'.repeat(200),tags:['固定','普通']},proof:{bodyDigest:'known',mediaHashes:[]}} as unknown as PublishTask);
it('发布准备重新核对当前正文资格，稳定接受后才取得发布守卫',async()=>{
 vi.spyOn(FillAdapter.prototype,'verifyDraft').mockResolvedValue({kind:'editor_readback',checkedAt:0,url:'https://x.com/compose/post'});const execute=vi.fn(async(_request:unknown)=>[{result:{eligibility:'accepted',note:'本次可发'}}]);vi.stubGlobal('chrome',{scripting:{executeScript:execute}});
 expect(await new XPostAdapter().preparePublication(task())).toBe('guard');expect(execute).toHaveBeenCalledTimes(3);expect(execute.mock.calls[0]?.[0]).toMatchObject({args:[expect.stringContaining('#固定 #普通')]});expect(publicationProbe).toHaveBeenCalledOnce();
});
it('账号明确无资格时在取得提交守卫前停止，原稿与填写证明不变',async()=>{
 vi.spyOn(FillAdapter.prototype,'verifyDraft').mockResolvedValue({kind:'editor_readback',checkedAt:0,url:'https://x.com/compose/post'});vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn(async()=>[{result:{eligibility:'ineligible',note:'请升级才能发送长文'}}])}});const t=task(),prior=structuredClone(t);
 await expect(new XPostAdapter().preparePublication(t)).rejects.toMatchObject({code:'X_LONG_TEXT_INELIGIBLE'});expect(t).toEqual(prior);expect(publicationProbe).not.toHaveBeenCalled();
});
