import {afterEach,it,expect,vi} from 'vitest';
import {nativeJikeTarget,readJikeTarget,prepareJikeTarget} from '../src/platforms/targets';
import {newDraft} from '../src/core/model';
afterEach(()=>vi.unstubAllGlobals());
it('圈子脚本错误必须显式返回；缺失回执不得误认校验通过',async()=>{
 vi.stubGlobal('location',{origin:'https://web.okjike.com'});document.body.innerHTML='<div role="dialog"><form><div contenteditable="true"></div><div name="topic"><input placeholder="未选择圈子"></div></form></div>';
 for(const e of document.querySelectorAll('*'))e.getClientRects=()=>({length:1}) as DOMRectList;
 expect(nativeJikeTarget('verify','人工智能讨论组',true)).toMatchObject({error:expect.stringContaining('圈子')});expect(()=>nativeJikeTarget('verify','人工智能讨论组')).toThrow();
 vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn(async()=>[{}])}});await expect(readJikeTarget(7,'verify','人工智能讨论组')).rejects.toThrow('未返回');
});
it('已选圈子变化时停止，不搜索或替换；不选择圈子也须核对为空',async()=>{
 const execute=vi.fn(async()=>[{result:{selected:'其他圈子',options:[]}}]);vi.stubGlobal('chrome',{scripting:{executeScript:execute}});
 const task={platform:'jike',tabId:7,targetId:'人工智能讨论组',snapshot:newDraft('post')} as any;await expect(prepareJikeTarget(task)).rejects.toThrow('其他圈子');expect(execute).toHaveBeenCalledOnce();await expect(prepareJikeTarget({...task,targetId:''})).rejects.toThrow('其他圈子');
});
it('目标圈子选择与回读都必须返回明确匹配',async()=>{
 const calls:string[]=[];vi.stubGlobal('chrome',{scripting:{executeScript:vi.fn(async({args}:any)=>{calls.push(args[0]);return [{result:args[0]==='verify'?{selected:'人工智能讨论组',options:[]}:{selected:'',options:[{id:'人工智能讨论组',name:'人工智能讨论组'}]}}];})}});
 await prepareJikeTarget({platform:'jike',tabId:7,targetId:'人工智能讨论组',snapshot:newDraft('post')} as any);expect(calls).toEqual(['list','search','list','select','verify']);
});
