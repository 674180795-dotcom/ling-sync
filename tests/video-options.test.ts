import {expect,it,vi,afterEach} from 'vitest';
import {newDraft} from '../src/core/model';
import {validatePublicationOptions,nativeVideoOptions} from '../src/platforms/video-options';
afterEach(()=>vi.unstubAllGlobals());
it('来源、转载链接、分区和标签必须由用户明确，不自动原创或推荐标签',()=>{
 const d=newDraft('video');expect(()=>validatePublicationOptions('channels',d)).toThrow('明确选择');expect(()=>validatePublicationOptions('bilibili',{...d,videoSource:'repost'})).toThrow('来源链接');expect(()=>validatePublicationOptions('bilibili',{...d,videoSource:'original'})).toThrow('分区');expect(()=>validatePublicationOptions('bilibili',{...d,videoSource:'original',bilibiliCategory:'科学科普',tags:['技术']})).not.toThrow();expect(()=>validatePublicationOptions('bilibili',{...d,videoSource:'original',bilibiliCategory:'科学科普',tags:Array(11).fill('标签')})).toThrow('10个');expect(()=>validatePublicationOptions('x',d)).not.toThrow();
});
it('原生来源控件不唯一时不点击任何来源或发布按钮',async()=>{
 vi.stubGlobal('location',{origin:'https://member.bilibili.com'});document.body.innerHTML='<label>自制</label><label>自制</label><button>发布</button>';const clicks=vi.fn();for(const e of document.querySelectorAll<HTMLElement>('*')){e.getClientRects=()=>({length:1}) as DOMRectList;e.onclick=clicks;}await expect(nativeVideoOptions('bilibili',{source:'original',category:'科学科普',tags:['技术']})).rejects.toThrow('不唯一');expect(clicks).not.toHaveBeenCalled();
});
it('转载不要求视频号填写没有原生控件的来源链接，且撤销旧原创声明',async()=>{
 expect(()=>validatePublicationOptions('channels',{...newDraft('video'),videoSource:'repost'})).not.toThrow();vi.stubGlobal('location',{origin:'https://channels.weixin.qq.com'});document.body.innerHTML='<label><span>声明原创</span><input type="checkbox" checked></label>';for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;await nativeVideoOptions('channels',{source:'repost',tags:[]});expect(document.querySelector('input')!.checked).toBe(false);
});
