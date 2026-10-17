import type {PublishTask} from '../core/model';
import {db,updateTask} from '../core/repository';
/** Keep task pages in the originating editor window, even if another window was focused. */
export async function createTaskTab(task:PublishTask,url:string){
 let openerTabId:number|undefined;
 if(task.source){try{const source=await chrome.tabs.get(task.source.tabId);if(source.windowId===task.source.windowId)openerTabId=source.id;}catch{}}
 const tab=await chrome.tabs.create({url,active:false,...(task.source?{windowId:task.source.windowId}:{}),...(openerTabId!==undefined?{openerTabId}: {})});
 const stored=await(await db()).get('tasks',task.id);if(stored&&tab.id!==undefined)await updateTask(task.id,[stored.status],{tabId:tab.id});return tab;
}
