/** Best-effort invalidation; storage remains the source of truth after restarts. */
let pending:ReturnType<typeof setTimeout>|undefined;
export function workspaceChanged(){
  if(pending)return;
  pending=setTimeout(()=>{pending=undefined;try{void chrome.runtime.sendMessage({channel:'ling-sync-changed'}).catch(()=>{});}catch{}},100);
}
