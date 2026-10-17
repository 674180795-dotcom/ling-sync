import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,expect,it,vi} from 'vitest';
import App from '../src/ui/App';
import {api} from '../src/core/client';
import {db,saveDraft} from '../src/core/repository';
import {newDraft,limitTitleEdit,type WorkspaceData} from '../src/core/model';
import {Blob as NativeBlob} from 'node:buffer';
vi.mock('../src/core/client',async importOriginal=>{const original=await importOriginal<typeof import('../src/core/client')>();return {...original,api:{workspace:vi.fn(),saveDraft:vi.fn(),startSync:vi.fn(),settings:vi.fn(),setPlatformSelection:vi.fn(),checkPublication:vi.fn()}};});
let workspace:WorkspaceData;
beforeEach(async()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>'chrome-extension://test/'+p}});vi.stubGlobal('navigator',{storage:{estimate:async()=>({quota:1000000,usage:0})}});
 sessionStorage.clear();const database=await db();for(const s of ['drafts','tasks','media','accounts','logs','settings'] as const)await database.clear(s);
 workspace={drafts:[],tasks:[],accounts:[],settings:{zsxqGroupId:'',showPreview:false},logs:[]};
 vi.mocked(api.workspace).mockImplementation(async()=>({...workspace,drafts:await(await db()).getAll('drafts')}));vi.mocked(api.saveDraft).mockImplementation(saveDraft);vi.mocked(api.settings).mockImplementation(async settings=>{workspace.settings={...workspace.settings,...settings};return workspace.settings;});
 vi.mocked(api.setPlatformSelection).mockImplementation(async(type,ids)=>{workspace.platformSelections??={post:[],article:[],video:[]};workspace.platformSelections[type]=ids;return ids;});
 URL.createObjectURL=vi.fn(()=>'blob:test');URL.revokeObjectURL=vi.fn();
});
it('有内容切换类型另存副本，原文、版本和媒体Blob完整保留',async()=>{
 const media={id:crypto.randomUUID(),kind:'image' as const,name:'old.png',mime:'image/png' as const,bytes:8};
 const original=await saveDraft({...newDraft(),title:'原稿',markdown:'正文',tags:['原标签'],media:[media]},0);
 const blob=new NativeBlob([Uint8Array.from([137,80,78,71,13,10,26,10])]);await(await db()).put('media',{...media,draftId:original.id,blob:blob as unknown as Blob});
 // jsdom File has no arrayBuffer: use Node File, as browsers expose the same Blob API.
 vi.stubGlobal('File',(await import('node:buffer')).File);
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);
 await act(async()=>{root.render(createElement(App));});await loadHistory(container);const button=[...container.querySelectorAll('button')].find(e=>e.textContent==='动态')!;
 await act(async()=>{button.click();await new Promise(r=>setTimeout(r,50));});
 const drafts=await(await db()).getAll('drafts');expect(drafts).toHaveLength(2);const copy=drafts.find(d=>d.id!==original.id)!;
 expect(copy).toMatchObject({type:'post',title:'原稿',markdown:'正文',tags:['原标签']});expect(copy.media[0]?.id).not.toBe(media.id);
 expect(await(await db()).get('drafts',original.id)).toEqual(original);expect(await(await db()).get('media',media.id)).toBeDefined();expect((await(await db()).get('media',copy.media[0]!.id))?.blob.size).toBe(8);
 expect(container.querySelector('nav')).toBeNull();expect(container.querySelector('.preview-pane')).toBeNull();await act(async()=>root.unmount());container.remove();
});
it('底部仅保留直接发布总开关和一个开始按钮，平台只显示名称',async()=>{
 await saveDraft({...newDraft('post'),markdown:'设置验收'},0);workspace.settings={zsxqGroupId:'123456',showPreview:false,directPublish:false,directPublishPlatforms:['jike']};
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(App)));
 expect(container.textContent).not.toContain('全部直接发布');expect(container.textContent).not.toContain('将发布到');expect(container.querySelectorAll('.sync-action button')).toHaveLength(1);
 const checkbox=container.querySelector<HTMLInputElement>('[aria-label="直接发布"]')!;await act(async()=>checkbox.click());expect(workspace.settings.directPublish).toBe(true);
 const x=[...container.querySelectorAll<HTMLButtonElement>('.platform-chip')].find(e=>e.textContent?.trim()==='X')!;await act(async()=>x.click());expect(x.textContent?.trim()).toBe('X');expect(x.getAttribute('aria-pressed')).toBe('true');
 await act(async()=>root.unmount());container.remove();
});

