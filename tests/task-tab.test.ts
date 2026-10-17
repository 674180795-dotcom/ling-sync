import {expect,it,vi} from 'vitest';
import {createTaskTab} from '../src/platforms/task-tab';
import {newDraft,type PublishTask} from '../src/core/model';
it('后台打开任务页使用持久来源窗口，来源标签关闭后仍使用原窗口',async()=>{
 const t:PublishTask={id:'task',batchId:'batch',platform:'jike',targetId:'',snapshot:newDraft('post'),status:'queued',createdAt:0,updatedAt:0,attemptId:'attempt',progress:'',source:{windowId:12,tabId:34}};const create=vi.fn(async x=>x);const get=vi.fn(async()=>({windowId:12,id:34}));vi.stubGlobal('chrome',{tabs:{get,create}});await createTaskTab(t,'https://web.okjike.com/');expect(create).toHaveBeenLastCalledWith({url:'https://web.okjike.com/',active:false,windowId:12,openerTabId:34});get.mockRejectedValueOnce(new Error('closed'));await createTaskTab(t,'https://web.okjike.com/');expect(create).toHaveBeenLastCalledWith({url:'https://web.okjike.com/',active:false,windowId:12});vi.unstubAllGlobals();
});
