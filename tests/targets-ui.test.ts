import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import {TargetPicker} from '../src/ui/TargetPicker';
vi.mock('../src/core/client',()=>({api:{listTargets:async()=>[{id:'12345',name:'甲星球'},{id:'23456',name:'乙星球'},{id:'34567',name:'丙星球'}]}}));
afterEach(()=>vi.unstubAllGlobals());
it('连续多选在完成时一次保存完整目标集，关闭选择器不改已保存目标',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('chrome',{storage:{local:{get:async()=>({})}}});const onChange=vi.fn(),container=document.createElement('div');document.body.append(container);const root=createRoot(container);await act(async()=>root.render(createElement(TargetPicker,{platform:'zsxq',selected:['12345'],disabled:false,onChange})));
 await act(async()=>container.querySelector<HTMLButtonElement>('.target-trigger')!.click());const checks=container.querySelectorAll<HTMLInputElement>('.target-options input');await act(async()=>{checks[1]!.click();checks[2]!.click();});expect(onChange).not.toHaveBeenCalled();expect(container.textContent).toContain('已选 3 项');await act(async()=>container.querySelector<HTMLButtonElement>('.target-dialog footer button')!.click());expect(onChange).toHaveBeenLastCalledWith(['12345','23456','34567']);
 await act(async()=>container.querySelector<HTMLButtonElement>('.target-trigger')!.click());await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(onChange).toHaveBeenCalledOnce();await act(async()=>root.unmount());container.remove();
});