const loadHistory=async(container:HTMLElement)=>{const select=container.querySelector<HTMLSelectElement>('#draft-select')!;const id=[...select.options].find(o=>o.value)?.value;if(id)await act(async()=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));});};
const mountEditor=async()=>{const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(App)));await loadHistory(container);return {container,root};};
const inputTitle=async(container:HTMLElement,value:string,event='input')=>{const input=container.querySelector<HTMLInputElement>('#draft-title')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(event,{bubbles:true}));});};
it('全选只记住当前类型，重开恢复，取消全选不改发布开关或入队',async()=>{
 await saveDraft({...newDraft('post'),title:'选择记忆',markdown:'正文'},0);workspace.settings.directPublish=true;workspace.settings.directPublishPlatforms=['x'];
 let view=await mountEditor();const button=()=>view.container.querySelector<HTMLInputElement>('[aria-label="全选平台"]')!;
 await act(async()=>button().click());expect(workspace.platformSelections?.post).toHaveLength(9);expect(workspace.platformSelections?.article).toEqual([]);expect(workspace.settings.directPublishPlatforms).toEqual(['x']);expect(api.startSync).not.toHaveBeenCalled();
 await act(async()=>view.root.unmount());view.container.remove();view=await mountEditor();expect(view.container.querySelectorAll('.platform-chip.selected')).toHaveLength(9);
 await act(async()=>button().click());expect(workspace.platformSelections?.post).toEqual([]);expect(api.settings).not.toHaveBeenCalled();await act(async()=>view.root.unmount());view.container.remove();
});
it('选择保存失败提示且保留后台已有组合',async()=>{
 await saveDraft({...newDraft('post'),markdown:'正文'},0);workspace.platformSelections={post:['x'],article:[],video:[]};vi.mocked(api.setPlatformSelection).mockRejectedValueOnce(new Error('选择保存失败'));
 const {container,root}=await mountEditor();await act(async()=>container.querySelector<HTMLInputElement>('[aria-label="全选平台"]')!.click());expect(container.textContent).toContain('选择保存失败');expect(container.querySelectorAll('.platform-chip.selected')).toHaveLength(1);await act(async()=>root.unmount());container.remove();
});
it.each(['post','article','video'] as const)('%s标题硬上限覆盖21字输入和粘贴，20字允许',async type=>{
 await saveDraft({...newDraft(type),markdown:'正文'},0);const {container,root}=await mountEditor();const title=container.querySelector<HTMLInputElement>('#draft-title')!;expect(title.maxLength).toBe(20);
 await inputTitle(container,'字'.repeat(20));expect(title.value).toHaveLength(20);
 await inputTitle(container,'字'.repeat(21));expect(title.value).toHaveLength(20);expect(container.textContent).toContain('超出的输入未加入标题');
 await inputTitle(container,'');await act(async()=>{const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{getData:()=> '字'.repeat(21)}});title.dispatchEvent(paste);});expect(title.value).toHaveLength(20);
 await act(async()=>root.unmount());container.remove();
});
it('中文组词期间不保存超长中间值，确认后限长；旧长标题完整显示且允许缩短',async()=>{
 const original=await saveDraft({...newDraft('post'),title:'字'.repeat(25),markdown:'正文'},0);const {container,root}=await mountEditor();const title=container.querySelector<HTMLInputElement>('#draft-title')!;expect(title.value).toHaveLength(25);expect(container.textContent).toContain('旧标题已完整保留');
 await inputTitle(container,'字'.repeat(24));expect(title.value).toHaveLength(24);await inputTitle(container,'字'.repeat(19));
 await act(async()=>title.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await inputTitle(container,'字'.repeat(19)+'中文');expect(title.value).toHaveLength(21);expect((await(await db()).get('drafts',original.id))?.title).toHaveLength(25);
 await act(async()=>title.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'})));expect(title.value).toHaveLength(20);await act(async()=>root.unmount());container.remove();
});

it('中间粘贴和组词限长保留既有标题尾部，emoji边界不产生半个字符',()=>{
 const original='甲'.repeat(10)+'乙'.repeat(9);expect(limitTitleEdit(original,'甲'.repeat(10)+'中文输入'+'乙'.repeat(9))).toBe('甲'.repeat(10)+'中'+'乙'.repeat(9));
 expect(limitTitleEdit('甲'.repeat(19),'甲'.repeat(19)+'😀')).toBe('甲'.repeat(19));expect(limitTitleEdit('','😀'.repeat(11))).toBe('😀'.repeat(10));
});
it('旧稿提醒只有一个可访问弹窗，Escape关闭后同一原因不轮流重复',async()=>{
 const draft=await saveDraft({...newDraft('post'),title:'提醒验收',markdown:'正文'},0);workspace.tasks=[2,1].map(createdAt=>({id:'issue-'+createdAt,batchId:'batch',platform:'zsxq',targetId:'12345',snapshot:draft,status:'failed',createdAt,updatedAt:createdAt,attemptId:'attempt',progress:'旧稿保留',error:{code:'EDITOR_OCCUPIED',message:'已有原稿',retrySafe:true}}));
 let view=await mountEditor();expect(view.container.querySelectorAll('[role=dialog]')).toHaveLength(1);expect(view.container.querySelector('.workspace')?.hasAttribute('inert')).toBe(true);expect(document.activeElement).toBe(view.container.querySelector('[data-primary]'));
 await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(view.container.querySelector('[role=dialog]')).toBeNull();expect(view.container.querySelector('.workspace')?.hasAttribute('inert')).toBe(false);
 await act(async()=>view.root.unmount());view.container.remove();view=await mountEditor();expect(view.container.querySelector('[role=dialog]')).toBeNull();await act(async()=>view.root.unmount());view.container.remove();
});
it('工作台合并变更通知，不再每2.5秒读取完整工作区',async()=>{
 await saveDraft({...newDraft('post'),title:'通知',markdown:'正文'},0);let listener:((message:{channel:string})=>void)|undefined;
 vi.stubGlobal('chrome',{runtime:{getURL:(p:string)=>'chrome-extension://test/'+p,onMessage:{addListener:(fn:typeof listener)=>listener=fn,removeListener:vi.fn()}}});
 const view=await mountEditor();const before=vi.mocked(api.workspace).mock.calls.length;vi.useFakeTimers();try{await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});expect(api.workspace).toHaveBeenCalledTimes(before);await act(async()=>{for(let i=0;i<20;i++)listener?.({channel:'ling-sync-changed'});await vi.advanceTimersByTimeAsync(100);});expect(api.workspace).toHaveBeenCalledTimes(before+1);}finally{await act(async()=>view.root.unmount());view.container.remove();vi.useRealTimers();}
});
it('主工作台与窄侧栏每条记录都有分钟时间及固定平台核查入口，取消任务不显示继续发布',async()=>{const draft=await saveDraft({...newDraft('post'),markdown:'记录'},0);workspace.tasks=[{id:'cancelled',batchId:'record',platform:'zsxq',targetId:'12345',snapshot:draft,status:'failed',operation:'publish',createdAt:new Date('2026-10-15T02:07:00Z').getTime(),updatedAt:1,attemptId:'attempt',tabId:1,proof:{bodyDigest:'proof',uploadedMediaIds:[]},progress:'已取消并恢复',error:{code:'CANCELLED_FOR_RESTORE',message:'已取消',retrySafe:false}}];const view=await mountEditor();await act(async()=>view.container.querySelector<HTMLButtonElement>('.records-toggle')!.click());expect(view.container.querySelector('.record-time')?.textContent).toMatch(/同步于.*\d{2}:\d{2}/);expect(view.container.querySelector('.record-row')?.textContent).toContain('打开知识星球');expect(view.container.querySelector('.record-row')?.textContent).not.toContain('继续发布');await act(async()=>view.root.render(createElement(App,{compact:true})));expect(view.container.querySelector('.record-row')?.textContent).toContain('打开知识星球');expect(view.container.querySelector('.record-row')?.textContent).toContain('同步于');await act(async()=>view.root.unmount());view.container.remove();});
it('正文粘贴图片与虚线框拖拽都进入附件，混合粘贴保留文字，普通文本粘贴不拦截',async()=>{const {File}=await import('node:buffer');const original=await saveDraft({...newDraft('post'),markdown:'原文'},0);const view=await mountEditor();const body=view.container.querySelector<HTMLTextAreaElement>('#draft-markdown')!;body.setSelectionRange(2,2);const file=(name:string)=>new File([Uint8Array.from([137,80,78,71,13,10,26,10])],name,{type:'image/png'});const paste=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(paste,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>file('pasted.png')}],getData:()=> '保留混合文字'}});await act(async()=>{body.dispatchEvent(paste);});await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});expect((await(await db()).get('drafts',original.id))?.media.map(m=>m.name)).toEqual(['pasted.png']);expect(view.container.querySelector<HTMLButtonElement>('.image-dropzone')?.disabled).toBe(false);});expect(paste.defaultPrevented).toBe(true);let saved=await(await db()).get('drafts',original.id);expect(saved?.markdown).toBe('原文保留混合文字');expect(saved?.media.map(m=>m.name)).toEqual(['pasted.png']);const normal=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(normal,'clipboardData',{value:{items:[],getData:()=> '普通文字'}});await act(async()=>body.dispatchEvent(normal));expect(normal.defaultPrevented).toBe(false);const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[file('dropped.png')],types:['Files']}});await act(async()=>{view.container.querySelector('.image-dropzone')!.dispatchEvent(drop);});await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});expect((await(await db()).get('drafts',original.id))?.media.map(m=>m.name)).toEqual(['pasted.png','dropped.png']);expect(view.container.querySelector<HTMLButtonElement>('.image-dropzone')?.disabled).toBe(false);});saved=await(await db()).get('drafts',original.id);expect(saved?.media.map(m=>m.name)).toEqual(['pasted.png','dropped.png']);expect(saved?.markdown).toBe('原文保留混合文字');await act(async()=>view.root.unmount());view.container.remove();});
it('超限先弹窗，选择前不入队；标签同样计数，明确选择通过接口传入',async()=>{const d=await saveDraft({...newDraft('post'),title:'长文',markdown:'字'.repeat(1001),tags:['标签']},0);workspace.platformSelections={post:['xiaohongshu','x'],article:[],video:[]};vi.mocked(api.startSync).mockResolvedValue([]);const view=await mountEditor();await act(async()=>view.container.querySelector<HTMLButtonElement>('.sync-action button')!.click());expect(api.startSync).not.toHaveBeenCalled();const dialog=view.container.querySelector('[role=dialog]')!;expect(dialog.textContent).toContain('部分平台文字超限');expect(dialog.textContent).toContain('1006 / 1000');expect(document.activeElement).toBe(dialog.querySelector('[data-first]'));await act(async()=>{[...dialog.querySelectorAll('button')].find(b=>b.textContent.includes('正文转图片后继续'))!.click();});expect(api.startSync).toHaveBeenCalledWith(d.id,['xiaohongshu','x'],[],'images');expect(view.container.querySelector('[role=dialog]')).toBeNull();await act(async()=>view.root.unmount());view.container.remove();});
it('新进入从空白动态开始，普通标签为空，固定标签保留；旧稿需手动加载',async()=>{
 const old=await saveDraft({...newDraft('post'),title:'过去的发布',markdown:'已发正文',tags:['只用于旧稿']},0);workspace.settings.fixedTags=['长期'];const container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(App)));
 expect(container.querySelector<HTMLInputElement>('#draft-title')?.value).toBe('');expect(container.querySelector<HTMLTextAreaElement>('#draft-markdown')?.value).toBe('');expect(container.querySelector<HTMLInputElement>('#draft-tags')?.value).toBe('');expect(container.querySelector<HTMLInputElement>('#fixed-tags')?.value).toBe('长期');await loadHistory(container);expect(container.querySelector<HTMLInputElement>('#draft-title')?.value).toBe(old.title);await act(async()=>root.unmount());container.remove();
});
it('备份恢复提醒不阻塞编辑，也不把已发布结果显示为失败',async()=>{
 const d=await saveDraft({...newDraft('post'),markdown:'已发'},0);workspace.tasks=[{id:'published-backup',batchId:'b',platform:'zsxq',targetId:'12345',snapshot:d,status:'published',operation:'publish',createdAt:1,updatedAt:1,attemptId:'a',progress:'已发布并核对',publicationAttemptedAt:1}];workspace.backups=[{id:'backup',taskId:'published-backup',targetId:'12345',tabId:7,url:'https://wx.zsxq.com/group/12345',createdAt:1,updatedAt:1,state:'restore_pending',note:'平台原稿待核对'}];const {container,root}=await mountEditor();expect(container.querySelector('.issue-dialog')).toBeNull();await act(async()=>container.querySelector<HTMLButtonElement>('.records-toggle')!.click());expect(container.textContent).toContain('已发布，原稿恢复待处理');expect(container.querySelector('.status-published')).not.toBeNull();await act(async()=>root.unmount());container.remove();
});

