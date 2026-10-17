import {expect,it,vi} from 'vitest';
import {nativeFillEditor} from '../src/platforms/native-fill-editor';
import type {FillProfile} from '../src/platforms/fill-profiles';
const profile:FillProfile={platform:'jike',type:'post',url:location.origin+'/',body:'[contenteditable=true]',title:'input',scope:'form',note:'internal fixture'};
it('小红书text/plain预览按PNG签名识别，任意文本和缺失标题不冒认就绪',async()=>{
 const {Blob}=await import('node:buffer');const {webcrypto}=await import('node:crypto');const {vi}=await import('vitest');vi.stubGlobal('crypto',webcrypto);
 try{let blob=new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,0,1])],{type:'text/plain'});vi.stubGlobal('fetch',async()=>({blob:async()=>blob}));fixture(`<form><input value="标题"><div contenteditable="true">正文</div><img src="blob:${location.origin}/one"></form>`);
 const xhs={...profile,platform:'xiaohongshu' as const};const payload={title:'标题',text:'正文',video:false,expectedImages:1};expect((await nativeFillEditor(xhs,'read',payload)).images[0]).toMatch(/^blob-sha256:/);
 expect((await nativeFillEditor(profile,'read',payload)).images).toEqual([]);blob=new Blob(['not an image'],{type:'text/plain'});expect((await nativeFillEditor(xhs,'read',payload)).images).toEqual([]);
 document.querySelector('input')!.remove();expect((await nativeFillEditor(xhs,'read',payload)).editorFound).toBe(false);await expect(nativeFillEditor(xhs,'fill',payload)).rejects.toThrow('标题编辑器');
 }finally{vi.unstubAllGlobals();}
});
function fixture(html:string){document.body.innerHTML=html;for(const e of document.querySelectorAll<HTMLElement>('*')){e.getClientRects=()=>({length:1}) as DOMRectList;}}
it('既有内容或多义字段不能被填写流程覆盖',async()=>{
  const payload={title:'测试',text:'新正文',video:false,expectedImages:0};fixture('<form><input value="其他标题"><div contenteditable="true">已有正文</div></form>');
  await expect(nativeFillEditor(profile,'fill',payload)).rejects.toThrow('已有其他内容');expect(document.querySelector('input')!.value).toBe('其他标题');
  fixture('<form><input><div contenteditable="true"></div><div contenteditable="true"></div></form>');await expect(nativeFillEditor(profile,'fill',payload)).rejects.toThrow('字段不唯一');expect(document.querySelector('input')!.value).toBe('');
});
it('相同正文可回读，不把填写当成草稿保存',async()=>{
  fixture('<form><input value="标题"><div contenteditable="true">正文</div></form>');const read=await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:0});expect(read.bodyMatched).toBe(true);expect(read.editorFound).toBe(true);expect(read.videoReady).toBe(false);
});
it('转码中与同名文件不能伪造视频处理成功或资产身份',async()=>{
  fixture('<form><input value="标题"><div contenteditable="true">正文</div><p role="status">video.mp4 正在转码 更换视频</p><video src="https://cdn.test/asset-a.mp4"></video></form>');
  const videoProfile={...profile,type:'video' as const,videoReady:'上传成功|上传完成'};
  const payload={title:'标题',text:'正文',video:true,expectedImages:0,videoName:'video.mp4',videoBytes:8};
  expect((await nativeFillEditor(videoProfile,'read',payload)).videoReady).toBe(false);
  document.querySelector('p')!.textContent='video.mp4 上传完成';const ready=await nativeFillEditor(videoProfile,'read',payload);expect(ready.videoReady).toBe(true);expect(ready.videoIdentity).toBe('https://cdn.test/asset-a.mp4');
  document.querySelector('video')!.src='https://cdn.test/asset-b.mp4';expect((await nativeFillEditor(videoProfile,'read',payload)).videoIdentity).not.toBe(ready.videoIdentity);
});
it('Shadow DOM中的正文与标题能回读，作用域不误取页面上的头像',async()=>{
 document.body.innerHTML='<img src="https://cdn.test/avatar.png"><div id="host"></div>';const shadow=document.querySelector('#host')!.attachShadow({mode:'open'});shadow.innerHTML='<form><input value="标题"><div contenteditable="true">正文</div><img src="https://cdn.test/attachment.png"></form>';
 for(const e of shadow.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 const read=await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:1});expect(read.bodyMatched).toBe(true);expect(read.images).toEqual(['https://cdn.test/attachment.png']);
});
it('用户正文中的上传完成字样不能冒充平台上传状态',async()=>{
 fixture('<form><input value="标题"><div contenteditable="true">video.mp4 上传完成</div><video src="https://cdn.test/video.mp4"></video></form>');
 const r=await nativeFillEditor({...profile,type:'video',videoReady:'上传完成'},'read',{title:'标题',text:'video.mp4 上传完成',video:true,expectedImages:0,videoName:'video.mp4',videoBytes:8});expect(r.bodyMatched).toBe(true);expect(r.videoReady).toBe(false);expect(r.notice).toBeUndefined();
});
it('同源图片Blob按内容核对且保留顺序，不把预览误当远程上传',async()=>{
 const {Blob}=await import('node:buffer');const {webcrypto}=await import('node:crypto');const {vi}=await import('vitest');vi.stubGlobal('crypto',webcrypto);
 const first=new Blob(['first'],{type:'image/png'}),second=new Blob(['second'],{type:'image/png'});vi.stubGlobal('fetch',vi.fn(async(url:string)=>({blob:async()=>url.endsWith('/one')?first:second})));
 fixture(`<form><input value="标题"><div contenteditable="true">正文</div><img src="blob:${location.origin}/one"><img src="blob:${location.origin}/two"></form>`);
 const read=await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:2});expect(read.images).toHaveLength(2);expect(read.images[0]).toMatch(/^blob-sha256:[a-f0-9]{64}$/);expect(read.images[0]).not.toBe(read.images[1]);
 document.querySelector('form')!.appendChild(document.querySelector('img')!);expect((await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:2})).images).toEqual([...read.images].reverse());vi.unstubAllGlobals();
});
it('抖音完成路由和可播放远程视频只在本任务上传记录存在时成立',async()=>{
 history.replaceState(null,'','/creator-micro/content/post/video');fixture('<form><input value="标题"><div contenteditable="true">正文</div><video src="https://video-cn.douyin.com/asset"></video></form>');const video=document.querySelector('video')!;Object.defineProperty(video,'readyState',{value:4});Object.defineProperty(video,'duration',{value:5});
 const p={...profile,type:'video' as const,processedRoute:'/creator-micro/content/post/video',processedVideoOrigin:'https://video-cn.douyin.com'};const payload={title:'标题',text:'正文',video:true,expectedImages:0,ownedVideoUpload:false};expect((await nativeFillEditor(p,'read',payload)).videoReady).toBe(false);expect((await nativeFillEditor(p,'read',{...payload,ownedVideoUpload:true})).videoReady).toBe(true);history.replaceState(null,'','/');
});

