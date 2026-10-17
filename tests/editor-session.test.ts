import {afterEach,it,expect,vi} from 'vitest';
import {sidebarDraftId,rememberSidebarDraft} from '../src/core/editor-session';
afterEach(()=>vi.unstubAllGlobals());
function fixture(navigation='navigate',closed=true){
 const data:Record<string,unknown>={'editor-session:7':{closed,draftId:'old-draft'}};
 vi.stubGlobal('performance',{getEntriesByType:()=>[{type:navigation}]});
 vi.stubGlobal('chrome',{windows:{getCurrent:async()=>({id:7})},storage:{session:{get:async(key:string)=>({[key]:data[key]}),set:async(patch:object)=>Object.assign(data,patch)}}});return data;
}
it('同一原生侧栏收起再展开恢复当前稿，刷新侧栏从空白开始',async()=>{
 const data=fixture();expect(await sidebarDraftId()).toBe('old-draft');await rememberSidebarDraft('current');expect(data['editor-session:7']).toEqual({closed:false,draftId:'current'});
 fixture('reload');expect(await sidebarDraftId()).toBeUndefined();
});
it('未收到侧栏关闭事件的新页面不自动载入旧稿，也不跨窗口恢复',async()=>{
 const data=fixture('navigate',false);expect(await sidebarDraftId()).toBeUndefined();expect(data['editor-session:7']).toEqual({closed:false});
 const other=fixture();(chrome.windows.getCurrent as any)=async()=>({id:8});expect(await sidebarDraftId()).toBeUndefined();expect(other['editor-session:7']).toEqual({closed:true,draftId:'old-draft'});
});
