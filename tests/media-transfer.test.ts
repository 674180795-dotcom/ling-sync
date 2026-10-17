// @vitest-environment-options {"url":"https://web.okjike.com/"}
import {beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {File as NativeFile} from 'node:buffer';
let receiver:(packet:unknown,sender:unknown,reply:(response:any)=>void)=>boolean;
const key='task:attempt:image';const media={id:crypto.randomUUID(),name:'test.png',kind:'image',mime:'image/png',bytes:3};
const send=(action:string,extra:Record<string,unknown>={},sender={id:'test-extension'})=>new Promise<any>(resolve=>receiver({channel:'ling-sync-media-v5',version:5,platform:'jike',type:'post',key,action,...extra},sender,resolve));
beforeAll(async()=>{
 vi.stubGlobal('defineContentScript',(config:any)=>config);vi.stubGlobal('chrome',{runtime:{id:'test-extension',onMessage:{addListener:(fn:typeof receiver)=>receiver=fn}}});
 vi.stubGlobal('File',NativeFile);vi.stubGlobal('DataTransfer',class{files:NativeFile[]=[];items={add:(file:NativeFile)=>this.files.push(file)};});
 const module=await import('../src/entrypoints/media-transfer.content');await module.default.main({} as any);
});
beforeEach(async()=>{await send('abort');document.body.innerHTML='<div role="dialog"><form><input type="file" accept="image/png"></form></div>';});
it('跨任务取消或序号错误不能误上传、破坏其他传输',async()=>{
 expect((await send('begin',{media})).ok).toBe(true);expect((await send('abort',{key:'another-task'})).ok).toBe(false);
 expect((await send('chunk',{index:0,chunk:btoa('abc')})).ok).toBe(true);
 const input=document.querySelector('input')!;let selected:NativeFile[]=[];Object.defineProperty(input,'files',{get:()=>selected,set:value=>selected=value});
 expect((await send('commit')).ok).toBe(true);expect(await selected[0]!.text()).toBe('abc');expect(selected[0]!.name).toBe('test.png');
 await send('begin',{media});expect((await send('chunk',{index:1,chunk:btoa('abc')})).ok).toBe(false);expect((await send('commit')).ok).toBe(false);
});
it('短传输、重复块及超长字节拒绝提交，不触发change',async()=>{
 const changed=vi.fn();document.querySelector('input')!.addEventListener('change',changed);
 await send('begin',{media});await send('chunk',{index:0,chunk:btoa('ab')});expect((await send('commit')).ok).toBe(false);
 await send('begin',{media});await send('chunk',{index:0,chunk:btoa('a')});expect((await send('chunk',{index:0,chunk:btoa('b')})).ok).toBe(false);
 await send('begin',{media});expect((await send('chunk',{index:0,chunk:btoa('abcd')})).ok).toBe(false);expect(changed).not.toHaveBeenCalled();
});
it('其他扩展和模糊上传控件不能提交附件',async()=>{
 expect((await send('begin',{media},{id:'other-extension'})).ok).toBe(false);await send('begin',{media});await send('chunk',{index:0,chunk:btoa('abc')});document.body.innerHTML='<input type="file" accept="image/png"><input type="file" accept="image/png">';expect((await send('commit')).ok).toBe(false);
});
it('旧版监听通道与v5隔离，旧脚本不能抢新传输的回执',async()=>{
 await send('begin',{media});const reply=vi.fn();expect(receiver({channel:'ling-sync-media',version:1,platform:'jike',type:'post',key,action:'abort'},{id:'test-extension'},reply)).toBe(false);expect(receiver({channel:'ling-sync-media-v2',version:2,platform:'jike',type:'post',key,action:'abort'},{id:'test-extension'},reply)).toBe(false);expect(reply).not.toHaveBeenCalled();expect((await send('chunk',{index:0,chunk:btoa('abc')})).ok).toBe(true);
});

it('上传控件探测不选择文件，不生成或清除正在传输的块',async()=>{
 const changed=vi.fn();document.querySelector('input')!.addEventListener('change',changed);expect((await send('probe',{media})).ok).toBe(true);expect(changed).not.toHaveBeenCalled();await send('begin',{media});expect((await send('probe',{media})).ok).toBe(true);expect((await send('chunk',{index:0,chunk:btoa('abc')})).ok).toBe(true);
});
it('知识星球错误目标在附件传输之前拒绝，旧v4监听不接收v5',async()=>{
 const previous=location;vi.stubGlobal('location',{origin:'https://wx.zsxq.com',pathname:'/group/67890'});const reply=vi.fn();receiver({channel:'ling-sync-media-v5',version:5,platform:'zsxq',type:'post',targetId:'12345',key,action:'begin',media},{id:'test-extension'},reply);expect(reply).toHaveBeenCalledWith({ok:false,error:'附件目标星球变化'});vi.stubGlobal('location',previous);
 const old=vi.fn();expect(receiver({channel:'ling-sync-media-v4',version:4,platform:'jike',type:'post',key,action:'begin',media},{id:'test-extension'},old)).toBe(false);expect(old).not.toHaveBeenCalled();
});

it('批量图片一次交付有序文件，暂存阶段不上传，其他任务不能提交',async()=>{
 document.body.innerHTML='<div role="dialog"><form><input type="file" accept="image/png" multiple></form></div>';const input=document.querySelector('input')!;let selected:NativeFile[]=[];Object.defineProperty(input,'files',{get:()=>selected,set:value=>selected=value});const changed=vi.fn();input.addEventListener('change',changed);
 for(const [name,text] of [['first.png','one'],['second.png','two']] as const){await send('begin',{media:{...media,id:crypto.randomUUID(),name}});await send('chunk',{index:0,chunk:btoa(text)});expect((await send('stage')).ok).toBe(true);}
 expect(changed).not.toHaveBeenCalled();expect((await send('commit_batch',{key:'different-owner'})).ok).toBe(false);expect((await send('commit_batch')).ok).toBe(true);expect(changed).toHaveBeenCalledTimes(1);expect(selected.map(f=>f.name)).toEqual(['first.png','second.png']);expect(await selected[1]!.text()).toBe('two');expect((await send('commit_batch')).ok).toBe(false);
});
it('批量控件不接受多图时不触发change，旧v4请求不影响已暂存附件',async()=>{
 await send('begin',{media});await send('chunk',{index:0,chunk:btoa('abc')});await send('stage');const old=vi.fn();receiver({channel:'ling-sync-media-v4',version:4,platform:'jike',type:'post',key,action:'abort'},{id:'test-extension'},old);expect(old).not.toHaveBeenCalled();await send('begin',{media:{...media,id:crypto.randomUUID(),name:'second.png'}});await send('chunk',{index:0,chunk:btoa('abc')});await send('stage');const changed=vi.fn();document.querySelector('input')!.addEventListener('change',changed);expect((await send('commit_batch')).ok).toBe(false);expect(changed).not.toHaveBeenCalled();
});
it('公众号动态仅使用贴图上传入口，不误用隐藏的文章素材上传器',async()=>{
 const {nativeMediaInput}=await import('../src/platforms/media-input');document.body.innerHTML='<input id="article" type="file" accept="image/png"><div class="image-selector"><input id="post" type="file" accept="image/png" multiple></div>';
 expect(nativeMediaInput('weixin',media as any).id).toBe('post');document.querySelector('.image-selector')!.insertAdjacentHTML('beforeend','<input type="file" accept="image/png">');expect(()=>nativeMediaInput('weixin',media as any)).toThrow('不唯一');
});
it('B站只捕获正常图片按钮的脱离DOM输入并还原click，按顺序交付一次change后清理',async()=>{
 const originalLocation=globalThis.location;vi.stubGlobal('location',{origin:'https://t.bilibili.com',pathname:'/'});
 const rect=vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{}] as any);
 const originalClick=HTMLInputElement.prototype.click;
 try{
  document.body.innerHTML='<input type="file" accept="image/png"><div class="bili-dyn-publishing"><div class="bili-dyn-publishing__tools__item pic"></div></div>';
  const {prepareBiliImageInput}=await import('../src/platforms/media-input');let chosen:NativeFile[][]=[];
  document.querySelector('.pic')!.addEventListener('click',()=>{queueMicrotask(()=>{const input=document.createElement('input');input.type='file';input.accept='image/png,image/jpeg';input.multiple=true;let selected:NativeFile[]=[];Object.defineProperty(input,'files',{get:()=>selected,set:value=>selected=value});input.addEventListener('change',()=>chosen.push(selected));input.click();});});
  expect(await prepareBiliImageInput()).toEqual({ready:true,accept:'image/png,image/jpeg',multiple:true,error:''});expect(HTMLInputElement.prototype.click).toBe(originalClick);
  expect((await prepareBiliImageInput()).multiple).toBe(true);expect(document.querySelectorAll('[data-ling-sync-bili-picker]')).toHaveLength(1);
  const dispatch=(action:string,extra:Record<string,unknown>={})=>send(action,{platform:'bilibili',...extra});expect((await dispatch('probe',{media})).ok).toBe(true);
  for(const [name,content] of [['one.png','abc'],['two.png','xyz']] as const){await dispatch('begin',{media:{...media,id:crypto.randomUUID(),name}});await dispatch('chunk',{index:0,chunk:btoa(content)});await dispatch('stage');}
  expect((await dispatch('commit_batch')).ok).toBe(true);expect(chosen).toHaveLength(1);expect(chosen[0]!.map(f=>f.name)).toEqual(['one.png','two.png']);expect(document.querySelector('[data-ling-sync-bili-picker]')).toBeNull();
  document.querySelector('.bili-dyn-publishing')!.insertAdjacentHTML('beforeend','<div class="bili-dyn-publishing__tools__item pic"></div>');expect((await prepareBiliImageInput()).error).toContain('不唯一');expect(HTMLInputElement.prototype.click).toBe(originalClick);
  document.body.innerHTML='<div class="bili-dyn-publishing"><div class="bili-dyn-publishing__tools__item pic"></div></div>';expect((await prepareBiliImageInput()).ready).toBe(false);expect(HTMLInputElement.prototype.click).toBe(originalClick);
 }finally{rect.mockRestore();vi.stubGlobal('location',originalLocation);}
});
