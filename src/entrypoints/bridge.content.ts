import { z } from 'zod';
import { PlatformIdSchema } from '../core/model';
import { renderMarkdown } from '../core/markdown';
import { normaliseBody, formatSignature, sameMedia, targetMatches, mediaIdentity, semanticBody } from '../core/content-proof';
import type { BridgeCommand, EditorObservation } from '../platforms/contracts';

const Packet = z.object({ channel: z.literal('ling-sync-bridge'), version: z.literal(1), command: z.object({
  operation: z.enum(['detect', 'open_editor', 'reopen_draft', 'prepare_fill', 'fill', 'read', 'save', 'upload_begin', 'upload_chunk', 'upload_commit']),
  taskId: z.string().min(1).max(64), attemptId: z.string().min(1).max(64), platform: PlatformIdSchema,
  targetId:z.string().max(30).optional(),proof:z.object({bodyDigest:z.string().regex(/^[a-f0-9]{64}$/),mediaHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(50)}).optional(),
  title: z.string().max(500).optional(), markdown: z.string().max(500_000).optional(), html: z.string().max(2_000_000).optional(), expectedBody: z.string().max(500_000).optional(), mediaCount: z.number().int().nonnegative().optional(),
  media: z.object({ id: z.uuid(), name: z.string().max(250), mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: z.number().int().positive().max(15*1024*1024) }).optional(),
  chunk: z.string().max(200_000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(), index: z.number().int().nonnegative().optional(),
}) });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const visible = (el: Element) => !!(el as HTMLElement).getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
function documents() {
  const result = [document];
  for (const frame of document.querySelectorAll('iframe')) { try { if (frame.contentDocument) result.push(frame.contentDocument); } catch {} }
  return result;
}
function candidates(selector: string) { return documents().flatMap(d => [...d.querySelectorAll<HTMLElement>(selector)]); }
function titleInput() { return candidates('input[placeholder*="标题"],textarea[placeholder*="标题"],input#title,textarea#title,input[name="title"],textarea[name="title"],.title-editor__input .ProseMirror[contenteditable="true"]').find(visible) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | undefined; }
function titleValue() { const field=titleInput(); return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field?.textContent || ''; }
function editorText(editor:HTMLElement) { const clone=editor.cloneNode(true) as HTMLElement;clone.querySelectorAll('[contenteditable="false"]').forEach(e=>e.remove());return clone.textContent||''; }
function bodyEditor() { return candidates('.ProseMirror[contenteditable="true"],.ql-editor[contenteditable="true"],#js_editor[contenteditable="true"],.edui-body-container[contenteditable="true"],body[contenteditable="true"],[contenteditable="true"][role="textbox"],[contenteditable="true"]').filter(el=>visible(el)&&!el.closest('.title-editor__input')).sort((a,b) => b.getBoundingClientRect().height-a.getBoundingClientRect().height)[0]; }
function button(labels: string[]) {
  return candidates('button,a,[role="button"],input[type="button"],.operation-btns .save.btn').filter(visible).find(el => labels.includes((el.textContent || (el as HTMLInputElement).value || '').trim()) && !(el as HTMLButtonElement).disabled);
}
function guard() {
  if (candidates('iframe[src*="captcha"],[class*="captcha"] input').some(visible) || /请完成安全验证|访问过于频繁|操作频繁|异常访问/.test(document.body.innerText)) throw new Error('平台要求安全验证，请在平台页面正常完成后再继续');
}
function session(): EditorObservation['login'] {
  if (titleInput() && bodyEditor()) return 'connected';
  if (button(['扫码登录', '登录', '微信登录']) || /扫码登录|使用微信扫码|扫描二维码登录|请登录知识星球/.test(document.body.innerText)) return 'logged_out';
  if (candidates('.new-creation__menu,.avatar,.user-avatar,.account-avatar,#js_account_info,[class*="userAvatar"],[class*="user-avatar"]').some(visible)) return 'connected';
  return 'unknown';
}
async function read(command: BridgeCommand): Promise<EditorObservation> {
  const editor = bodyEditor(); const paths = editor ? [...editor.querySelectorAll<HTMLImageElement>('img')].map(img => { try { return mediaIdentity(command.platform,img.src); } catch { return ''; } }).filter(Boolean) : [];
  const hashes = await Promise.all(paths.map(async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(n=>n.toString(16).padStart(2,'0')).join('')));
  const text = normaliseBody(editor?editorText(editor):'');
  const signature=editor?formatSignature(editor):'';
  const expected=new DOMParser().parseFromString(command.html||'', 'text/html').body;
  const bodyDigest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text+'\n'+signature)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  return { title: titleValue(), bodyMatched: !!command.expectedBody && !!editor && semanticBody(editor)===semanticBody(expected),formatMatched:!!editor&&signature===formatSignature(expected),bodyDigest,mediaCount: paths.length, mediaHashes: hashes, editorFound: !!editor && !!titleInput(), login: session() };
}
export default defineContentScript({
  matches: ['https://mp.weixin.qq.com/*', 'https://wx.zsxq.com/*'], registration: 'runtime',
  main() {
    const flag = '__lingSyncBridgeV1'; const state = globalThis as unknown as Record<string, unknown>;
    if (state[flag]) return; state[flag] = true;
    const transfers = new Map<string, { taskId: string; attemptId: string; media: NonNullable<BridgeCommand['media']>; chunks: Uint8Array[]; index: number; bytes: number; before: number }>();
    let binding: string | undefined;
    async function run(c: BridgeCommand) {
      const origin = c.platform === 'weixin' ? 'https://mp.weixin.qq.com' : 'https://wx.zsxq.com';
      if (location.origin !== origin) throw new Error('平台来源不匹配');
      if(c.operation!=='detect'&&!targetMatches(c.platform,c.targetId||'',location.href))throw new Error('当前编辑器不属于任务目标星球，请恢复正确的星球文章编辑页');
      guard();
      if (c.markdown !== undefined) {
        c.html = renderMarkdown(c.markdown);
        c.expectedBody = new DOMParser().parseFromString(c.html, 'text/html').body.textContent || '';
      }
      if (c.operation === 'prepare_fill') return { html:c.html || '',expectedBody:c.expectedBody || '' };
      if (c.operation === 'detect' || c.operation === 'read') return read(c);
      if (c.operation === 'open_editor') {
        if (titleInput() && bodyEditor()) return read(c);
        const entry = button(c.platform === 'weixin' ? ['新的创作', '写新图文', '图文消息', '创作图文'] : ['写文章', '创建文章', '新建文章']);
        if (entry) entry.click();
        for (let i=0;i<40;i++) { await delay(500); guard(); if (titleInput() && bodyEditor()) return read(c); }
        throw new Error('尚未找到文章编辑器，请在此任务的标签页打开一个空白文章编辑页，再重试填写');
      }
      if (c.operation === 'reopen_draft') {
        if (c.platform !== 'zsxq') throw new Error('此平台尚未实现草稿列表自动打开');
        const entry = document.querySelector<HTMLElement>('.right .text');
        if (entry?.textContent?.trim() !== '我的文章') throw new Error('草稿箱入口已变化');
        entry.click();
        for (let i=0;i<30;i++) {
          await delay(500); guard();
          const rows = [...document.querySelectorAll<HTMLElement>('.item')].filter(row => row.querySelector('.title')?.textContent?.trim() === c.title);
          if (rows.length > 1) throw new Error('草稿箱存在同名文章，请手动核对，不能自动选择');
          if (rows.length === 1) {
            const edit = rows[0]!.querySelector<HTMLElement>('.operation .edit');
            if (edit?.textContent?.trim() !== '编辑') throw new Error('草稿编辑入口已变化');
            edit.click(); return { accepted: true };
          }
        }
        throw new Error('草稿箱未找到对应标题，请手动核对平台结果');
      }
      const key = `${c.taskId}:${c.attemptId}`;
      if (c.operation === 'fill') {
        const title = titleInput(), editor = bodyEditor();
        if (!title || !editor) throw new Error('编辑器字段未识别，请在任务标签页进入空白文章编辑页');
        const previous = await read(c);
        if (binding !== key && (titleValue().trim() || editorText(editor).trim()) && !(previous.title === c.title && previous.bodyMatched)) throw new Error('编辑页已有内容。灵同步不会覆盖，请改用空白文章编辑页');
        if ((title instanceof HTMLInputElement || title instanceof HTMLTextAreaElement) && title.maxLength > 0 && (c.title || '').length > title.maxLength) throw new Error(`平台标题最多 ${title.maxLength} 个字符，请缩短后创建新任务`);
        if (title instanceof HTMLInputElement || title instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(title), 'value')?.set;
          setter?.call(title, c.title || ''); title.dispatchEvent(new Event('input', { bubbles: true })); title.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          title.focus(); const range=title.ownerDocument.createRange();range.selectNodeContents(title);
          const selection=title.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);
          title.ownerDocument.execCommand('insertText',false,c.title||'');
        }
        if (!previous.bodyMatched || previous.title !== c.title) {
          editor.focus(); const doc = editor.ownerDocument;
          const selection = doc.getSelection(); const range = doc.createRange(); range.selectNodeContents(editor); selection?.removeAllRanges(); selection?.addRange(range);
          const data = new DataTransfer(); data.setData('text/html', c.html || ''); data.setData('text/plain', c.expectedBody || '');
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
          await delay(350);
          if (!(await read(c)).bodyMatched) { editor.focus(); selection?.removeAllRanges(); range.selectNodeContents(editor); selection?.addRange(range); doc.execCommand('insertHTML', false, c.html || ''); editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); }
        }
        binding = key; await delay(500); const filled = await read(c);
        if (filled.title !== c.title || !filled.bodyMatched || !filled.formatMatched) throw new Error('标题、正文或Markdown格式填写未通过回读，请检查平台编辑器后重试');
        return filled;
      }
      if (c.operation === 'upload_begin') {
        if (!c.media || transfers.size >= 2) throw new Error('图片传输未就绪');
        transfers.set(c.media.id, { taskId:c.taskId, attemptId:c.attemptId, media:c.media, chunks:[],index:0,bytes:0,before:(await read(c)).mediaCount }); return { accepted: true };
      }
      if (c.operation === 'upload_chunk') {
        const t = c.media && transfers.get(c.media.id);
        if (!t || t.taskId !== c.taskId || t.attemptId !== c.attemptId || c.index !== t.index || !c.chunk) throw new Error('图片分块顺序无效');
        const raw = atob(c.chunk); const bytes = Uint8Array.from(raw, ch=>ch.charCodeAt(0));
        if (t.bytes+bytes.byteLength > t.media.bytes) { transfers.delete(t.media.id); throw new Error('图片大小不符'); }
        t.chunks.push(bytes); t.bytes += bytes.byteLength; t.index++; return { accepted:true };
      }
      if (c.operation === 'upload_commit') {
        const t = c.media && transfers.get(c.media.id);
        if (!t || t.taskId !== c.taskId || t.attemptId !== c.attemptId || t.bytes !== t.media.bytes) throw new Error('图片传输不完整');
        try {
          let inputs = candidates('input[type="file"]').filter(el => { const accept=(el as HTMLInputElement).accept; return !accept || /image|png|jpe?g|webp|gif/.test(accept); }) as HTMLInputElement[];
          if (!inputs.length) {
            if (c.platform === 'zsxq') document.querySelector<HTMLButtonElement>('.ql-toolbar button.ql-image')?.click();
            else button(['插入图片','图片','上传图片'])?.click();
            await delay(500); inputs = candidates('input[type="file"]').filter(el=>/image|png|jpe?g|webp|gif/.test((el as HTMLInputElement).accept)) as HTMLInputElement[];
          }
          const input = inputs.length===1 ? inputs[0] : inputs.filter(x=>x.multiple).length===1 ? inputs.find(x=>x.multiple) : undefined;
          if (!input) throw new Error('图片上传入口未唯一识别，请在平台正常打开正文图片上传控件，再重试本任务');
          const editor=bodyEditor();if(editor){editor.focus();const range=editor.ownerDocument.createRange();range.selectNodeContents(editor);range.collapse(false);const selection=editor.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);editor.ownerDocument.dispatchEvent(new Event('selectionchange'));}
          const data = new DataTransfer(); data.items.add(new File(t.chunks as BlobPart[], t.media.name, {type:t.media.mime})); input.files=data.files;
          input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}));
          for(let i=0;i<90;i++) { await delay(500); guard(); const result=await read(c); if(result.mediaCount>t.before) return result; }
          throw new Error('未确认图片已进入正文，请检查平台上传状态；不要重复点击保存');
        } finally { transfers.delete(t.media.id); }
      }
      if (c.operation === 'save') {
        const before = await read(c);
        if (before.title !== c.title || !before.bodyMatched || !before.formatMatched || before.mediaCount !== c.mediaCount || !c.proof || before.bodyDigest!==c.proof.bodyDigest || !sameMedia(before.mediaHashes,c.proof.mediaHashes)) throw new Error('编辑页正文、格式或图片身份/顺序已变化，保存前核对未通过');
        const save = button(c.platform === 'zsxq' ? ['保存草稿','存为草稿','保存'] : ['保存为草稿','保存草稿','存为草稿']);
        if (!save) throw new Error('未找到明确的保存草稿按钮，请在平台手动保存后使用“核对草稿”');
        const notices = () => candidates('[role="alert"],.page_tips.success,.save_done,.toast,.message,.weui-toast,[class*="toast"],[class*="message"],[class*="Toast"]').filter(visible).map(e=>e.textContent||'').find(t=>/保存成功|已保存|草稿已保存|保存草稿成功/.test(t));
        const oldNotice=notices(); save.click();
        for (let i=0;i<40;i++) { await delay(500); guard(); const notice=notices(); if(notice && notice !== oldNotice) return {...await read(c),notice:notice.slice(0,120)}; }
        throw new Error('保存已触发，但没有可靠回执。请核对平台草稿，禁止直接重试保存');
      }
      throw new Error('不支持的操作');
    }
    chrome.runtime.onMessage.addListener((packet, sender, reply) => {
      if (packet?.channel !== 'ling-sync-bridge') return false;
      if (sender.id !== chrome.runtime.id || sender.tab) { reply({ok:false,error:'消息来源无效'}); return false; }
      const parsed = Packet.safeParse(packet); if(!parsed.success) {reply({ok:false,error:'消息格式无效'});return false;}
      run(parsed.data.command).then(value=>reply({ok:true,value}),error=>reply({ok:false,error:error instanceof Error?error.message:'平台操作未完成'}));
      return true;
    });
  },
});
