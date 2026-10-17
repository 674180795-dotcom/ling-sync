import {afterEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import {nativeChannelsDraft} from '../src/platforms/native-channels-draft';
function setup(html:string){vi.stubGlobal('location',{origin:'https://channels.weixin.qq.com',pathname:'/platform/post/create'});vi.stubGlobal('crypto',webcrypto);document.body.innerHTML=html;for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;for(const v of document.querySelectorAll('video')){Object.defineProperty(v,'readyState',{value:4,configurable:true});Object.defineProperty(v,'duration',{value:5,configurable:true});}}
afterEach(()=>vi.unstubAllGlobals());
it('平台视频身份只保留摘要，认证查询参数轮换不改变资产身份',async()=>{
 setup('<div class="capture-video-container"><video src="https://finder.video.qq.com/asset?encfilekey=asset-a&token=secret-one"></video></div>');const first=await nativeChannelsDraft('inspect');expect(JSON.stringify(first)).not.toContain('secret');expect(first.remoteMediaHashes).toHaveLength(1);
 document.querySelector('video')!.src='https://finder.video.qq.com/asset?token=secret-two&encfilekey=asset-a';expect((await nativeChannelsDraft('inspect')).remoteMediaHashes).toEqual(first.remoteMediaHashes);
 document.querySelector('video')!.src='https://finder.video.qq.com/asset?encfilekey=asset-b';expect((await nativeChannelsDraft('inspect')).remoteMediaHashes).not.toEqual(first.remoteMediaHashes);
});
it('保存前身份缺失或变化拒绝提交，保存只点唯一原生草稿按钮',async()=>{
 setup('<div class="capture-video-container"><video src="https://finder.video.qq.com/asset?encfilekey=a"></video></div><button>保存草稿</button><button>发表</button>');const save=vi.fn(),publish=vi.fn();document.querySelectorAll('button')[0]!.onclick=()=>{save();document.body.insertAdjacentHTML('beforeend','<div role="alert">保存成功</div>');document.querySelector<HTMLElement>('[role=alert]')!.getClientRects=()=>({length:1}) as DOMRectList;};document.querySelectorAll('button')[1]!.onclick=publish;
 await expect(nativeChannelsDraft('save',['different'])).rejects.toThrow('身份已变化');expect(save).not.toHaveBeenCalled();const proof=await nativeChannelsDraft('inspect');await nativeChannelsDraft('save',proof.remoteMediaHashes);expect(save).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();
});
it('草稿箱仅重开唯一精确正文，找不到时不保存，重复匹配拒绝认领',async()=>{
 setup('<div class="post-title">原有用户草稿</div><button>保存草稿</button>');const save=vi.fn();document.querySelector('button')!.onclick=save;expect((await nativeChannelsDraft('reopen',undefined,'测试稿')).opened).toBe(false);expect(save).not.toHaveBeenCalled();
 setup('<div class="post-draft-item"><div class="post-title">测试稿</div><div class="opr-item">编辑</div><div class="opr-item">删除</div></div>');const open=vi.fn();document.querySelector<HTMLElement>('.opr-item')!.onclick=open;expect((await nativeChannelsDraft('reopen',undefined,'测试稿')).opened).toBe(true);expect(open).toHaveBeenCalledTimes(1);
 document.body.insertAdjacentHTML('beforeend','<div class="post-title">测试稿</div>');document.querySelectorAll<HTMLElement>('.post-title')[1]!.getClientRects=()=>({length:1}) as DOMRectList;await expect(nativeChannelsDraft('reopen',undefined,'测试稿')).rejects.toThrow('不唯一');expect(open).toHaveBeenCalledTimes(1);
});

it('平台明确失败时不继续导航或再次保存',async()=>{
 setup('<div class="capture-video-container"><video src="https://finder.video.qq.com/asset?encfilekey=a"></video></div><button>保存草稿</button>');const save=vi.fn();document.querySelector('button')!.onclick=()=>{save();document.body.insertAdjacentHTML('beforeend','<div>保存草稿失败</div>');document.body.lastElementChild!.getClientRects=()=>({length:1}) as DOMRectList;};const proof=await nativeChannelsDraft('inspect');await expect(nativeChannelsDraft('save',proof.remoteMediaHashes)).rejects.toThrow('平台提示保存草稿失败');expect(save).toHaveBeenCalledTimes(1);
});

it('远程地址出现但仍上传或视频未就绪，不能进入保存',async()=>{
 setup('<div class="capture-video-container"><video src="https://finder.video.qq.com/asset?encfilekey=a"></video></div><span>取消上传</span><button>保存草稿</button>');expect((await nativeChannelsDraft('inspect')).remoteMediaHashes).toEqual([]);document.querySelector('span')!.remove();Object.defineProperty(document.querySelector('video'),'readyState',{value:0});expect((await nativeChannelsDraft('inspect')).remoteMediaHashes).toEqual([]);
});