it('富文本空占位符不当成用户正文，真实正文仍受保护',async()=>{
 fixture('<form><input><div contenteditable="true">\u200b</div><input type="file" accept="video/mp4"></form>');
 const r=await nativeFillEditor({...profile,title:'input:not([type=file])'},'read',{title:'',text:'',video:true,expectedImages:0});expect(r.body).toBe('');expect(r.uploadInputReady).toBe(true);
 document.querySelector('[contenteditable]')!.textContent='已有正文\u200b';await expect(nativeFillEditor({...profile,title:'input:not([type=file])'},'fill',{title:'新标题',text:'新正文',video:true,expectedImages:0})).rejects.toThrow('已有其他内容');
});
it('快手本地视频按96KiB分块核对，大小或内容变化不能冒充同一附件',async()=>{
 const {Blob}=await import('node:buffer');const {webcrypto}=await import('node:crypto');const {vi}=await import('vitest');vi.stubGlobal('crypto',webcrypto);let bytes=new Uint8Array(100000).fill(7);vi.stubGlobal('fetch',vi.fn(async()=>({blob:async()=>new Blob([bytes],{type:'text/plain'})})));
 fixture(`<form><input value="标题"><div contenteditable="true">正文</div><video src="blob:${location.origin}/asset"></video></form>`);const video=document.querySelector('video')!;Object.defineProperty(video,'readyState',{value:4});Object.defineProperty(video,'duration',{value:5});
 const p={...profile,type:'video' as const,localVideoPreview:true};const payload={title:'标题',text:'正文',video:true,expectedImages:0,ownedVideoUpload:true,videoBytes:100000};const first=await nativeFillEditor(p,'read',payload);expect(first.videoReady).toBe(true);expect(first.videoIdentity).toMatch(/^blob-video-chain256:100000:[a-f0-9]{64}$/);bytes=bytes.slice();bytes[99999]=8;expect((await nativeFillEditor(p,'read',payload)).videoIdentity).not.toBe(first.videoIdentity);expect((await nativeFillEditor(p,'read',{...payload,videoBytes:99999})).videoReady).toBe(false);expect((await nativeFillEditor(p,'read',{...payload,ownedVideoUpload:false})).videoReady).toBe(false);vi.unstubAllGlobals();
});

