import {afterEach,expect,it,vi} from 'vitest';
import {ZsxqPostAdapter} from '../src/platforms/zsxq-post-adapter';
import {newDraft,type PublishTask} from '../src/core/model';
const task=():PublishTask=>({id:crypto.randomUUID(),batchId:crypto.randomUUID(),attemptId:crypto.randomUUID(),platform:'zsxq',targetId:'12345',snapshot:{...newDraft('post'),markdown:'动态'},status:'preparing',progress:'',createdAt:Date.now(),updatedAt:Date.now()});
afterEach(()=>vi.unstubAllGlobals());
it('新标签尚未提交URL时等待页面完成，不误报目标变化',async()=>{
 const execute=vi.fn(async({args}:any)=>[{result:args?.[0]==='inspect'?{editorFound:true,accountKey:'owner',text:'',mediaCount:0}:true}]);const get=vi.fn().mockResolvedValueOnce({id:7,status:'loading'}).mockResolvedValue({id:7,status:'complete',url:'https://wx.zsxq.com/group/12345'});
 vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{create:async()=>({id:7}),get,update:async()=>({id:7})},scripting:{executeScript:execute}});
 expect(await new ZsxqPostAdapter().openEditor(task())).toBe(7);expect(get).toHaveBeenCalledTimes(2);expect(execute).toHaveBeenCalledTimes(6);
});
it('最终页面属于其他星球时，拒绝打开或写入编辑器',async()=>{
 const execute=vi.fn();vi.stubGlobal('chrome',{permissions:{contains:async()=>true},tabs:{create:async()=>({id:7}),get:async()=>({id:7,status:'complete',url:'https://wx.zsxq.com/group/67890'}),update:async()=>({id:7})},scripting:{executeScript:execute}});
 await expect(new ZsxqPostAdapter().openEditor(task())).rejects.toThrow('目标星球变化');expect(execute).not.toHaveBeenCalled();
});
