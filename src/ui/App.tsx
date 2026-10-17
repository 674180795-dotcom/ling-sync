
import {TargetPicker} from './TargetPicker';
import {sidebarDraftId,rememberSidebarDraft} from '../core/editor-session';
import {mergeTags} from '../core/model';
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, Check, CheckCircle2, ChevronDown, Clock3, Download, ExternalLink, Eye, FileImage, ImagePlus, Loader2, Plus, RefreshCw, Settings2, ShieldCheck, Trash2, Video, X } from 'lucide-react';
import { api, addMedia, getMedia, removeMedia } from '../core/client';
import { TITLE_MAX, limitTitleEdit, selectablePlatforms, capabilityFor, groupIdFrom, newDraft, platformFor, platforms, safeUrl, publicationAvailable, type ContentDraft, type ContentType, type MediaRef, type PlatformId, type TaskSummary, type TaskStatus, type WorkspaceData } from '../core/model';
import {batchSummary,needsTextImages,syncOperation} from '../core/post-routing';
import {validateSyncTitle} from '../core/protocol';
import { renderMarkdown } from '../core/markdown';
import {IssueDialog} from './IssueDialog';
import {useScrollLock} from './useScrollLock';
import {CardEditor} from './CardEditor';
import {OverflowDialog} from './OverflowDialog';
import {overflowPlatforms} from '../core/post-limits';
import './styles.css';

const types: { id: ContentType; label: string }[] = [{id:'post',label:'动态'},{id:'article',label:'文章'},{id:'video',label:'视频'}];
const mediaLabels = {image:'图片',video:'视频',cover:'封面'};
const hasContent = (draft:ContentDraft) => !!(draft.title.trim() || draft.markdown.trim() || draft.media.length || draft.tags.length);
const statusLabels: Record<TaskStatus, string> = { queued: '等待同步', preparing: '正在填写', ready_for_confirmation: '等待继续执行', saving_draft: '正在保存', draft_saved: '已核对草稿', filled: '已填写，待发布', publishing:'正在发布', submitted:'已提交发布，待核对', published:'已发布并核对', failed: '同步未完成', unknown: '结果待核对' };
const accountLabels = { permission_required: '待授权', logged_out: '未登录', connected: '已识别登录', unknown: '待确认' };
const time = (value: number) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试或查看诊断。';

function download(name: string, content: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeDiagnostic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|cookie|password|authorization|secret/i.test(key)).map(([key, entry]) => [key, safeDiagnostic(entry)]));
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"<>]+/g, url => { try { return safeUrl(url); } catch { return '[已隐藏链接]'; } }).replace(/(token|cookie|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
  return value;
}
function useMediaUrls(draft: ContentDraft | undefined) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = draft?.media.map(item => item.id).join('|') || '';
  useEffect(() => {
    let cancelled = false; const created: string[] = [];
    setUrls({});
    void Promise.all((draft?.media || []).map(async item => { const record = await getMedia(item.id); if (!record || cancelled) return undefined; const url = URL.createObjectURL(record.blob); created.push(url); return [item.id, url] as const; })).then(entries => { if (!cancelled) setUrls(Object.fromEntries(entries.filter((item): item is readonly [string, string] => !!item))); }).catch(() => { if (!cancelled) setUrls({}); });
    return () => { cancelled = true; created.forEach(url => URL.revokeObjectURL(url)); };
  }, [key]);
  return urls;
}