it('平台富文本生成的额外空行不导致相同段落回读失败',async()=>{
 fixture('<form><input value="标题"><div contenteditable="true">标题\n\n\n正文</div></form>');const r=await nativeFillEditor(profile,'read',{title:'标题',text:'标题\n\n正文',video:false,expectedImages:0});expect(r.bodyMatched).toBe(true);expect(r.body).toBe('标题\n\n正文');
});
it('微前端多条DOM路径返回同一对象时去重，不放过真正不同的字段',async()=>{
 const {vi}=await import('vitest');fixture('<form><input value="标题"><div contenteditable="true">正文</div></form>');const original=document.querySelectorAll.bind(document);const same=document.querySelector('[contenteditable=true]')!;const spy=vi.spyOn(document,'querySelectorAll').mockImplementation((selector:string)=>selector==='[contenteditable=true]'?[same,same] as unknown as NodeListOf<Element>:original(selector));
 expect((await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:0})).bodyMatched).toBe(true);spy.mockRestore();
});
it('B站只在唯一上传列表回执与原生完整文件匹配时核对，默认文件名标题可替换',async()=>{
 const {File}=await import('node:buffer');fixture('<form><input value="asset" type="text"><div contenteditable="true"></div><div class="bcc-upload-wrapper"><input type="file"></div><div class="upload-queue"><div class="file-item"><span class="title-text">asset</span><div class="file-item-content-status-text"><span class="success">上传完成</span></div></div></div></form>');const f=new File(['video-data'], 'asset.mp4',{type:'video/mp4'});Object.defineProperty(document.querySelector('input[type=file]'),'files',{value:[f]});
 const p={...profile,title:'input[type=text]',type:'video' as const,fileVideoReceipt:true,autoTitleFromFilename:true};const data={title:'新标题',text:'',video:true,expectedImages:0,ownedVideoUpload:true,videoName:'asset.mp4',videoBytes:10};expect((await nativeFillEditor(p,'read',data)).videoReady).toBe(true);expect((await nativeFillEditor(p,'read',{...data,ownedVideoUpload:false})).videoReady).toBe(false);document.querySelector('.success')!.textContent='上传中';expect((await nativeFillEditor(p,'read',data)).videoReady).toBe(false);
});
it('X发帖弹窗不读取主页编辑器或账号头像作为任务正文和附件',async()=>{
 fixture('<div contenteditable="true" data-testid="tweetTextarea_0">主页其他内容</div><div role="dialog" aria-modal="true"><img src="https://cdn.test/avatar.png"><div contenteditable="true" data-testid="tweetTextarea_0">测试动态</div><div data-testid="attachments"><img src="https://cdn.test/selected.png"></div></div><div role="dialog" aria-modal="true"><img src="https://cdn.test/widget.png"></div>');
 const p={...profile,title:undefined,body:'div[role="dialog"][aria-modal="true"] div[data-testid="tweetTextarea_0"][contenteditable="true"]',scope:'div[role="dialog"][aria-modal="true"]',imagesSelector:'div[data-testid="attachments"] img'};const r=await nativeFillEditor(p,'read',{title:'',text:'测试动态',video:false,expectedImages:1});expect(r.bodyMatched).toBe(true);expect(r.images).toEqual(['https://cdn.test/selected.png']);
});
it('视频号图文只按双图预览回读，排除头像与重复缩略图',async()=>{
 const {fillProfile}=await import('../src/platforms/fill-profiles');const p={...fillProfile('channels','post')!,url:location.origin+'/'};fixture('<input placeholder="填写标题, 22个字符内" value="图文"><div data-placeholder="添加描述, 1000个字符内">正文</div><img src="https://cdn.test/avatar.png"><div class="common-slider"><img class="slider-img" src="https://cdn.test/one.png"><img class="slider-img" src="https://cdn.test/two.png"></div><img src="https://cdn.test/one.png">');const r=await nativeFillEditor(p,'read',{title:'图文',text:'正文',video:false,expectedImages:2});expect(r.bodyMatched).toBe(true);expect(r.title).toBe('图文');expect(r.images).toEqual(['https://cdn.test/one.png','https://cdn.test/two.png']);
});
it('动态图片data预览按字节摘要核对，不接受任意data协议内容',async()=>{
 const {Blob}=await import('node:buffer');const {webcrypto}=await import('node:crypto');const {vi}=await import('vitest');vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('fetch',vi.fn(async()=>({blob:async()=>new Blob(['image-bytes'],{type:'image/png'})})));fixture('<form><input value="标题"><div contenteditable="true">正文</div><img src="data:image/png;base64,aW1hZ2UtYnl0ZXM="><img src="data:text/html;base64,PHNjcmlwdD4="></form>');const r=await nativeFillEditor(profile,'read',{title:'标题',text:'正文',video:false,expectedImages:1});expect(r.images).toHaveLength(1);expect(r.images[0]).toMatch(/^data-sha256:[a-f0-9]{64}$/);vi.unstubAllGlobals();
});
it('知识星球动态切换到其他星球后不能填写',async()=>{
 const {fillProfile}=await import('../src/platforms/fill-profiles');history.replaceState(null,'','/group/12345');fixture('<div class="create-topic-panel"><div class="ql-editor" contenteditable="true"></div></div>');const p={...fillProfile('zsxq','post')!,url:location.origin+'/'};await expect(nativeFillEditor(p,'fill',{title:'',text:'正文',video:false,expectedImages:0,targetId:'67890'})).rejects.toThrow('目标星球已变化');expect(document.querySelector('.ql-editor')!.textContent).toBe('');history.replaceState(null,'','/');
});
it('星球Quill段落按结构回读，空段保留而单换行不被浏览器扩成双换行',async()=>{
 const {fillProfile}=await import('../src/platforms/fill-profiles');history.replaceState(null,'','/group/12345');fixture('<div class="create-topic-panel"><div class="ql-editor" contenteditable="true"><p>标题</p><p><br></p><p>正文第一行</p><p>第二行</p></div></div>');const p={...fillProfile('zsxq','post')!,url:location.origin+'/'};const args={title:'标题',text:'标题\n\n正文第一行\n第二行',video:false,expectedImages:0,targetId:'12345'};expect((await nativeFillEditor(p,'read',args)).bodyMatched).toBe(true);expect((await nativeFillEditor(p,'read',{...args,text:args.text+'不同内容'})).bodyMatched).toBe(false);history.replaceState(null,'','/');
});
it('快手占位图片项也计数，未加载缩略图不能隐藏平台额外附件',async()=>{
 fixture('<form><input value="标题"><div contenteditable="true">正文</div><div class="_upload-item_live"><img src="https://cdn.test/one.png"></div><div class="_upload-item_live"><img src="https://cdn.test/two.png"></div><div class="_upload-item_live"><span>上传中</span></div></form>');const r=await nativeFillEditor({...profile,imageItemsSelector:'div[class*="_upload-item_"]',imagesSelector:'div[class*="_upload-item_"] > img'},'read',{title:'标题',text:'正文',video:false,expectedImages:2});expect(r.images).toHaveLength(2);expect(r.imageItems).toBe(3);
});
it('晚到抖音视频的尺寸时长必须与原上传元数据一致',async()=>{
 history.replaceState(null,'','/creator-micro/content/post/video');fixture('<form><input><div contenteditable="true"></div><video src="https://video-cn.douyin.com/asset"></video></form>');const video=document.querySelector('video')!;for(const [key,value] of Object.entries({readyState:4,duration:5,videoWidth:720,videoHeight:1280}))Object.defineProperty(video,key,{value});const p={...profile,type:'video' as const,processedRoute:'/creator-micro/content/post/video',processedVideoOrigin:'https://video-cn.douyin.com'};const data={title:'',text:'',video:true,expectedImages:0,ownedVideoUpload:true,expectedVideoDuration:5,expectedVideoWidth:720,expectedVideoHeight:1280};expect((await nativeFillEditor(p,'read',data)).videoReady).toBe(true);expect((await nativeFillEditor(p,'read',{...data,expectedVideoDuration:10})).videoReady).toBe(false);expect((await nativeFillEditor(p,'read',{...data,expectedVideoWidth:1920})).videoReady).toBe(false);history.replaceState(null,'','/');
});
it('公众号贴图从有序缩略图背景读取，忽略当前预览与账号头像',async()=>{
 fixture('<form><input value="标题"><div contenteditable="true">正文</div><img src="https://cdn.test/avatar.png"><div class="image-selector"><img src="https://cdn.test/two.png"><div class="image-selector__bottom-list-item" style="background-image:url(https://cdn.test/one.png)"></div><div class="image-selector__bottom-list-item" style="background-image:url(https://cdn.test/two.png)"></div></div></form>');
 const p={...profile,backgroundImagesSelector:'.image-selector__bottom-list-item',imageItemsSelector:'.image-selector__bottom-list-item'};const r=await nativeFillEditor(p,'read',{title:'标题',text:'正文',video:false,expectedImages:2});expect(r.images).toEqual(['https://cdn.test/one.png','https://cdn.test/two.png']);expect(r.imageItems).toBe(2);
});
it('公众号空贴图描述占位组件不当作旧稿，真实段落仍完整回读',async()=>{
 fixture('<form><input value=""><div contenteditable="true"><span class="editor_placeholder" contenteditable="false">填写描述信息，让大家了解更多内容</span><img class="ProseMirror-separator"><br></div></form>');const p={...profile,platform:'weixin' as const};expect((await nativeFillEditor(p,'read',{title:'',text:'',video:false,expectedImages:0})).body).toBe('');document.querySelector('[contenteditable=true]')!.innerHTML='<p>第一段</p><p>第二段</p>';expect((await nativeFillEditor(p,'read',{title:'',text:'第一段\n第二段',video:false,expectedImages:0})).bodyMatched).toBe(true);
});
it('知识星球原生段落HTML保留空行，只有原生命令的input，不额外合成input或隐藏粘贴',async()=>{
 const {fillProfile}=await import('../src/platforms/fill-profiles');vi.stubGlobal('location',{origin:'https://wx.zsxq.com',pathname:'/group/12345'});fixture('<div class="create-topic-panel"><div class="ql-editor" contenteditable="true"></div><button disabled>发布</button></div>');const body=document.querySelector<HTMLElement>('.ql-editor')!;const paste=vi.fn();const input=vi.fn();body.addEventListener('paste',paste);body.addEventListener('input',input);const command=vi.fn((_cmd:string,_ui:boolean,value:string)=>{body.innerHTML=value;body.dispatchEvent(new Event('input',{bubbles:true}));return true;});Object.defineProperty(document,'execCommand',{configurable:true,writable:true,value:command});
 const r=await nativeFillEditor(fillProfile('zsxq','post')!,'fill',{title:'',text:'正文\n\n标签',video:false,expectedImages:0,targetId:'12345'});expect(r.bodyMatched).toBe(true);expect(command).toHaveBeenCalledWith('insertHTML',false,'<p>正文</p><p><br></p><p>标签</p>');expect(paste).not.toHaveBeenCalled();expect(input).toHaveBeenCalledTimes(1);vi.unstubAllGlobals();
});
it('B站多段正文必须由原生paste处理，拒绝仅有DOM文字的假填写',async()=>{
 const bili={...profile,platform:'bilibili' as const,title:undefined};fixture('<form><div contenteditable="true"></div></form>');const body=document.querySelector<HTMLElement>('[contenteditable]')!;const insert=vi.fn();Object.defineProperty(document,'execCommand',{configurable:true,writable:true,value:insert});
 const clipboard=class{data:Record<string,string>={};setData(k:string,v:string){this.data[k]=v;}getData(k:string){return this.data[k]||'';}};vi.stubGlobal('DataTransfer',clipboard);vi.stubGlobal('ClipboardEvent',class extends Event{clipboardData:any;constructor(name:string,init:any){super(name,init);this.clipboardData=init.clipboardData;}});
 const expected='第一段\n\n第二段\n#标签';const payload={title:'',text:expected,video:false,expectedImages:0};try{await expect(nativeFillEditor(bili,'fill',payload)).rejects.toThrow('原生粘贴未接收');expect(insert).not.toHaveBeenCalled();body.addEventListener('paste',e=>{e.preventDefault();body.textContent=(e as ClipboardEvent).clipboardData!.getData('text/plain');});expect((await nativeFillEditor(bili,'fill',payload)).bodyMatched).toBe(true);expect(body.textContent).toBe(expected);expect(insert).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
});
it('小红书标题使用原生输入命令而非仅赋值，未接收时阻止继续',async()=>{
 const xhs={...profile,platform:'xiaohongshu' as const};fixture('<form><input><div contenteditable="true">正文</div></form>');const input=document.querySelector<HTMLInputElement>('input')!;const command=vi.fn((_cmd:string,_ui:boolean,value:string)=>{input.value=value;return true;});Object.defineProperty(document,'execCommand',{configurable:true,writable:true,value:command});expect((await nativeFillEditor(xhs,'fill',{title:'原生标题',text:'正文',video:false,expectedImages:0})).title).toBe('原生标题');expect(command).toHaveBeenCalledWith('insertText',false,'原生标题');input.value='';command.mockReturnValueOnce(false);await expect(nativeFillEditor(xhs,'fill',{title:'未接收',text:'正文',video:false,expectedImages:0})).rejects.toThrow('原生标题输入未接收');
});
it('B站填写标题引起正文节点重建时，对新节点交付完整正文',async()=>{
 const bili={...profile,platform:'bilibili' as const};fixture('<form><input><div contenteditable="true"></div></form>');
 const oldBody=document.querySelector<HTMLElement>('[contenteditable]')!;const pasted=vi.fn();
 document.querySelector('input')!.addEventListener('input',()=>{queueMicrotask(()=>{
  const next=oldBody.cloneNode(false) as HTMLElement;next.getClientRects=()=>({length:1}) as DOMRectList;
  next.addEventListener('paste',event=>{event.preventDefault();pasted();next.textContent=(event as ClipboardEvent).clipboardData!.getData('text/plain');});oldBody.replaceWith(next);
 });},{once:true});
 const clipboard=class{data:Record<string,string>={};setData(k:string,v:string){this.data[k]=v;}getData(k:string){return this.data[k]||'';}};
 vi.stubGlobal('DataTransfer',clipboard);vi.stubGlobal('ClipboardEvent',class extends Event{clipboardData:any;constructor(name:string,init:any){super(name,init);this.clipboardData=init.clipboardData;}});
 try{const text='完整正文第一段\n\n第二段和🙂表情\n#标签';const result=await nativeFillEditor(bili,'fill',{title:'标题',text,video:false,expectedImages:0});expect(result.bodyMatched).toBe(true);expect(document.querySelector('[contenteditable]')!.textContent).toBe(text);expect(oldBody.isConnected).toBe(false);expect(pasted).toHaveBeenCalledTimes(1);}finally{vi.unstubAllGlobals();}
});
it('B站标题更新后恢复了其他正文时停止，不覆盖新节点',async()=>{
 const bili={...profile,platform:'bilibili' as const};fixture('<form><input><div contenteditable="true"></div></form>');const oldBody=document.querySelector<HTMLElement>('[contenteditable]')!;
 document.querySelector('input')!.addEventListener('input',()=>{queueMicrotask(()=>{const next=oldBody.cloneNode(false) as HTMLElement;next.getClientRects=()=>({length:1}) as DOMRectList;next.textContent='平台恢复的旧稿';oldBody.replaceWith(next);});},{once:true});
 await expect(nativeFillEditor(bili,'fill',{title:'标题',text:'新正文',video:false,expectedImages:0})).rejects.toThrow('其他内容');expect(document.querySelector('[contenteditable]')!.textContent).toBe('平台恢复的旧稿');
});

it('知识星球DOM正文相同但原生字数仍旧时不冒认填写成功，计数稳定后才通过',async()=>{
 vi.stubGlobal('location',{origin:'https://wx.zsxq.com',pathname:'/group/12345'});try{fixture('<div class="create-topic-panel"><div class="ql-editor" contenteditable="true"><p>完整正文</p></div><div class="text-range">(0/10000)</div></div>');const p={...profile,platform:'zsxq' as const,url:'https://wx.zsxq.com/',title:undefined,body:'.ql-editor',scope:'.create-topic-panel'},payload={targetId:'12345',title:'',text:'完整正文',video:false,expectedImages:0};const stale=await nativeFillEditor(p,'read',payload);expect(stale.body).toBe('完整正文');expect(stale.bodyMatched).toBe(false);expect(stale.notice).toContain('原生字数');document.querySelector('.text-range')!.textContent='(4/10000)';expect((await nativeFillEditor(p,'read',payload)).bodyMatched).toBe(true);}finally{vi.unstubAllGlobals();}
});
