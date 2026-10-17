import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {nativePostReady,activateNativePost} from '../src/platforms/native-post-entry';
import {fillProfile} from '../src/platforms/fill-profiles';
import {nativePublication,publicationFor} from '../src/platforms/publication';
import {nativeFillEditor} from '../src/platforms/native-fill-editor';
import {batchSummary} from '../src/core/post-routing';
import {FillAdapter} from '../src/platforms/fill-adapter';
import {newDraft} from '../src/core/model';
beforeEach(()=>{document.body.innerHTML='';vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as any);});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it.each(['douyin','kuaishou'] as const)('%s不将视频输入框当成图文已就绪，必须先切到图文入口',platform=>{
 const p=fillProfile(platform,'post')!;vi.stubGlobal('location',{origin:new URL(p.url).origin});document.body.innerHTML='<input type="file" accept="video/*,.mp4"><div role="tab">发布图文</div>';
 expect(nativePostReady(p).ready).toBe(false);const clicked=vi.fn();document.querySelector('[role=tab]')!.addEventListener('click',clicked);expect(activateNativePost({...p,entrySelector:'[role=tab]',entryLabels:['发布图文']})).toBe(true);expect(clicked).toHaveBeenCalledOnce();document.body.insertAdjacentHTML('beforeend','<input type="file" accept="image/png,image/jpeg" multiple><button>上传图片</button>');expect(nativePostReady(p).ready).toBe(true);
});
it('入口检测遍历同源iframe与Shadow DOM，隐藏的顶层字段不替代真实编辑器',()=>{
 const p={...fillProfile('channels','post')!,body:'.body',title:'.title'};vi.stubGlobal('location',{origin:'https://channels.weixin.qq.com'});document.body.innerHTML='<div id="host"></div>';
 const root=document.querySelector('#host')!.attachShadow({mode:'open'});root.innerHTML='<input class="title"><div class="body" contenteditable="true"></div>';
 expect(nativePostReady(p)).toMatchObject({ready:true,editorFound:true});
});
it('登录与验证在页面就绪之前单独识别',()=>{
 const p=fillProfile('x','post')!;vi.stubGlobal('location',{origin:'https://x.com'});document.body.innerHTML='<div>Sign in to X</div>';expect(nativePostReady(p)).toMatchObject({ready:false,login:'logged_out'});document.body.innerHTML='<div>请完成安全验证</div>';expect(nativePostReady(p).verification).toBe(true);
});
it('发布检查将目标页异常显式带回调用方；默认直接调用仍抛异常',async()=>{
 vi.stubGlobal('location',{origin:'https://web.okjike.com'});document.body.innerHTML='<div role="dialog"><form><div contenteditable="true" role="textbox">正文</div><button disabled>发送</button></form></div>';const p=publicationFor('jike','post')!,f=fillProfile('jike','post')!;const clicked=vi.fn();document.querySelector('button')!.onclick=clicked;
 await expect(nativePublication(p,'probe','',f)).rejects.toThrow('条件未满足');expect(await nativePublication(p,'probe','',f,'','',true)).toMatchObject({ready:false,error:expect.stringContaining('条件未满足')});expect(clicked).not.toHaveBeenCalled();
});
it('编辑器脚本异常不再被折叠成空回执，且不会重复写入',async()=>{
 vi.stubGlobal('location',{origin:'https://web.okjike.com'});document.body.innerHTML='<div role="dialog"><form><div contenteditable="true" role="textbox">原稿</div></form></div>';const p=fillProfile('jike','post')!,payload={title:'',text:'新正文',video:false,expectedImages:0};
 const r=await nativeFillEditor(p,'fill',payload,true);expect(r.error).toContain('其他内容');expect(document.querySelector('[contenteditable]')!.textContent).toBe('原稿');
});
it('异步输入采用连续只读回读，不再次调用fill或上传',async()=>{
 vi.stubGlobal('location',{origin:'https://web.okjike.com'});const a=new FillAdapter('jike');const t={platform:'jike',snapshot:newDraft('post')} as any;const read=vi.spyOn(a as any,'observe').mockResolvedValueOnce({editorFound:true,bodyMatched:false}).mockResolvedValue({editorFound:true,bodyMatched:true});vi.useFakeTimers();try{const p=(a as any).waitForFields(t,1,{editorFound:true,bodyMatched:false});await vi.advanceTimersByTimeAsync(1000);expect((await p).bodyMatched).toBe(true);expect(read.mock.calls.every(c=>c[2]==='read')).toBe(true);}finally{vi.useRealTimers();}
});
it('九项全部停止后结束运行，处理数与五种结果数量分开',()=>{
 const statuses=['failed','failed','failed','failed','failed','failed','unknown','unknown','unknown'];expect(batchSummary(statuses.map(status=>({status:status as any})))).toMatchObject({done:true,running:0,completed:9,counts:{filled:0,submitted:0,published:0,failed:6,unknown:3}});
});
it('富文本段落与emoji采用语义换行回读，不受段落样式空行影响',async()=>{
 vi.stubGlobal('location',{origin:'https://creator.xiaohongshu.com'});document.body.innerHTML='<div class="publish-page"><input placeholder="填写标题会有更多赞哦" value="标题"><div class="tiptap ProseMirror" contenteditable="true"><p>第一行</p><p>第二行<img alt="🙂"></p><p><br></p><p>#标签</p></div></div>';
 const r=await nativeFillEditor(fillProfile('xiaohongshu','post')!,'read',{title:'标题',text:'第一行\n第二行🙂\n\n#标签',video:false,expectedImages:0});expect(r.bodyMatched).toBe(true);expect(r.body).toBe('第一行\n第二行🙂\n\n#标签');
});
it('B站空占位符通过原生粘贴完整替换，不遗留未纳入平台模型的DOM节点',async()=>{
 vi.stubGlobal('location',{origin:'https://t.bilibili.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">\u200b</div></form>';const body=document.querySelector('.body')!;const input=vi.fn();body.addEventListener('input',input);
 vi.stubGlobal('DataTransfer',class{data:Record<string,string>={};setData(k:string,v:string){this.data[k]=v;}getData(k:string){return this.data[k]||'';}});vi.stubGlobal('ClipboardEvent',class extends Event{clipboardData:any;constructor(n:string,i:any){super(n,i);this.clipboardData=i.clipboardData;}});
 body.addEventListener('paste',e=>{e.preventDefault();body.textContent=(e as ClipboardEvent).clipboardData!.getData('text/plain');});const p={...fillProfile('bilibili','post')!,body:'.body',title:undefined,scope:'form'};const r=await nativeFillEditor(p,'fill',{title:'',text:'第一行\n第二行🙂',video:false,expectedImages:0});expect(r.bodyMatched).toBe(true);expect(body.textContent).toBe('第一行\n第二行🙂');expect(input).not.toHaveBeenCalled();
});
it('B站首个文本节点已有换行时不再为相邻DIV重复添加换行',async()=>{
 vi.stubGlobal('location',{origin:'https://t.bilibili.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">\u200b第一行\n<div>第二行🙂</div><div><br></div><div>#标签</div></div></form>';const p={...fillProfile('bilibili','post')!,body:'.body',title:undefined,scope:'form'};expect((await nativeFillEditor(p,'read',{title:'',text:'第一行\n第二行🙂\n\n#标签',video:false,expectedImages:0})).bodyMatched).toBe(true);
});
it.each([true,false])('X仅在工作台仍为当前页时短暂激活，其他页面不抢焦点：%s',async sourceActive=>{
 let activated=false,polls=0;const update=vi.fn(async(id:number)=>{activated=id===7;return {id};});vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async(id:number)=>id===2?{id:2,active:sourceActive}:{id:7,url:'https://x.com/compose/post',status:'complete'},query:async()=>[{id:7}],update},scripting:{executeScript:async()=>[{result:{ready:activated||++polls>16}}]}});vi.useFakeTimers();try{const task={id:crypto.randomUUID(),platform:'x',snapshot:newDraft('post'),tabId:7,source:{tabId:2,windowId:1}} as any;const pending=new FillAdapter('x').openEditor(task);await vi.advanceTimersByTimeAsync(5000);expect(await pending).toBe(7);expect(update.mock.calls.map(c=>c[0])).toEqual(sourceActive?[7,2]:[]);}finally{vi.useRealTimers();}
});
it.each([false,true])('B站只在未交付且没有附件时有限等待按钮监听就绪：已有附件=%s',async existing=>{
 const {db,saveDraft,enqueue,updateTask}=await import('../src/core/repository');const {Blob}=await import('node:buffer');const d=await db();for(const s of d.objectStoreNames)await d.clear(s);const seed=newDraft('post'),ref={id:crypto.randomUUID(),name:'one.png',kind:'image' as const,mime:'image/png' as const,bytes:3};await d.put('media',{...ref,draftId:seed.id,blob:new Blob(['png']) as globalThis.Blob});const draft=await saveDraft({...seed,markdown:'正文',media:[ref]},0);const queued=await enqueue(draft,'bilibili','','picker',false,'fill');const task=await updateTask(queued.id,['queued'],{status:'preparing'});let calls=0;const send=vi.fn(async()=>({ok:true}));vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({url:'https://t.bilibili.com/'}),sendMessage:send},scripting:{executeScript:async(o:any)=>o.func?[{result:++calls===1?{ready:false,error:'B站正常图片按钮未产生唯一文件选择器'}:{ready:true,accept:'image/png',multiple:true}}]:[{}]}});const a=new FillAdapter('bilibili');vi.spyOn(a as any,'native').mockResolvedValue({images:existing?['other']:[],imageItems:existing?1:0});
 if(existing){await expect((a as any).uploadImagesBatch(task,7)).rejects.toMatchObject({code:'MEDIA_IDENTITY'});expect(send).not.toHaveBeenCalled();expect(calls).toBe(1);}else{await(a as any).uploadImagesBatch(task,7);expect(calls).toBe(2);expect(send.mock.calls.filter(c=>(c as any)[1]?.action==='commit_batch')).toHaveLength(1);}
});
it('B站原生http图片仅对固定hdslb图片域名规范为https，其他http来源不认领',async()=>{
 vi.stubGlobal('location',{origin:'https://t.bilibili.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">正文</div><div class="preview" style="background-image:url(http://i0.hdslb.com/bfs/new_dyn/asset.png)"></div></form>';const p={...fillProfile('bilibili','post')!,body:'.body',title:undefined,scope:'form',backgroundImagesSelector:'.preview'};const payload={title:'',text:'正文',video:false,expectedImages:1};expect((await nativeFillEditor(p,'read',payload)).images).toEqual(['https://i0.hdslb.com/bfs/new_dyn/asset.png']);(document.querySelector('.preview') as HTMLElement).style.backgroundImage='url(http://other.test/asset.png)';expect((await nativeFillEditor(p,'read',payload)).images).toEqual([]);
});
it('公众号两个loading.gif占位符不能冒认两张上传图片',async()=>{
 vi.stubGlobal('location',{origin:'https://mp.weixin.qq.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">正文</div><div class="item" style="background-image:url(https://res.wx.qq.com/loading.gif)"></div><div class="item" style="background-image:url(https://res.wx.qq.com/loading.gif)"></div></form>';const p={...fillProfile('weixin','post')!,body:'.body',title:undefined,scope:'form',backgroundImagesSelector:'.item',imageItemsSelector:'.item'};const payload={title:'',text:'正文',video:false,expectedImages:2};const r=await nativeFillEditor(p,'read',payload);expect(r.imageItems).toBe(2);expect(r.images).toEqual([]);expect(r.remoteMediaReady).toBe(false);expect(r.uploadBusy).toBe(true);(document.querySelector('.item') as HTMLElement).style.backgroundImage='url(https://mmbiz.qpic.cn/mmbiz_png/actual/0)';expect((await nativeFillEditor(p,'read',payload)).images).toHaveLength(1);
});
it('视频号微前端初始化的已知临时中断只等待，不冒认字段就绪',async()=>{
 let calls=0;vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{get:async()=>({id:7,url:'https://channels.weixin.qq.com/platform/post/finderNewLifeCreate',status:'complete'})},scripting:{executeScript:async()=>[{result:++calls===1?{ready:false,error:'此报错可以忽略，iframe主动中断主应用代码在子应用运行'}:{ready:true}}]}});vi.useFakeTimers();try{const pending=new FillAdapter('channels').openEditor({platform:'channels',snapshot:newDraft('post'),tabId:7} as any);await vi.advanceTimersByTimeAsync(1000);expect(await pending).toBe(7);expect(calls).toBe(2);}finally{vi.useRealTimers();}
});
it('X四图DOM按列排列时按视觉行序核对，真实换位仍反映在结果中',async()=>{
 vi.stubGlobal('location',{origin:'https://x.com'});document.body.innerHTML='<form><div class="body" contenteditable="true">正文</div><div class="pictures"><img id="one" src="https://cdn.test/1"><img id="three" src="https://cdn.test/3"><img id="two" src="https://cdn.test/2"><img id="four" src="https://cdn.test/4"></div></form>';const positions:Record<string,[number,number]>={one:[0,0],two:[100,0],three:[0,100],four:[100,100]};for(const img of document.querySelectorAll<HTMLImageElement>('img'))img.getBoundingClientRect=()=>({top:positions[img.id]![1],left:positions[img.id]![0]}) as DOMRect;const p={...fillProfile('x','post')!,body:'.body',scope:'form',imagesSelector:'.pictures img'};const payload={title:'',text:'正文',video:false,expectedImages:4};expect((await nativeFillEditor(p,'read',payload)).images).toEqual([1,2,3,4].map(i=>'https://cdn.test/'+i));positions.two=[0,0];positions.one=[100,0];expect((await nativeFillEditor(p,'read',payload)).images.slice(0,2)).toEqual(['https://cdn.test/2','https://cdn.test/1']);
});

it('快手视频页的封面图片输入不能替代正常图文上传入口',()=>{const p=fillProfile('kuaishou','post')!;vi.stubGlobal('location',{origin:'https://cp.kuaishou.com'});document.body.innerHTML='<input type="file" accept="video/*"><input type="file" accept="image/png"><div role="tab">上传图文</div>';expect(nativePostReady(p).ready).toBe(false);});
it('图文首批交付前只读等待，延迟恢复的图片占位项出现后立即停止',async()=>{
 const a=new FillAdapter('kuaishou');const empty={uploadInputReady:true,hasVideoMedia:false,login:'connected',images:[],imageItems:0,body:'',title:'',bodyMatched:false,uploadBusy:false};const read=vi.spyOn(a as any,'native').mockResolvedValueOnce(empty).mockResolvedValue({...empty,imageItems:1});const upload=vi.spyOn(a as any,'uploadImagesBatch');vi.useFakeTimers();try{const pending=expect(a.fillEditor({platform:'kuaishou',snapshot:{...newDraft('post'),markdown:'正文',media:[]}} as any,7)).rejects.toMatchObject({code:'MEDIA_IDENTITY'});await vi.advanceTimersByTimeAsync(500);await pending;expect(upload).not.toHaveBeenCalled();expect(read.mock.calls.every(c=>c[2]==='read')).toBe(true);}finally{vi.useRealTimers();}
});

it('即刻创建入口按可访问名称匹配，隐藏的移动端同名按钮不参与',async()=>{
 const {activateNativePost}=await import('../src/platforms/native-post-entry');vi.stubGlobal('location',{origin:'https://web.okjike.com'});document.body.innerHTML='<button aria-label="创建动态" hidden></button><button aria-label="创建动态"><svg></svg></button>';const buttons=document.querySelectorAll('button'),clicked=vi.fn();buttons[0]!.getClientRects=()=>({length:0}) as DOMRectList;buttons[1]!.onclick=clicked;expect(activateNativePost(fillProfile('jike','post')!)).toBe(true);expect(clicked).toHaveBeenCalledOnce();
});

it('小红书即使焦点已离开正文也用正常Escape关闭话题弹层，未关闭时不误认就绪',async()=>{
 const {nativeXhsSuggestions}=await import('../src/platforms/native-post-entry');vi.stubGlobal('location',{origin:'https://creator.xiaohongshu.com'});document.body.innerHTML='<div class="publish-page"><div class="tiptap" contenteditable="true">正文</div></div><div role="tooltip">话题建议</div>';
 expect(nativeXhsSuggestions('check').ready).toBe(false);const body=document.querySelector<HTMLElement>('.tiptap')!,key=vi.fn((e:Event)=>{expect((e as KeyboardEvent).key).toBe('Escape');document.querySelector('[role=tooltip]')?.remove();});body.addEventListener('keydown',key);expect(nativeXhsSuggestions('dismiss').ready).toBe(true);expect(key).toHaveBeenCalledOnce();expect(body.textContent).toBe('正文');
});