export default function App({ compact = false }: { compact?: boolean }) {
  const [workspace, setWorkspace] = useState<WorkspaceData>();
  const [draft, setDraft] = useState<ContentDraft>();
  const [loadError, setLoadError] = useState('');
  const [dismissedBatch,setDismissedBatch]=useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'conflict' | 'error'>('saved');
  const [saveIssue, setSaveIssue] = useState('');
  const [busy, setBusy] = useState('');
  const [titleComposition,setTitleComposition]=useState<string>();
  const titleComposing=useRef(false);
  const selectedPlatforms=draft?(workspace?.platformSelections?.[draft.type]||[]):[];
  const [groupInput, setGroupInput] = useState('');
  const [groupDirty, setGroupDirty] = useState(false);
  const [reviewId,setReviewId]=useState('');const [reviewUrl,setReviewUrl]=useState('');const [reviewVisibility,setReviewVisibility]=useState<'public'|'processing'>('public');
  const [deleteId, setDeleteId] = useState('');
  const [tagInput,setTagInput] = useState('');
  const [fixedInput,setFixedInput]=useState('');const fixedDirty=useRef(false);
  const [drawerOpen,setDrawerOpen] = useState(false);
  const [cardOpen,setCardOpen]=useState(false);
  const [overflowOpen,setOverflowOpen]=useState(false);const [dragging,setDragging]=useState(false);const dragDepth=useRef(0);useScrollLock(drawerOpen);
  const [recordsOpen,setRecordsOpen] = useState(false);
  const [dismissedIssues,setDismissedIssues]=useState<string[]>(()=>{try{return JSON.parse(sessionStorage.getItem('ling-sync-dismissed-issues')||'[]');}catch{return [];}});
  const selectAllRef=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(selectAllRef.current&&draft)selectAllRef.current.indeterminate=selectedPlatforms.length>0&&selectedPlatforms.length!==selectablePlatforms(draft.type).length;},[selectedPlatforms.join('|'),draft?.type,workspace]);
  const drawerRef = useRef<HTMLElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const busyRef=useRef('');
  const [preview, setPreview] = useState(false);
  const draftRef = useRef<ContentDraft | undefined>(undefined);
  const dirty = useRef(false); const changes = useRef(0); const blocked = useRef(false);
  const savePromise = useRef<Promise<ContentDraft | undefined> | undefined>(undefined);
  const initialized = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const urls = useMediaUrls(draft);
  const contentLocked=['copy','type','new','switch','reload-draft','delete','sync'].includes(busy);

  const assignDraft = useCallback((value: ContentDraft) => { if(draftRef.current?.id !== value.id)setTagInput(value.tags.join('，')); draftRef.current = value; setDraft(value); }, []);
  const refresh = useCallback(async () => {
    const data = await api.workspace(); setWorkspace(data); setLoadError('');
    if (!initialized.current) {
      initialized.current = true; setGroupInput(data.settings.zsxqGroupId);
      const resumeId=compact?await sidebarDraftId():undefined;
      assignDraft(data.drafts.find(d=>d.id===resumeId)||newDraft('post'));
      setFixedInput((data.settings.fixedTags||[]).join('，'));
    } else if (draftRef.current && !dirty.current && !savePromise.current) {
      const latest = data.drafts.find(item => item.id === draftRef.current?.id);
      if (latest && latest.revision > draftRef.current.revision) { assignDraft(latest); setTagInput(latest.tags.join('，')); }
    }
    return data;
  }, [assignDraft, compact]);
  useEffect(() => {
    let active=true,inFlight=false,again=false;let timer:number|undefined;
    const update=async()=>{if(!active)return;if(inFlight){again=true;return;}inFlight=true;try{await refresh();}catch(error){if(active)setLoadError(errorText(error));}finally{inFlight=false;if(again&&active){again=false;timer=window.setTimeout(()=>void update(),100);}}};
    const changed=(message:{channel?:string})=>{if(message?.channel!=='ling-sync-changed')return;window.clearTimeout(timer);timer=window.setTimeout(()=>void update(),100);};
    const visible=()=>{if(document.visibilityState==='visible')void update();};
    void update();const interval=window.setInterval(visible,15000);
    chrome.runtime?.onMessage?.addListener(changed);document.addEventListener('visibilitychange',visible);
    return()=>{active=false;window.clearInterval(interval);window.clearTimeout(timer);chrome.runtime?.onMessage?.removeListener(changed);document.removeEventListener('visibilitychange',visible);};
  }, [refresh]);
  useEffect(() => { if (workspace && !groupDirty) setGroupInput(workspace.settings.zsxqGroupId); }, [workspace?.settings.zsxqGroupId, groupDirty]);

  useEffect(()=>{if(compact&&draft?.id)void rememberSidebarDraft(draft.id);},[compact,draft?.id]);
  useEffect(()=>{if(!fixedDirty.current)setFixedInput((workspace?.settings.fixedTags||[]).join('，'));},[workspace?.settings.fixedTags?.join('|')]);

  const save = useCallback(async (): Promise<ContentDraft | undefined> => {
    if (savePromise.current) { await savePromise.current; if (dirty.current && !blocked.current) return save(); return draftRef.current; }
    if (!draftRef.current || !dirty.current) return draftRef.current;
    if (blocked.current) throw new Error('请先处理草稿保存问题，本地内容仍保留在当前窗口。');
    const snapshot = structuredClone(draftRef.current); const version = changes.current;
    setSaveState('saving');
    const pending = api.saveDraft(snapshot, snapshot.revision).then(saved => {
      if (draftRef.current?.id === saved.id) {
        if (version === changes.current) { assignDraft(saved); dirty.current = false; setSaveState('saved'); }
        else { assignDraft({ ...draftRef.current, revision: saved.revision, updatedAt: saved.updatedAt }); setSaveState('dirty'); }
      }
      setWorkspace(current => current ? { ...current, drafts: [saved, ...current.drafts.filter(item => item.id !== saved.id)] } : current);
      setSaveIssue(''); return saved;
    }).catch(error => {
      const message = errorText(error); blocked.current = true; setSaveIssue(message);
      setSaveState(/另一个窗口|revision|conflict|冲突/i.test(message) ? 'conflict' : 'error'); throw error;
    }).finally(() => { savePromise.current = undefined; });
    savePromise.current = pending; return pending;
  }, [assignDraft]);
  useEffect(() => {
    if (saveState !== 'dirty') return;
    const timeout = window.setTimeout(() => { void save().catch(() => undefined); }, 700);
    return () => window.clearTimeout(timeout);
  }, [draft, saveState, save, compact]);
  useEffect(() => { const protect = (event: BeforeUnloadEvent) => { if (dirty.current) event.preventDefault(); }; window.addEventListener('beforeunload', protect); return () => window.removeEventListener('beforeunload', protect); }, []);

  const edit = (patch: Partial<ContentDraft>) => {
    if (!draftRef.current) return;
    dirty.current = true; changes.current++; assignDraft({ ...draftRef.current, ...patch });
    if (!blocked.current) setSaveState('dirty');
  };
  const editTitle = (value:string) => {
    const previous=draftRef.current?.title||'';
    const next=limitTitleEdit(previous,value);
    if(next!==value)setNotice({text:'标题最多20字，超出的输入未加入标题。',error:true});
    edit({title:next});
  };
  const editTags = (value: string) => {
    const tags = value.split(/[,，\n]+/).map(tag => tag.trim()).filter(Boolean);
    if (tags.length > 30 || tags.some(tag => tag.length > 100)) {
      setNotice({ text: '最多 30 个标签，每个标签不超过 100 字符。', error: true });
      return;
    }
    setTagInput(value); edit({ tags });
  };
  const action = async (key: string, operation: () => Promise<unknown>, success?: string) => {
    if (busyRef.current) return; busyRef.current=key; setBusy(key); setNotice(undefined);
    try { await operation(); await refresh(); if (success) setNotice({ text: success, error: false }); }
    catch (error) { setNotice({ text: errorText(error), error: true }); }
    finally { busyRef.current=''; setBusy(''); }
  };
  const clean = (value:ContentDraft) => { assignDraft(value); setTagInput(value.tags.join('，')); dirty.current=false; blocked.current=false; setSaveIssue(''); setSaveState('saved'); };
  const cloneDraft = async (source:ContentDraft,type=source.type) => {
    const copy={...newDraft(type),title:source.title,markdown:source.markdown,tags:[...source.tags],videoSource:source.videoSource,sourceUrl:source.sourceUrl,bilibiliCategory:source.bilibiliCategory,media:[] as MediaRef[]};
    const replacements=new Map<string,string>();
    try {
      for(const item of source.media) {
        const record=await getMedia(item.id);
        if(!record)throw new Error(`附件“${item.name}”无法读取，请先导出文字并检查本地存储。`);
        const media=await addMedia(new File([record.blob],item.name,{type:item.mime}),copy.id,item.kind);
        copy.media.push(media);replacements.set(item.id,media.id);
      }
      copy.markdown=copy.markdown.replace(/ling-media:\/\/([a-f0-9-]+)/g,(match,id:string)=>replacements.has(id)?`ling-media://${replacements.get(id)}`:match);
      return await api.saveDraft(copy,0);
    }catch(error){await Promise.allSettled(copy.media.map(item=>removeMedia(item.id)));throw error;}
  };
  const switchDraft = (id:string) => action('switch',async()=>{
    if(id===draftRef.current?.id)return;
    await save();const data=await api.workspace();const next=data.drafts.find(item=>item.id===id);
    if(!next)throw new Error('草稿已不在本地，请重新选择。');clean(next);setPreview(false);
  });
  const createDraft=()=>action('new',async()=>{await save();clean(newDraft(draftRef.current?.type));setPreview(false);});
  const switchType=(type:ContentType)=>action('type',async()=>{
    if(!draftRef.current||draftRef.current.type===type)return;
    await save();const source=draftRef.current!;
    if(hasContent(source)){clean(await cloneDraft(source,type));setNotice({text:'已另存为新类型，原稿和附件保持不变。',error:false});}
    else clean(await api.saveDraft({...source,type},source.revision));
    setPreview(false);
  });
  const saveCopy=()=>action('copy',async()=>{if(draftRef.current)clean(await cloneDraft(structuredClone(draftRef.current)));},'已另存副本，原稿保持不变。');
  const reloadDraft = () => action('reload-draft', async () => {
    const latest = (await api.workspace()).drafts.find(item => item.id === draftRef.current?.id);
    if (!latest) throw new Error('原草稿已不存在，请另存副本保留当前内容。');
    clean(latest);
  });
  const attachMedia = async (files:File[],kind:MediaRef['kind']) => {
    if(!files.length||contentLocked||busyRef.current||blocked.current)return;
    await action('media', async () => {
      await save(); const id = draftRef.current?.id; if (!id) return;
      if(kind!=='image' && (files.length>1||draftRef.current?.media.some(item=>item.kind===kind)))throw new Error(`每篇仅保留一个${mediaLabels[kind]}，请先移除原附件。`);
      for (const file of files) { if ((draftRef.current?.media.length || 0) >= 50) throw new Error('每篇最多添加 50 个附件，已加入的附件仍保留。'); const media = await addMedia(file, id, kind); if (draftRef.current?.id !== id) break; edit({ media: [...draftRef.current.media, media] }); }
      await save();
    });
  };
  const attachFiles = async (event: ChangeEvent<HTMLInputElement>, kind:MediaRef['kind']) => {const files=Array.from(event.target.files||[]);event.target.value='';await attachMedia(files,kind);};
  const moveMedia = (index: number, direction: number) => {
    if (!draftRef.current) return; const media = [...draftRef.current.media]; const target = index + direction;
    if (target < 0 || target >= media.length) return;
    [media[index], media[target]] = [media[target]!, media[index]!]; edit({ media });
  };
  const exportDraft = () => {
    if (!draft) return;
    const attachments = draft.media.map((item, index) => `${index + 1}. [${mediaLabels[item.kind]}] ${item.name}`).join('\n');
    download(`${(draft.title || '未命名草稿').replace(/[\\/:*?"<>|]/g, '_')}.md`, `${draft.title ? `# ${draft.title}\n\n` : ''}${draft.markdown}${draft.tags.length ? `\n\n标签：${draft.tags.join('、')}` : ''}${attachments ? `\n\n---\n本地附件（文件不包含在此文本文件中）：\n${attachments}\n` : ''}`);
  };
  const startSync = (overflow?:'skip'|'images') => action('sync',async()=>{
    if(titleComposing.current)throw new Error('请先完成标题输入。');
    validateSyncTitle(draftRef.current?.title||'');
    if(!selectedPlatforms.length)throw new Error('请选择同步平台。');
    if(selectedPlatforms.includes('zsxq')&&!(workspace?.settings.zsxqTargets??(workspace?.settings.zsxqGroupId?[workspace.settings.zsxqGroupId]:[])).length)throw new Error('请在知识星球平台旁选择目标星球。');
    await save();if(!draftRef.current)return;if(!overflow&&overflowPlatforms({...draftRef.current,tags:mergeTags(workspace?.settings.fixedTags,draftRef.current.tags)},selectedPlatforms).length){setOverflowOpen(true);return;}setOverflowOpen(false);setRecordsOpen(true);const publishPlatforms=selectedPlatforms.filter(id=>workspace?.settings.directPublish&&publicationAvailable(id,draftRef.current!.type));
    const requestedAt=Date.now();const results=await api.startSync(draftRef.current.id,selectedPlatforms,publishPlatforms,overflow);
    if(results.some(t=>t.parentTaskId))setNotice({text:'已关联原填写页，直接核对并复用，不另开页面或重传附件。',error:false});
    else if(results.some(t=>t.createdAt<requestedAt))setNotice({text:'所选平台已有同步记录，已保留原结果；请从同步记录打开原页或核对结果，不重复发布。',error:false});
    else if(results.every(t=>!['queued','preparing','ready_for_confirmation'].includes(t.status))||results.some(t=>publishPlatforms.includes(t.platform)&&t.operation!=='publish'))setNotice({text:'已有记录保持原状态，请查看同步记录；未完成任务需要核对或安全重试，已提交内容不会重复发布。',error:false});
  });
  const saveGroup = () => action('group', async () => {
    if (!workspace) return; const id = groupIdFrom(groupInput); await api.settings({ zsxqGroupId: id,zsxqTargets:id?[id]:[] }); setGroupInput(id); setGroupDirty(false);
  }, '目标星球已保存。');
  const deleteDraft = () => action('delete', async () => {
    const deleting = deleteId;
    if (draftRef.current?.id === deleting) await save();
    await api.removeDraft(deleting);
    if (draftRef.current?.id === deleting) {
      const data = await api.workspace();
      const next = data.drafts[0] || await api.saveDraft(newDraft(draftRef.current?.type),0);
      clean(next);
      changes.current++; setSaveState(dirty.current ? 'dirty' : 'saved');
    }
    setDeleteId('');
  });
  const saveLabel = { saved: '已保存在本机', dirty: '等待自动保存', saving: '正在保存', conflict: '存在编辑冲突', error: '保存未完成' }[saveState];
  const openWorkbench = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('workbench.html') : '#';

  const selectPlatforms=(ids:PlatformId[])=>action('selection',()=>api.setPlatformSelection(draftRef.current!.type,ids));
  useEffect(() => {
    if(!drawerOpen)return;
    const previous=document.activeElement as HTMLElement|null;
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keyboard=(event:KeyboardEvent)=>{
      if(document.querySelector('.issue-dialog'))return;
      if(event.key==='Escape'){event.preventDefault();setDrawerOpen(false);}
      if(event.key!=='Tab')return;
      const controls=Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],select:not(:disabled),summary')||[]);
      const first=controls[0],last=controls.at(-1);
      if(!first||!last)return;
      if(event.shiftKey&&(document.activeElement===first||!drawerRef.current?.contains(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',keyboard);
    return()=>{document.removeEventListener('keydown',keyboard);(previous||settingsButton.current)?.focus();};
  },[drawerOpen]);
  const exportDiagnostics=()=>{
    if(!workspace)return;
    const data={version:chrome.runtime.getManifest().version,exportedAt:Date.now(),accounts:workspace.accounts.map(({platform,status,checkedAt})=>({platform,status,checkedAt})),tasks:workspace.tasks.map(({id,platform,status,createdAt,updatedAt,error,progress,operation})=>({id,platform,status,createdAt,updatedAt,error,progress,operation})),logs:workspace.logs};
    download(`灵同步诊断-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(safeDiagnostic(data),null,2),'application/json');
  };
  const exportBackup=async(id:string)=>{await action('export-backup',async()=>{const backup=await api.exportBackup(id);download(`知识星球原稿-${backup.targetId}.txt`,backup.text);});};
  const taskIssue=workspace?.tasks.filter(t=>t.snapshot.id===draft?.id&&t.error&&['EDITOR_OCCUPIED','LOGIN_REQUIRED','VERIFICATION_REQUIRED','ZSXQ_EDITOR_STALE','X_LONG_TEXT_INELIGIBLE','X_LONG_TEXT_UNKNOWN'].includes(t.error.code)&&!t.supersededByTaskId&&['failed','ready_for_confirmation'].includes(t.status)&&!t.publicationAttemptedAt).filter((task,index,items)=>items.findIndex(other=>other.platform===task.platform&&other.error?.code===task.error?.code)===index).map(task=>({task,key:`task:${task.id}:${task.error!.code}`})).find(issue=>!dismissedIssues.includes(issue.key));
  const issue=overflowOpen?undefined:taskIssue;
  const dismissIssue=()=>{if(!issue)return;const keys=[...dismissedIssues,issue.key].slice(-200);setDismissedIssues(keys);sessionStorage.setItem('ling-sync-dismissed-issues',JSON.stringify(keys));};
  const issueView=issue?.task&&<IssueDialog task={issue.task} busy={!!busy} onClose={dismissIssue} onOpen={()=>void action('open-issue',()=>api.openTask(issue.task!.id))} onRestore={id=>void action('restore-backup',()=>api.restoreBackup(id))} onExport={id=>void exportBackup(id)}/>;
  const taskView=(task:TaskSummary)=><article className="record-row" key={task.id}>
    <div className="record-main">
      <div className="record-title"><span>{platformFor(task.platform).name}{task.targetName?` · ${task.targetName}`:''}</span><strong>{task.snapshot.title||'未命名内容'}</strong></div>
      <small className="record-time">同步于 {time(task.createdAt)}</small>{task.snapshot.textAsImages&&<small>正文转图片 · 平台正文仅标签</small>}<p>{task.progress}</p>{task.supersededByTaskId&&<small>已由后续任务继续，此记录仅保留历史。</small>}
      {task.error&&<p className="error-copy">{task.error.message}</p>}
      {task.status==='unknown'&&<p className="warning-copy">平台操作可能已经发生，请先核对，避免重复提交或上传。</p>}
      {task.saveNotice&&<p className="warning-copy">{task.saveNotice}</p>}
      {task.evidence&&task.evidence.kind!=='publication_receipt'&&<small className="evidence"><ShieldCheck size={12}/>{task.evidence.kind==='publication_result'?'已核对发布结果':task.evidence.kind==='editor_reload'?'已重新打开核对':'已核对编辑器'} · 正文{task.evidence.bodyMatched?'匹配':'待核对'} · {task.evidence.mediaCount} 个媒体</small>}
      <div className="record-actions">{workspace?.backups?.filter(b=>b.taskId===task.id&&b.state!=='restored').map(backup=><span className="backup-actions" key={backup.id}><span className="backup-note">{task.status==='published'?'已发布，原稿恢复待处理':'本地原稿备份 · 发布状态见记录'}{backup.note&&<small>{backup.note}</small>}</span><button className="text-button" disabled={!!busy||!(task.status==='published'||task.status==='failed'&&!task.publicationAttemptedAt&&!task.proof?.uploadedMediaIds?.length)} onClick={()=>void action('restore-backup',()=>api.restoreBackup(backup.id))}>核对并恢复原稿</button><button className="text-button" onClick={()=>void exportBackup(backup.id)}>导出原稿备份</button></span>)}
        {task.error?.code==='PERMISSION_REQUIRED'&&<button className="text-button" onClick={()=>setDrawerOpen(true)}>连接{platformFor(task.platform).name}</button>}
        {task.snapshot.type==='post'&&publicationAvailable(task.platform,'post')&&['filled','failed','ready_for_confirmation'].includes(task.status)&&!task.supersededByTaskId&&task.error?.code!=='CANCELLED_FOR_RESTORE'&&!task.publicationAttemptedAt&&!!task.proof?.bodyDigest&&task.tabId!==undefined&&<button className="text-button" disabled={!!busy} onClick={()=>void action('prepare-publication',()=>api.preparePublication(task.id),'准备完成，停在待发布；尚未提交。')}>准备发布</button>}
        {task.snapshot.type==='post'&&publicationAvailable(task.platform,'post')&&['filled','failed','ready_for_confirmation'].includes(task.status)&&!task.supersededByTaskId&&task.error?.code!=='CANCELLED_FOR_RESTORE'&&!task.publicationAttemptedAt&&!!task.proof?.bodyDigest&&task.tabId!==undefined&&<button className="text-button" disabled={!!busy} onClick={()=>void action('check-publication',()=>api.checkPublication(task.id),'发布条件检查通过，尚未发布；提交前仍会重新检查内容。')}>检查发布条件</button>}
        {['failed','ready_for_confirmation'].includes(task.status)&&!task.supersededByTaskId&&task.operation==='publish'&&task.error?.code!=='CANCELLED_FOR_RESTORE'&&!task.publicationAttemptedAt&&!!task.proof?.bodyDigest&&task.tabId!==undefined&&<button className="text-button" disabled={!!busy} onClick={()=>void action(task.id,()=>api.resumePublication(task.id))}>继续发布</button>}
        {task.status==='failed'&&!task.supersededByTaskId&&task.error?.retrySafe&&(task.operation!=='publish'||!task.proof?.bodyDigest&&!task.publicationAttemptedAt)&&<button className="text-button" disabled={!!busy} onClick={()=>void action(task.id,()=>api.retry(task.id))}><RefreshCw size={13}/>{task.operation==='publish'?'重新准备并发布':'重试'}</button>}
        {(task.status==='unknown'||task.status==='failed'&&task.error?.code==='FILL_UNCONFIRMED')&&!task.publicationAttemptedAt&&['fill','publish'].includes(task.operation||'')&&(task.snapshot.type==='post'&&['UPLOAD_UNCONFIRMED','READBACK_FAILED','FILL_UNCONFIRMED','EDITOR_UNAVAILABLE','EDITOR_SCRIPT_FAILED','MEDIA_ORDER'].includes(task.error?.code||'')||task.snapshot.type==='video'&&task.platform==='douyin'&&task.error?.code==='UPLOAD_UNCONFIRMED'&&task.proof?.uploadedMediaIds?.length===1)&&<button className="text-button" disabled={!!busy} onClick={()=>void action(task.id,()=>api.recoverFill(task.id))}>{task.snapshot.type==='video'?'核对已有视频并继续填写':'核对图片并恢复空字段'}</button>}
        {(['unknown','submitted'].includes(task.status)||task.status==='filled'&&task.operation==='fill')&&<button className="text-button" disabled={!!busy} onClick={()=>void action(task.id,()=>api.verify(task.id))}><RefreshCw size={13}/>核对结果</button>}
        {task.operation==='publish'&&!['CANCELLED_FOR_RESTORE','POST_LIMIT_SKIPPED'].includes(task.error?.code||'')&&['unknown','submitted','failed'].includes(task.status)&&<button className="text-button" onClick={()=>{setReviewId(reviewId===task.id?'':task.id);setReviewUrl(task.publicationResult?.url||'');setReviewVisibility('public');}}>人工确认结果</button>}
        {<button className="text-button" disabled={!!busy} onClick={()=>void action(`open-${task.id}`,()=>api.openTask(task.id))}>打开{platformFor(task.platform).name}<ExternalLink size={12}/></button>}
      </div>
    {reviewId===task.id&&<form className="manual-review" onSubmit={event=>{event.preventDefault();void action('manual-review',async()=>{await api.confirmPublicationResult(task.id,reviewUrl,reviewVisibility);setReviewId('');});}}><label>平台结果链接<input required type="url" aria-label="平台结果链接" value={reviewUrl} onChange={e=>setReviewUrl(e.target.value)}/></label><label>平台状态<select aria-label="人工核对的平台状态" value={reviewVisibility} onChange={e=>setReviewVisibility(e.target.value as 'public'|'processing')}><option value="public">已公开，正文和媒体顺序已核对</option><option value="processing">平台已接收，审核或处理中</option></select></label><button className="text-button" type="submit" disabled={!!busy}>确认我的人工验收</button></form>}
    </div>
    <div className="record-meta"><span className={`status status-${task.status}`}>{['preparing','saving_draft','publishing'].includes(task.status)&&<Loader2 size={12} className="spin"/>}{task.error?.code==='CANCELLED_FOR_RESTORE'?'已取消':task.error?.code==='POST_LIMIT_SKIPPED'?'已跳过':statusLabels[task.status]}</span><time>{time(task.updatedAt)}</time></div>
  </article>;
  const syncing=workspace?.tasks.filter(task=>(['queued','preparing','saving_draft','publishing'].includes(task.status)||task.status==='ready_for_confirmation'&&task.autoRun))||[];
  const legacyQueue=workspace?.tasks.filter(task=>['queued','ready_for_confirmation'].includes(task.status)&&!task.autoRun)||[];
  const publishingTargets=selectedPlatforms.filter(id=>workspace?.settings.directPublish&&draft&&publicationAvailable(id,draft.type));
  const currentTasks=workspace?.tasks.filter(task=>task.snapshot.id===draft?.id)||[];
  const currentTargets=[...new Set(currentTasks.filter(task=>task.batchId===currentTasks[0]?.batchId).map(task=>task.platform))];
  const latestBatch=currentTasks[0]?.batchId;
  const batchTasks=workspace?.tasks.filter(t=>t.batchId===latestBatch)||[];
  const batch=batchSummary(batchTasks);
  const batchPaused=!batch.done&&batchTasks.filter(t=>['queued','preparing','ready_for_confirmation','saving_draft','publishing'].includes(t.status)).every(t=>!t.autoRun);
  const inlineIssues=batch.issues.filter(t=>!['EDITOR_OCCUPIED','LOGIN_REQUIRED','VERIFICATION_REQUIRED','ZSXQ_EDITOR_STALE'].includes(t.error?.code||''));
  const batchKey=batchTasks.map(t=>t.id+':'+t.status).sort().join('|');
  const batchView=batchTasks.length&&dismissedBatch!==batchKey?<div className={`notice ${inlineIssues.length?'notice-error':''}`} role={inlineIssues.length?'alert':'status'}><div className="batch-details"><span>{batch.done?'同步已结束':batchPaused?'等待继续执行':'同步进行中'} · 已处理 {batch.completed}/{batchTasks.length}</span><span>已填写 {batch.counts.filled} · 已提交 {batch.counts.submitted} · 已发布 {batch.counts.published} · 失败 {batch.counts.failed} · 待核对 {batch.counts.unknown}</span>{inlineIssues.map(t=><div key={t.id}>{platformFor(t.platform).name}：{t.error?.message||t.progress}<button className="text-button" disabled={!!busy} onClick={()=>void action(`open-${t.id}`,()=>api.openTask(t.id))}>打开原任务</button></div>)}{!batch.done&&<span>{batchTasks.find(t=>['preparing','publishing','saving_draft'].includes(t.status))?.progress||'等待逐站执行'}</span>}</div><button className="icon-button" aria-label="关闭同步提醒" onClick={()=>setDismissedBatch(batchKey)}><X size={14}/></button></div>:null;
  if(!workspace||!draft)return <div className={`app loading-screen ${compact?'compact':''}`}><Brand/><div className="loading-body">{loadError?<><h2>暂时无法读取工作台</h2><p>{loadError}</p><button className="secondary" onClick={()=>void refresh().catch(error=>setLoadError(errorText(error)))}>重新读取<RefreshCw size={15}/></button></>:<><Loader2 className="spin" size={20}/><p>正在读取本地内容…</p></>}</div></div>;
  const noticeView=notice&&<div className={`notice ${notice.error?'notice-error':''}`} role={notice.error?'alert':'status'}><span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice(undefined)}><X size={14}/></button></div>;
  return <div className={`app ${compact?'sidebar-editor':''}`}>
    <div className="workspace" inert={drawerOpen||!!issueView||overflowOpen}>
      <header className="topbar">
        <Brand/>
        <div className="type-segment" role="group" aria-label="内容类型">{types.map(type=><button key={type.id} aria-pressed={draft.type===type.id} className={draft.type===type.id?'selected':''} disabled={!!busy||blocked.current} onClick={()=>void switchType(type.id)}>{type.label}</button>)}</div>
        <button ref={settingsButton} className="icon-button settings-button" aria-label="设置与账号" aria-expanded={drawerOpen} onClick={()=>setDrawerOpen(true)}><Settings2 size={19}/></button>
      </header>
      <main className="editor-workspace" onDragOver={event=>{if(draft.type==='post'&&event.dataTransfer.types.includes('Files'))event.preventDefault();}} onDrop={event=>{if(draft.type==='post'&&event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(false);dragDepth.current=0;setNotice({text:'请将图片拖到添加图片的虚线框内。',error:false});}}}>
        <div className="draft-toolbar">
          <div className="draft-controls"><label htmlFor="draft-select" className="sr-only">选择本地草稿</label><select aria-label="历史草稿" id="draft-select" value="" disabled={!!busy||blocked.current} onChange={event=>void switchDraft(event.target.value)}><option value="">历史草稿（手动加载）</option>{workspace.drafts.map(item=><option value={item.id} key={item.id}>{item.title||'未命名内容'} · {types.find(type=>type.id===item.type)?.label}</option>)}</select><button className="icon-button" title="新建内容" aria-label="新建内容" disabled={!!busy||blocked.current} onClick={()=>void createDraft()}><Plus size={17}/></button></div>
          <div className="draft-tools"><span className={`save-label ${['conflict','error'].includes(saveState)?'error-copy':''}`}>{saveState==='saving'?<Loader2 size={12} className="spin"/>:saveState==='saved'?<CheckCircle2 size={12}/>:<Clock3 size={12}/>} {saveLabel}</span><button className="icon-button" title="导出 Markdown" aria-label="导出 Markdown" onClick={exportDraft}><Download size={16}/></button><button className={`preview-button ${preview?'selected':''}`} aria-pressed={preview} onClick={()=>setPreview(!preview)}><Eye size={15}/>预览</button></div>
        </div>
        <div className="notice-region" aria-live="polite">{noticeView}{batchView}{loadError&&<div className="notice notice-error">刷新未完成：{loadError}<button className="text-button" onClick={()=>void refresh().catch(error=>setLoadError(errorText(error)))}>重试</button></div>}</div>
        {saveIssue&&<section className="save-problem" role="alert"><strong>{saveState==='conflict'?'本窗口的修改仍保留着':'当前修改还未保存'}</strong><p>{saveIssue}</p><div><button className="secondary" disabled={!!busy} onClick={()=>void saveCopy()}>另存副本</button>{saveState==='conflict'?<button className="text-button" disabled={!!busy} onClick={()=>void reloadDraft()}>放弃修改并加载最新版</button>:<button className="text-button" disabled={!!busy} onClick={()=>void action('retry-save',async()=>{blocked.current=false;await save();})}>重试保存</button>}<button className="text-button" onClick={exportDraft}>导出当前文字</button></div></section>}
        <div className={`editor-columns ${preview?'with-preview':''}`}>
          <section className="writing-pane" aria-label="内容编辑">
            <label className="sr-only" htmlFor="draft-title">标题</label><input id="draft-title" className="title-input" disabled={contentLocked} maxLength={titleComposition===undefined?Math.max(TITLE_MAX,draft.title.length):500} aria-describedby="title-limit" aria-invalid={draft.title.length>TITLE_MAX} placeholder={draft.type==='post'?'标题（可选）':draft.type==='video'?'视频标题':'文章标题'} value={titleComposition??draft.title} onCompositionStart={()=>{titleComposing.current=true;setTitleComposition(draftRef.current?.title||'');}} onCompositionEnd={event=>{titleComposing.current=false;setTitleComposition(undefined);editTitle(event.currentTarget.value);}} onChange={event=>{if(titleComposing.current)setTitleComposition(event.target.value);else editTitle(event.target.value);}} onPaste={event=>{if(titleComposing.current)return;const input=event.currentTarget;const next=input.value.slice(0,input.selectionStart??0)+event.clipboardData.getData('text')+input.value.slice(input.selectionEnd??input.value.length);if(next.length>TITLE_MAX){event.preventDefault();editTitle(next);}}}/>
            <small id="title-limit" className={`title-limit ${draft.title.length>TITLE_MAX?'error-copy':''}`} aria-live="polite">{draft.title.length}/{TITLE_MAX} · {draft.title.length>TITLE_MAX?'旧标题已完整保留，请缩短后同步':'标题最多20字'}</small>
            <label className="sr-only" htmlFor="draft-markdown">{draft.type==='video'?'视频说明':'正文'}</label><textarea id="draft-markdown" className="markdown-input" disabled={contentLocked} maxLength={500000} placeholder={draft.type==='video'?'写下视频说明…':draft.type==='post'?'分享此刻的想法…':'从这里开始写…\n\n支持 Markdown 排版。'} value={draft.markdown} onChange={event=>edit({markdown:event.target.value})} spellCheck={false} onPaste={event=>{if(draft.type!=='post')return;const items=[...event.clipboardData.items].filter(i=>i.kind==='file'&&i.type.startsWith('image/'));if(!items.length)return;event.preventDefault();const text=event.clipboardData.getData('text/plain');if(text){const input=event.currentTarget;edit({markdown:draft.markdown.slice(0,input.selectionStart)+text+draft.markdown.slice(input.selectionEnd)});}const files=items.map(i=>i.getAsFile()).filter((f):f is File=>!!f);void attachMedia(files,'image');}}/>
            <div className="editor-meta"><span>{draft.markdown.length.toLocaleString('zh-CN')} 字符</span><span>{draft.type==='article'?'Markdown':types.find(type=>type.id===draft.type)?.label}</span></div>
            <div className="tag-field"><label htmlFor="fixed-tags">固定标签 <small>每次新建自动带入</small></label><input id="fixed-tags" disabled={contentLocked} value={fixedInput} placeholder="用逗号分隔" onChange={e=>{fixedDirty.current=true;setFixedInput(e.target.value);}} onBlur={()=>{if(!fixedDirty.current)return;const tags=mergeTags([],fixedInput.split(/[,，\n]+/));if(tags.length>30||tags.some(t=>t.length>100)){setNotice({text:'最多30个固定标签，每个不超过100字符',error:true});return;}void action('fixed-tags',async()=>{await api.settings({fixedTags:tags});fixedDirty.current=false;});}}/></div><div className="tag-field"><label htmlFor="draft-tags">普通标签</label><input id="draft-tags" disabled={contentLocked} value={tagInput} placeholder="用逗号分隔，最多 30 个" onChange={event=>editTags(event.target.value)}/></div>
            {draft.type==='video'&&<details className="video-options"><summary>视频平台选项</summary><label>B站／视频号来源<select aria-label="视频来源" disabled={contentLocked} value={draft.videoSource||''} onChange={e=>edit({videoSource:e.target.value?e.target.value as ContentDraft['videoSource']:undefined})}><option value="">请选择，不自动声明原创</option><option value="original">原创／自制</option><option value="repost">转载</option></select></label>{draft.videoSource==='repost'&&<label>B站转载来源链接<input aria-label="转载来源链接" disabled={contentLocked} value={draft.sourceUrl||''} onChange={e=>edit({sourceUrl:e.target.value})}/></label>}<label>B站分区<input aria-label="B站分区" placeholder="填写原生页面的分区名称" disabled={contentLocked} value={draft.bilibiliCategory||''} onChange={e=>edit({bilibiliCategory:e.target.value})}/></label><small>B站发布需分区、来源和标签；视频号发布需明确来源。平台条件未满足时会保留任务。</small></details>}
          </section>
          {preview&&<section className="preview-pane" aria-label="内容预览"><div className="preview-heading">预览<span>平台排版可能不同</span></div>{draft.title&&<h1>{draft.title}</h1>}{draft.markdown?<div className="prose" dangerouslySetInnerHTML={{__html:renderMarkdown(draft.markdown,urls)}}/>:<p className="muted">内容将在这里出现。</p>}<div className="preview-media">{draft.media.map(item=>urls[item.id]&&(item.kind==='video'?<video key={item.id} src={urls[item.id]} controls preload="metadata" aria-label={item.name}/>:<img key={item.id} src={urls[item.id]} alt={item.name}/>))}</div>{mergeTags(workspace.settings.fixedTags,draft.tags).length>0&&<p className="preview-tags">{mergeTags(workspace.settings.fixedTags,draft.tags).map(tag=>`#${tag}`).join(' ')}</p>}</section>}
        </div>
        {draft.type==='post'&&<section className="text-card-section"><button className="secondary" aria-expanded={cardOpen} onClick={()=>setCardOpen(!cardOpen)}><FileImage size={15}/>文字卡片 · 3:4<ChevronDown size={14}/></button>{cardOpen&&<CardEditor draft={{...draft,tags:mergeTags(workspace.settings.fixedTags,draft.tags)}} disabled={contentLocked||blocked.current} onChange={cardStyle=>edit({cardStyle})}/>}</section>}
        <section className="media-section" aria-label="附件">
          <div className="media-toolbar"><span className="section-label">附件{draft.media.length>0&&` · ${draft.media.length}`}</span><div className="media-add-actions"><button className="text-button" disabled={draft.type==='video'||!!busy||blocked.current||draft.media.length>=50} onClick={()=>fileInput.current?.click()}><ImagePlus size={15}/>图片</button>{draft.type==='video'&&<><button className="text-button" disabled={!!busy||blocked.current||draft.media.some(item=>item.kind==='video')} onClick={()=>videoInput.current?.click()}><Video size={15}/>视频</button><button className="text-button" disabled={!!busy||blocked.current||draft.media.some(item=>item.kind==='cover')} onClick={()=>coverInput.current?.click()}><FileImage size={15}/>封面</button></>}</div></div>
          {draft.type==='post'&&<button type="button" className={`image-dropzone ${dragging?'dragging':''}`} disabled={contentLocked||!!busy||blocked.current||draft.media.length>=50} onClick={()=>fileInput.current?.click()} onDragEnter={event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();dragDepth.current++;setDragging(true);}} onDragLeave={event=>{event.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);}}} onDragOver={event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';}} onDrop={event=>{event.preventDefault();event.stopPropagation();dragDepth.current=0;setDragging(false);const files=[...event.dataTransfer.files];if(files.some(file=>!file.type.startsWith('image/'))){setNotice({text:'拖拽区域仅接收本地图片，请选择 PNG、JPEG、WebP 或 GIF。',error:true});return;}void attachMedia(files,'image');}}><ImagePlus size={22}/><strong>{dragging?'松开以添加图片':'拖拽图片到这里，或点击添加'}</strong><span>也可在正文处粘贴图片 · 每张 ≤ 15 MB</span></button>}
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event=>void attachFiles(event,'image')}/><input ref={videoInput} type="file" accept="video/mp4,video/webm,video/quicktime,.mov" hidden onChange={event=>void attachFiles(event,'video')}/><input ref={coverInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={event=>void attachFiles(event,'cover')}/>
          {draft.media.length>0?<ol className="media-list">{draft.media.map((item,index)=><li key={item.id}><div className="media-thumb">{urls[item.id]?item.kind==='video'?<video src={urls[item.id]} preload="metadata" muted/>:<img src={urls[item.id]} alt=""/>:item.kind==='video'?<Video size={18}/>:<FileImage size={18}/>}</div><div className="media-detail"><span>{item.name}</span><small>{mediaLabels[item.kind]} · {(item.bytes/1024/1024).toFixed(2)} MB{item.duration!==undefined?` · ${Math.round(item.duration)} 秒`:''}{draft.type!=='video'&&item.kind!=='image'?' · 切换类型时保留':''}</small></div><div className="media-actions"><button className="icon-button" aria-label={`上移${item.name}`} disabled={index===0||!!busy} onClick={()=>moveMedia(index,-1)}><ArrowUp size={14}/></button><button className="icon-button" aria-label={`下移${item.name}`} disabled={index===draft.media.length-1||!!busy} onClick={()=>moveMedia(index,1)}><ArrowDown size={14}/></button><button className="icon-button" aria-label={`移除${item.name}`} disabled={!!busy||blocked.current} onClick={()=>void action(`remove-${item.id}`,async()=>{edit({media:draftRef.current!.media.filter(media=>media.id!==item.id)});await save();await removeMedia(item.id);})}><X size={14}/></button></div></li>)}</ol>:<p className="attachment-hint">{draft.type==='video'?'一个视频、一个封面。图片 ≤ 15 MB，视频 ≤ 1 GB。':'添加本地图片，按附件顺序写入。每张 ≤ 15 MB。'}</p>}
        </section>
        <section className="sync-records"><button className="records-toggle" aria-expanded={recordsOpen} onClick={()=>setRecordsOpen(!recordsOpen)}><span>同步记录<span className="count">{workspace.history?.retained??workspace.tasks.length}</span></span><span>{syncing.length>0&&<small>{syncing.length} 项进行中</small>}<ChevronDown className={recordsOpen?'rotated':''} size={15}/></span></button>{recordsOpen&&<div className="records-content">{workspace.history&&<p className="history-caption">保留最近 {workspace.history.limit} 条历史{workspace.history.protected>0?` · 另有 ${workspace.history.protected} 条进行中或待核对记录`:""}</p>}{legacyQueue.length>0&&<div className="legacy-queue"><span>{legacyQueue.length} 个旧任务等待继续。</span><button className="text-button" disabled={!!busy} onClick={()=>void action('continue-queue',()=>api.continueQueue())}>继续同步<RefreshCw size={13}/></button></div>}{workspace.tasks.length?workspace.tasks.map(taskView):<p className="empty-records">选择下方平台并开始同步，结果会记录在这里。</p>}</div>}</section>
      </main>
      <footer className="sync-dock"><div className="sync-dock-inner"><div className="platform-selection"><div className="platform-selection-heading"><span className="section-label">同步到</span><label className="select-all"><input ref={selectAllRef} type="checkbox" aria-label="全选平台" checked={selectedPlatforms.length===selectablePlatforms(draft.type).length} disabled={!!busy} onChange={e=>void selectPlatforms(e.target.checked?selectablePlatforms(draft.type):[])}/>全选</label><label className="direct-publish-toggle"><input type="checkbox" aria-label="直接发布" checked={!!workspace.settings.directPublish} disabled={!!busy} onChange={event=>{const enabled=event.target.checked;void action('publish-master',()=>api.settings({directPublish:enabled}));}}/>直接发布</label></div><div className="platform-chips">{platforms.map(platform=>{
        const selected=selectedPlatforms.includes(platform.id),capability=capabilityFor(platform.id,draft.type);const unavailable=!capability||capability.verification==='unimplemented';
        const operation=syncOperation(platform.id,draft,workspace.settings);const reason=unavailable?'此类型尚未适配':`${operation==='publish'?'直接发布':operation==='save_draft'?'保存草稿':'仅填写'} · ${capability?.verification==='pending'?'待验证':'已实测'}`;
        return <div className="platform-target" key={platform.id}><button className={`platform-chip ${selected?'selected':''}`} aria-pressed={selected} disabled={unavailable||!!busy} title={`${platform.name} · ${reason}`} onClick={()=>void selectPlatforms(selected?selectedPlatforms.filter(id=>id!==platform.id):[...selectedPlatforms,platform.id])}>{selected&&<Check size={12}/>} {platform.name}</button>{selected&&platform.id==='zsxq'&&<TargetPicker platform="zsxq" selected={workspace.settings.zsxqTargets??(workspace.settings.zsxqGroupId?[workspace.settings.zsxqGroupId]:[])} disabled={!!busy} onChange={ids=>void action('star-targets',()=>api.settings({zsxqTargets:ids,zsxqGroupId:ids[0]||''}))}/>} {selected&&platform.id==='jike'&&<TargetPicker platform="jike" selected={workspace.settings.jikeCircle?[workspace.settings.jikeCircle]:[]} disabled={!!busy} onChange={ids=>void action('jike-target',()=>api.settings({jikeCircle:ids[0]||''}))}/>}</div>;
      })}</div></div><div className="sync-action"><button className="primary" disabled={!!busy||blocked.current||titleComposition!==undefined||draft.title.length>TITLE_MAX||!selectedPlatforms.length||!hasContent(draft)} onClick={()=>void startSync()}>{busy==='sync'&&<Loader2 size={16} className="spin"/>}{busy==='sync'?'正在同步':publishingTargets.length?'开始发布':'开始同步'}</button></div></div></footer>
    </div>
    {overflowOpen&&<OverflowDialog issues={overflowPlatforms({...draft,tags:mergeTags(workspace.settings.fixedTags,draft.tags)},selectedPlatforms)} busy={!!busy} onClose={()=>setOverflowOpen(false)} onChoose={choice=>void startSync(choice)}/>}
    {issueView}{drawerOpen&&<div className="drawer-layer" inert={!!issueView}><button className="drawer-backdrop" tabIndex={-1} aria-label="关闭设置" onClick={()=>setDrawerOpen(false)}/><aside className="settings-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="drawer-header"><h2 id="settings-title">设置与账号</h2><button className="icon-button" aria-label="关闭设置" onClick={()=>setDrawerOpen(false)}><X size={19}/></button></header><div className="drawer-body"><div aria-live="polite">{noticeView}</div><section><h3>动态图片</h3><label className="account-row"><span>无图时自动生成文字图片</span><input type="checkbox" aria-label="自动文字图片" checked={workspace.settings.autoTextImages!==false} disabled={!!busy} onChange={e=>{const enabled=e.target.checked;void action('text-images',()=>api.settings({autoTextImages:enabled}));}}/></label><p className="drawer-caption">仅用于公众号、抖音、快手、视频号和小红书的无图动态。即刻、知识星球、X 和 B站保留纯文本。原稿不会增加附件。</p></section><section><h3>发布方式</h3><p className="drawer-caption">底部直接发布开关统一作用于已勾选的平台。未开放发布的类型仍填写或保存草稿；历史任务保持原操作。平台页面默认后台执行，登录或验证时再打开。</p><details className="capability-details"><summary>当前类型的平台能力</summary>{platforms.map(p=><p key={p.id}>{p.name} · {capabilityFor(p.id,draft.type,'publish')?.verification==='verified'?'发布已实测':publicationAvailable(p.id,draft.type)?'发布待验收':'仅填写或存稿'}</p>)}</details></section><section className="drawer-section"><h3>平台账号</h3><p className="drawer-caption">使用当前浏览器的登录状态，按平台授权。</p><div className="account-list">{platforms.map(platform=>{
      const account=workspace.accounts.find(item=>item.platform===platform.id),capability=capabilityFor(platform.id,draft.type);
      return <div className="account-row" key={platform.id}><div className="account-row-header"><div><strong>{platform.name}</strong><span className={account?.status==='connected'?'connected-label':''}>{account?accountLabels[account.status]:'未授权'}{capability?.verification==='pending'?' · 待验证':capability?.verification==='unimplemented'?' · 适配待实现':''}</span></div><div className="account-actions"><button className="text-button" disabled={!!busy} onClick={()=>void action(`connect-${platform.id}`,()=>api.connect(platform.id))}>{account?.status==='connected'?'检查':'连接'}</button>{account&&account.status!=='permission_required'&&<button className="icon-button" title="取消此平台权限" aria-label={`取消${platform.name}权限`} disabled={!!busy} onClick={()=>void action(`disconnect-${platform.id}`,()=>api.disconnect(platform.id))}><X size={13}/></button>}</div></div>{account?.label&&<small className="account-note">{account.label}</small>}{account?.note&&<small className="account-note">{account.note}</small>}</div>;
    })}</div><button className="text-button" disabled={!!busy} onClick={()=>void action('refresh-accounts',()=>api.refreshAccounts())}><RefreshCw size={13}/>重新检查登录状态</button><div className="group-field"><label htmlFor="group-target">知识星球目标</label><input id="group-target" placeholder="星球链接或 ID" value={groupInput} onChange={event=>{setGroupInput(event.target.value);setGroupDirty(true);}}/><div><small>新任务使用此目标，旧任务保留原目标。</small><button className="text-button" disabled={!!busy||!groupDirty} onClick={()=>void saveGroup()}>保存</button></div></div></section><section className="drawer-section"><h3>编辑器</h3>{compact?<a className="drawer-setting-action" href={openWorkbench} target="_blank" rel="noreferrer">打开完整工作台<ExternalLink size={15}/></a>:<button className="drawer-setting-action" onClick={()=>void chrome.windows.getCurrent().then(w=>chrome.sidePanel.open({windowId:w.id!}))}>打开侧栏编辑器<ExternalLink size={15}/></button>}</section><section className="drawer-section"><h3>本地内容</h3><p className="drawer-caption">草稿和附件保存在此浏览器中。</p><button className="drawer-setting-action" onClick={exportDraft}><span>导出当前 Markdown</span><Download size={15}/></button><button className="drawer-setting-action" disabled={!!busy} onClick={()=>setDeleteId(deleteId?'':draft.id)}><span>删除当前本地草稿</span><Trash2 size={15}/></button>{deleteId&&<div className="delete-confirm"><p>删除当前本地草稿？平台内容与同步记录会保留。</p><button className="text-button error-copy" disabled={!!busy||blocked.current} onClick={()=>void deleteDraft()}>删除本地草稿</button><button className="text-button" onClick={()=>setDeleteId('')}>取消</button></div>}</section><section className="drawer-section"><h3>诊断</h3><p className="drawer-caption">导出任务状态和脱敏日志，不含正文、附件或登录凭证。</p><button className="drawer-setting-action" onClick={exportDiagnostics}><span>导出诊断 JSON</span><Download size={15}/></button><details className="diagnostic-logs"><summary>最近日志 · {workspace.logs.length}</summary>{workspace.logs.slice(0,20).map(log=><div key={log.id}><time>{time(log.time)}</time><p className={log.level==='error'?'error-copy':''}>{log.message}</p></div>)}{!workspace.logs.length&&<p>尚无诊断日志。</p>}</details></section><p className="drawer-footnote"><ShieldCheck size={13}/>本地保存 · 灵同步</p></div></aside></div>}
  </div>;
}
function Brand(){return <div className="brand"><img className="brand-mark" src={chrome.runtime.getURL('brand.svg')} alt=""/><strong>灵同步</strong></div>;}