it('已确认恢复的备份不再显示恢复待处理，也不改变发布成功状态',async()=>{
 const d=await saveDraft({...newDraft('post'),markdown:'已发'},0);workspace.tasks=[{id:'restored-task',batchId:'b',platform:'zsxq',targetId:'12345',snapshot:d,status:'published',operation:'publish',createdAt:1,updatedAt:1,attemptId:'a',progress:'已发布并核对',publicationAttemptedAt:1}];workspace.backups=[{id:'restored-backup',taskId:'restored-task',targetId:'12345',tabId:7,url:'https://wx.zsxq.com/group/12345',createdAt:1,updatedAt:1,state:'restored'}];const {container,root}=await mountEditor();await act(async()=>container.querySelector<HTMLButtonElement>('.records-toggle')!.click());expect(container.textContent).not.toContain('原稿恢复待处理');expect(container.textContent).not.toContain('核对并恢复原稿');expect(container.querySelector('.status-published')).not.toBeNull();await act(async()=>root.unmount());container.remove();
});
it('知识星球备份冲突在批次中说明具体原因，不弹窗阻塞或重新发布',async()=>{
 const d=await saveDraft({...newDraft('post'),title:'备份冲突验收',markdown:'独立正文'},0);workspace.tasks=[{id:'backup-conflict',batchId:'b',platform:'zsxq',targetId:'12345',snapshot:d,status:'failed',operation:'publish',createdAt:1,updatedAt:1,attemptId:'a',progress:'未填写',error:{code:'BACKUP_PENDING',message:'有待核对的知识星球原稿备份；本次保留平台内容，不再次替换。',retrySafe:true}}];
 const {container,root}=await mountEditor();expect(container.querySelector('.batch-details')?.textContent).toContain('知识星球：有待核对的知识星球原稿备份');expect(container.querySelector('.batch-details')?.textContent).toContain('打开原任务');expect(container.querySelector('.issue-dialog')).toBeNull();expect(api.startSync).not.toHaveBeenCalled();await act(async()=>root.unmount());container.remove();
});
