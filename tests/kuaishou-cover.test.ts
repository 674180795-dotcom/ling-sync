// @vitest-environment-options {"url":"https://cp.kuaishou.com/"}
import {expect,it,vi} from 'vitest';
import {nativeCoverEditor} from '../src/platforms/native-cover-editor';
it('快手当前封面入口与模态内部确认唯一，外部发布不触发',async()=>{
 document.body.innerHTML='<div class="_default-cover_live"><img src="https://cdn.test/old.png"><div class="_cover-full-editor_live">封面设置</div></div><div class="ant-modal"><div class="ant-modal-body"><div>上传封面</div><input type="file" accept="image/png"><button>确认</button><button>去编辑</button></div></div><button id="publish">发布</button>';
 for(const e of document.querySelectorAll<HTMLElement>('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 const opened=vi.fn(),published=vi.fn(),confirmed=vi.fn(()=>{document.querySelector('img')!.src='https://cdn.test/changed.png';});document.querySelector('[class*="_cover-full-editor_"]')!.addEventListener('click',opened);document.querySelector('#publish')!.addEventListener('click',published);document.querySelector('.ant-modal-body button')!.addEventListener('click',confirmed);
 await nativeCoverEditor('kuaishou','open');await nativeCoverEditor('kuaishou','choose_upload');await nativeCoverEditor('kuaishou','confirm');expect(opened).toHaveBeenCalledTimes(1);expect(confirmed).toHaveBeenCalledTimes(1);expect(published).not.toHaveBeenCalled();expect((await nativeCoverEditor('kuaishou','read')).identities).toEqual(['https://cdn.test/changed.png']);
});
