import {type EditorSource,type TargetOption,type PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';

/** Visible links only; never infer membership from recommendation cards. */
export function nativeStarTargets(){
 if(location.origin!=='https://wx.zsxq.com')throw new Error('目标来源变化');
 const user=document.querySelector('.user-container');if(!user)throw new Error('请先登录知识星球');
 const links=[...document.querySelectorAll<HTMLAnchorElement>('a[href^="/group/"]')].filter(a=>a.getClientRects().length);
 const choices=links.map(a=>({id:new URL(a.href).pathname.match(/^\/group\/(\d{5,30})\/?$/)?.[1]||'',name:(a.childNodes[0]?.textContent||a.innerText||'').trim()})).filter(o=>o.id&&o.name);
 return [...new Map(choices.map(o=>[o.id,o])).values()];
}
/** The website exposes names, not IDs, in its ordinary circle picker. Match exact unique names. */
export function nativeJikeTarget(action:'search'|'list'|'select'|'verify',query='',captureErrors=false){
 try{
 if(location.origin!=='https://web.okjike.com')throw new Error('圈子来源变化');
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const dialogs=[...document.querySelectorAll<HTMLElement>('[role=dialog]')].filter(visible);
 const root=dialogs.at(-1)||document;
 const forms=[...root.querySelectorAll('form')].filter(f=>visible(f)&&f.querySelector('[contenteditable=true]'));
 if(forms.length!==1)throw new Error('请先在即刻打开唯一的动态编辑器');
 const picker=forms[0]!.querySelector<HTMLElement>('[name=topic]');if(!picker)throw new Error('圈子控件未就绪');
 const selected=picker.querySelector<HTMLElement>('[class*="_contentNormal_"]')?.textContent?.trim()||'';
 if(action==='verify'){if(selected!==query)throw new Error('即刻圈子已变化，尚未发布');return {selected,options:[] as TargetOption[]};}
 const input=picker.querySelector<HTMLInputElement>('input[placeholder="未选择圈子"]');
 if(action==='search'){
  if(!input)throw new Error('请先在即刻清除已选圈子，再刷新候选');
  input.focus();input.click();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,query);input.dispatchEvent(new Event('input',{bubbles:true}));
 }
 const rows=[...picker.querySelectorAll<HTMLElement>('[class*="_item_"][tabindex="0"]')].filter(visible);
 const options=[...new Set(rows.map(e=>e.textContent?.trim()||'').filter(Boolean))].map(name=>({id:name,name}));
 if(action==='select'){
  if(selected===query)return {selected,options};
  if(!query){if(selected)throw new Error('即刻已有其他圈子，本次保留并停止');return {selected,options};}
  const match=rows.filter(e=>e.textContent?.trim()===query);if(match.length!==1)throw new Error('所选即刻圈子不可用，未更换目标');match[0]!.click();
 }
 return {selected,options};
 }catch(error){if(!captureErrors)throw error;return {selected:'',options:[] as TargetOption[],error:error instanceof Error?error.message:'圈子控件未返回'};}
}
export async function readJikeTarget(tabId:number,action:Parameters<typeof nativeJikeTarget>[0],query=''){
 const r=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeJikeTarget,args:[action,query,true]});
 const result=r[0]?.result;if(!result||'error' in result)throw new SyncError('TARGET_UNAVAILABLE',result&&'error' in result?result.error||'即刻圈子核对失败':'即刻圈子脚本未返回结果',false);return result;
}
export async function listTargets(platform:'zsxq'|'jike',query='',refresh=false,source?:EditorSource):Promise<TargetOption[]>{
 const cache=((await chrome.storage.local.get('targetOptions')).targetOptions||{}) as Partial<Record<'zsxq'|'jike',TargetOption[]>>;
 if(!refresh&&!query&&cache[platform]?.length)return cache[platform]!;
 const origin=platform==='zsxq'?'https://wx.zsxq.com':'https://web.okjike.com';
 if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw new SyncError('PERMISSION_REQUIRED','请先连接平台，再读取可用目标');
 // Read lists in a disposable ordinary page; never open or search an existing native draft.
 const tab=await chrome.tabs.create({url:origin+'/',active:false,...(source?{windowId:source.windowId}:{})});
 if(!tab.id)throw new SyncError('TARGET_UNAVAILABLE','无法打开平台目标列表');
 try{
  if(platform==='jike'){
   // Opening the normal composer does not change existing text or media.
   let ready=false;
   for(let i=0;i<40;i++){
    try{const r=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:()=>{if(location.origin!=='https://web.okjike.com')return false;if(document.querySelector('[role=dialog] form [contenteditable=true]'))return true;const buttons=[...document.querySelectorAll('button')].filter(e=>e.getClientRects().length&&(e.getAttribute('aria-label')?.trim()||e.textContent?.trim())==='创建动态');if(buttons.length===1)buttons[0]!.click();return false;}});if(r[0]?.result){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,250));
   }
   if(!ready)throw new SyncError('TARGET_UNAVAILABLE','即刻圈子编辑器未就绪，请检查登录');
   await readJikeTarget(tab.id,'search',query);
  }
  let choices:TargetOption[]=[];let stamp='',stable=0;
  for(let i=0;i<24;i++){
   try{if(platform==='zsxq'){const r=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:nativeStarTargets});choices=r[0]?.result||[];}
   else {choices=(await readJikeTarget(tab.id,'list',query)).options;}
   const next=JSON.stringify(choices);stable=stamp===next?stable+1:0;stamp=next;if(choices.length&&stable>=3&&i>=5&&(!query||choices.some(o=>o.name.includes(query))))break;
   }catch{if(i===23)throw new SyncError('TARGET_UNAVAILABLE','平台目标列表尚未就绪，请检查登录并重试');}
   await new Promise(r=>setTimeout(r,250));
  }
  if(!choices.length)throw new SyncError('TARGET_UNAVAILABLE','未找到可选目标，请打开平台确认登录或更换搜索词');
  cache[platform]=platform==='jike'?[...new Map([...(cache[platform]||[]),...choices].map(o=>[o.id,o])).values()]:choices;
  const latest=((await chrome.storage.local.get('targetOptions')).targetOptions||{}) as typeof cache;await chrome.storage.local.set({targetOptions:{...latest,[platform]:cache[platform]}});return choices;
 }finally{await chrome.tabs.remove(tab.id).catch(()=>{});}
}
export async function prepareJikeTarget(task:PublishTask){
 if(task.platform!=='jike'||!task.tabId)return;
 const run=(action:Parameters<typeof nativeJikeTarget>[0])=>readJikeTarget(task.tabId!,action,task.targetId);
 const current=await run('list');if(current.selected===task.targetId)return;
 if(current.selected)throw new SyncError('TARGET_UNAVAILABLE','即刻已有其他圈子，本次保留并停止',false);
 await run('search');let matched=false;
 for(let i=0;i<24;i++){if((await run('list')).options.some(o=>o.id===task.targetId)){matched=true;break;}await new Promise(r=>setTimeout(r,250));}
 if(!matched)throw new SyncError('TARGET_UNAVAILABLE','所选即刻圈子不可用，未更换目标',false);
 await run('select');await run('verify');
}
