import {afterEach,expect,it,vi} from 'vitest';
import {FillAdapter} from '../src/platforms/fill-adapter';
import {nativeFillEditor} from '../src/platforms/native-fill-editor';
import {fillProfile} from '../src/platforms/fill-profiles';
import {errorValue} from '../src/core/protocol';
import {newDraft,type PublishTask} from '../src/core/model';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('浏览器错误页归为加载失败，已有操作的不确定性仍由任务执行器处理',()=>{
 expect(errorValue(new Error('Frame with ID 0 is showing error page'))).toMatchObject({code:'PAGE_LOAD_FAILED',retrySafe:true});
 expect(errorValue(new Error('net::ERR_CONNECTION_RESET'))).toMatchObject({code:'PAGE_LOAD_FAILED'});
 expect(errorValue(new Error('正文不同'))).toMatchObject({code:'OPERATION_FAILED'});
});
it('B站检测阶段的浏览器错误不被吞成字段超时',async()=>{
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({id:7,url:'https://t.bilibili.com/',status:'complete'})},scripting:{executeScript:async()=>{throw new Error('Frame with ID 0 is showing error page');}}});
 const task={platform:'bilibili',snapshot:newDraft('post'),tabId:7} as PublishTask;
 await expect(new FillAdapter('bilibili').openEditor(task)).rejects.toMatchObject({code:'PAGE_LOAD_FAILED',retrySafe:true});
});
it('B站先激活并等待延迟旧稿恢复稳定，再交给填写保护，不修改字段',async()=>{
 let active=99,reads=0;
 const update=vi.fn(async(id:number)=>{active=id;return {id};});
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async(id:number)=>id===99?{id,active:active===id,windowId:1}:{id:7,url:'https://t.bilibili.com/',status:'complete'},update,query:async()=>[{id:active}]},scripting:{executeScript:async({args}:any)=>args[1]==='read'?[{result:{body:++reads<5?'':'旧稿',title:'',images:[],imageItems:0,uploadBusy:false}}]:[{result:{ready:true}}]}});
 vi.useFakeTimers();const task={platform:'bilibili',snapshot:newDraft('post'),tabId:7,source:{tabId:99,windowId:1}} as PublishTask;
 const pending=new FillAdapter('bilibili').openEditor(task);await vi.advanceTimersByTimeAsync(4000);expect(await pending).toBe(7);expect(reads).toBeGreaterThanOrEqual(10);expect(update.mock.calls.map(c=>c[0])).toEqual([7,99]);
});
it.each(['channels','jike'] as const)('%s 后台未挂载时只在来源工作台仍前台时激活，并在就绪后返回',async(platform)=>{
 let active=false;
 const update=vi.fn(async(id:number)=>{active=id===7;return {id};});
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async(id:number)=>id===99?{id,active:!active,windowId:1}:{id:7,url:platform==='jike'?'https://web.okjike.com/':'https://channels.weixin.qq.com/platform/post/finderNewLifeCreate',status:'complete'},update,query:async()=>[{id:active?7:99}]},scripting:{executeScript:async()=>[{result:{ready:active}}]}});
 const task={id:crypto.randomUUID(),platform,snapshot:newDraft('post'),tabId:7,source:{tabId:99,windowId:1}} as PublishTask;
 vi.useFakeTimers();const pending=new FillAdapter(platform).openEditor(task);await vi.advanceTimersByTimeAsync(4000);
 expect(await pending).toBe(7);expect(update.mock.calls.map(c=>c[0])).toEqual([7,99]);
});
it('正文不一致时返回长度与原生模型诊断，不包含用户正文',async()=>{
 vi.stubGlobal('location',{origin:'https://wx.zsxq.com',pathname:'/group/12345'});
 document.body.innerHTML='<div class="create-topic-panel"><div class="ql-editor" contenteditable="true"><p>新正文</p></div><span class="text-range">(2/10000)</span></div>';
 for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 const r=await nativeFillEditor(fillProfile('zsxq','post')!,'read',{targetId:'12345',title:'',text:'新正文',video:false,expectedImages:0});
 expect(r.bodyMatched).toBe(false);expect(r.fieldState).toEqual({actualCharacters:3,expectedCharacters:3,nativeCharacters:2,modelMatched:false});
 expect(JSON.stringify(r.fieldState)).not.toContain('新正文');
});
it.each(['channels','kuaishou','bilibili','jike'] as const)('%s 上传及稳定回读期间保留前台，完成后返回来源工作台',async(platform)=>{
 let active=99;
 const update=vi.fn(async(id:number)=>{active=id;return {id};});
 vi.stubGlobal('chrome',{tabs:{get:async(id:number)=>({id,active:active===id,windowId:1}),update,query:async()=>[{id:active}]}});
 const a=new FillAdapter(platform),fill=vi.spyOn(a as any,'fillPreparedEditor').mockImplementation(async()=>{expect(active).toBe(7);return {bodyMatched:true};});
 const task={platform,snapshot:newDraft('post'),source:{tabId:99,windowId:1}} as PublishTask;
 expect(await a.fillEditor(task,7)).toEqual({bodyMatched:true});expect(fill).toHaveBeenCalledOnce();expect(update.mock.calls.map(c=>c[0])).toEqual([7,99]);
});
it('快手只消除相邻原生话题组件之间的分隔空格，保留普通正文及标签差异',async()=>{
 vi.stubGlobal('location',{origin:'https://cp.kuaishou.com',pathname:'/article/publish/video'});
 document.body.innerHTML='<div placeholder="添加合适的话题和描述，作品能获得更多推荐～" contenteditable="true"><span is-tag="true"><span class="at-tag-item" data-tag-name="灵有志">#灵有志</span></span>  <span is-tag="true"><span class="at-tag-item" data-tag-name="AI">#AI</span></span> </div>';
 for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 const tag=document.querySelector('[is-tag="true"]')!;tag.nextSibling!.textContent=' ';tag.after(document.createTextNode(' '));
 const profile=fillProfile('kuaishou','post')!,payload={title:'',text:'#灵有志 #AI',video:false,expectedImages:0};
 expect((await nativeFillEditor(profile,'read',payload)).bodyMatched).toBe(true);
 expect((await nativeFillEditor(profile,'read',{...payload,text:'#AI #灵有志'})).bodyMatched).toBe(false);
 const body=document.querySelector('[contenteditable]')!;body.prepend(document.createTextNode('内容  保留\n'));
 expect((await nativeFillEditor(profile,'read',{...payload,text:'内容  保留\n#灵有志 #AI'})).bodyMatched).toBe(true);
 expect((await nativeFillEditor(profile,'read',{...payload,text:'内容 保留\n#灵有志 #AI'})).bodyMatched).toBe(false);
});
it('填写失败仍返回来源工作台，但用户已转到其他页面时不抢回',async()=>{
 let active=99;
 const update=vi.fn(async(id:number)=>{active=id;return {id};});
 vi.stubGlobal('chrome',{tabs:{get:async(id:number)=>({id,active:active===id,windowId:1}),update,query:async()=>[{id:active}]}});
 const a=new FillAdapter('channels'),task={platform:'channels',snapshot:newDraft('post'),source:{tabId:99,windowId:1}} as PublishTask;
 const fill=vi.spyOn(a as any,'fillPreparedEditor').mockRejectedValueOnce(new Error('上传失败'));
 await expect(a.fillEditor(task,7)).rejects.toThrow('上传失败');expect(active).toBe(99);
 update.mockClear();fill.mockImplementationOnce(async()=>{active=88;return {};});await a.fillEditor(task,7);expect(update.mock.calls.map(c=>c[0])).toEqual([7]);expect(active).toBe(88);
 update.mockClear();fill.mockResolvedValueOnce({});await a.fillEditor(task,7);expect(update).not.toHaveBeenCalled();
});
