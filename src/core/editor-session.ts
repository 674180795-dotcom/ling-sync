/** Only reopening the same native sidebar may resume. Reload and full-page entry start blank. */
export async function sidebarDraftId(){
 if(!chrome.storage?.session||!chrome.windows)return;
 const windowId=(await chrome.windows.getCurrent()).id;if(windowId===undefined)return;
 const key='editor-session:'+windowId;const data=(await chrome.storage.session.get(key))[key] as {closed?:boolean;draftId?:string}|undefined;
 await chrome.storage.session.set({[key]:{closed:false}});
 const navigation=performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined;
 return navigation?.type!=='reload'&&data?.closed?data.draftId as string|undefined:undefined;
}
export async function rememberSidebarDraft(draftId:string){
 if(!chrome.storage?.session||!chrome.windows)return;
 const windowId=(await chrome.windows.getCurrent()).id;if(windowId===undefined)return;
 const key='editor-session:'+windowId;const prior=(await chrome.storage.session.get(key))[key] as {closed?:boolean;draftId?:string}|undefined;
 await chrome.storage.session.set({[key]:{...prior,draftId}});
}
