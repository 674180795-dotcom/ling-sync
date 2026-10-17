import {useEffect,useRef} from 'react';
import {useScrollLock} from './useScrollLock';
import {AlertCircle,ExternalLink,X,Download} from 'lucide-react';
import {platformFor,type BackupSummary,type TaskSummary} from '../core/model';

export function IssueDialog({task,backup,busy,onClose,onOpen,onRestore,onExport}:{task:TaskSummary;backup?:BackupSummary;busy:boolean;onClose:()=>void;onOpen:()=>void;onRestore:(id:string)=>void;onExport:(id:string)=>void}){
 const ref=useRef<HTMLDivElement>(null);useScrollLock(true);
 useEffect(()=>{
   const previous=document.activeElement as HTMLElement|null;
   ref.current?.querySelector<HTMLElement>('[data-primary]')?.focus();
   const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}if(event.key!=='Tab')return;const controls=[...ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')||[]];const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
   document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};
 },[task.id,backup?.id]);
 const stale=task.error?.code==='ZSXQ_EDITOR_STALE';
 const xLong=task.error?.code?.startsWith('X_LONG_TEXT_');
 const login=['LOGIN_REQUIRED','VERIFICATION_REQUIRED'].includes(task.error?.code||'');
 const canRestore=task.status==='published'||['failed','ready_for_confirmation','unknown'].includes(task.status)&&!task.publicationAttemptedAt&&!task.proof?.uploadedMediaIds?.length;
 return <div className="issue-layer"><div className="issue-backdrop"/><div ref={ref} className="issue-dialog" role="dialog" aria-modal="true" aria-labelledby="issue-title" aria-describedby="issue-description">
   <div className="issue-heading"><span className="issue-symbol"><AlertCircle size={22}/></span><button className="icon-button" aria-label="关闭提醒" onClick={onClose}><X size={18}/></button></div>
   <p className="issue-eyebrow">{platformFor(task.platform).name}</p><h2 id="issue-title">{backup?'原草稿备份仍在':login?'需要你完成登录或验证':stale?'发布编辑器尚未就绪':xLong?task.error?.code==='X_LONG_TEXT_INELIGIBLE'?'此账号暂不能发送长文本':'长文本发送资格待核对':'原草稿已保留'}</h2>
   <p id="issue-description">{backup?backup.note||'同步尚未完成原稿恢复，备份已保存在本机。':task.error?.message||task.progress}</p>
   <div className="issue-detail"><span>{task.snapshot.title||'未命名内容'}</span><p>{backup?'恢复仅处理原草稿，不会重新发布。':login?'完成后返回同步记录，继续尚未提交的任务。':xLong?'完整原文已保留，没有自动转图片。请在原生编辑器核对当前账号及本次文本，其他平台继续同步。':'本平台已暂停，其他平台继续同步。处理原稿后可从同步记录继续。'}</p></div>
   <div className="issue-buttons"><button data-primary className="primary" disabled={busy} onClick={onOpen}>{login||stale||xLong?'打开平台':'打开原稿'}<ExternalLink size={14}/></button>{backup&&<button className="secondary" disabled={busy||!canRestore} onClick={()=>onRestore(backup.id)}>恢复原草稿</button>}<button className="text-button" disabled={busy} onClick={onClose}>保留并跳过</button></div>
   {backup&&<button className="text-button issue-export" disabled={busy} onClick={()=>onExport(backup.id)}><Download size={13}/>导出原稿备份</button>}
 </div></div>;
}
