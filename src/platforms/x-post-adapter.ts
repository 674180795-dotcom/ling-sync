import {editorBody,postLength} from '../core/post-limits';
import type {PublishTask} from '../core/model';
import {SyncError} from '../core/protocol';
import {FillAdapter} from './fill-adapter';
import {publicationProbe} from './publication';

/** Read the normal composer, never a badge, cached subscription or private API.
 * Acceptance is specific to this full text; it does not imply unlimited posts. */
export function nativeXLongText(expected:string){
 if(location.origin!=='https://x.com')throw new Error('X页面来源变化');
 const visible=(e:Element)=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const editors=[...document.querySelectorAll<HTMLElement>('div[role="dialog"][aria-modal="true"] [data-testid="tweetTextarea_0"][contenteditable="true"]')].filter(visible);
 if(editors.length!==1)return {eligibility:'unknown' as const,note:'X长文编辑器不唯一或未就绪'};
 const editor=editors[0]!,scope=editor.closest<HTMLElement>('div[role="dialog"]')!;
 const plain=(node:Node):string=>{if(node.nodeType===3)return node.textContent||'';if(node.nodeType!==1)return '';const e=node as HTMLElement;if(e.tagName==='BR')return '\n';if(e.tagName==='IMG')return e.getAttribute('alt')||'';if(e.childNodes.length===1&&e.firstChild?.nodeName==='BR')return '';const children=[...e.childNodes];let value='';const block=(n:Node)=>n.nodeType===1&&/^(P|DIV|LI|BLOCKQUOTE|H[1-6])$/.test((n as Element).tagName);const parts=children.map(plain);children.forEach((n,i)=>{if(i&&(block(n)||block(children[i-1]!))&&!parts[i-1]!.endsWith('\n'))value+='\n';value+=parts[i];});return value;};
 const normal=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').replace(/[\u200b\ufeff]/g,'').replace(/\n{3,}/g,'\n\n').trim();
 if(normal(plain(editor))!==normal(expected))return {eligibility:'unknown' as const,note:'X完整正文尚未核对，未判断长文资格'};
 const warnings=[...scope.querySelectorAll<HTMLElement>('[role="alert"],[role="status"],[data-testid="inlineError"],a[href*="/i/premium"]')].filter(e=>visible(e)&&!editor.contains(e)&&!e.contains(editor)).map(e=>e.innerText||e.textContent||'').join('\n');
 if(/(?:upgrade|subscribe|get).{0,60}(?:premium).{0,60}(?:longer|long posts)|(?:longer posts|long posts).{0,60}(?:upgrade|subscribe|premium)|(?:升级|订阅|开通).{0,30}(?:Premium|会员).{0,40}(?:长|更多)|(?:长帖|长文|更长).{0,40}(?:升级|订阅|开通)/i.test(warnings))return {eligibility:'ineligible' as const,note:'X当前编辑器明确要求升级才能发送此长文本；原文已保留，未转图、未提交'};
 const buttons=[...scope.querySelectorAll<HTMLButtonElement>('button[data-testid="tweetButton"]')].filter(visible);
 if(buttons.length===1&&!buttons[0]!.disabled&&buttons[0]!.getAttribute('aria-disabled')!=='true'&&!buttons[0]!.classList.contains('disabled')&&getComputedStyle(buttons[0]!).pointerEvents!=='none'&&!warnings.trim())return {eligibility:'accepted' as const,note:'X当前账号已接受本次完整长文本，原生发帖按钮可用；未提交'};
 return {eligibility:'unknown' as const,note:'X长文资格或本次文本上限尚未确认；保留原文，未转图、未提交'};
}

export class XPostAdapter extends FillAdapter {
 constructor(){super('x');}
 private async checkLongText(task:PublishTask,tabId:number){
  const text=editorBody(task.snapshot,false);
  if(task.snapshot.type!=='post'||postLength(text,'x')<=280)return;
  let read:ReturnType<typeof nativeXLongText>|undefined;let stamp='',stable=0;
  for(let i=0;i<12;i++){
   const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:nativeXLongText,args:[text]});read=result[0]?.result;
   stable=stamp===read?.eligibility?stable+1:1;stamp=read?.eligibility||'';
   if(stable>=3&&read?.eligibility==='accepted')return read.note;
   if(stable>=3&&read?.eligibility==='ineligible')throw new SyncError('X_LONG_TEXT_INELIGIBLE',read.note,false);
   if(i<11)await new Promise(r=>setTimeout(r,250));
  }
  throw new SyncError('X_LONG_TEXT_UNKNOWN',read?.note||'X长文资格尚未确认，保留原文等待核对',false);
 }
 override async preparePublication(task:PublishTask){
  if(task.snapshot.type!=='post'||postLength(editorBody(task.snapshot,false),'x')<=280)return super.preparePublication(task);
  // Eligibility is a pre-submit condition, not an uncertain fill. Keep the
  // complete fill proof so a later account change can be checked on the same page.
  await this.verifyDraft(task);await this.checkLongText(task,task.tabId!);return publicationProbe(task);
 }
}
