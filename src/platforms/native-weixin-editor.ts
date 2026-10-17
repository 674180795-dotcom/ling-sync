// Normal editor DOM events in its own world. Platform paste processing is
// asynchronous; callers must read back before uploading or saving.
export function fillWeixinArticle(title: string, html: string, expectedBody: string) {
  if(location.origin!=='https://mp.weixin.qq.com')throw new Error('平台来源变化');
  const heading=document.querySelector<HTMLElement>('.title-editor__input .ProseMirror[contenteditable="true"]');
  const editor=document.querySelector<HTMLElement>('.rich_media_content .ProseMirror[contenteditable="true"]');
  if(!heading||!editor)throw new Error('公众号编辑字段尚未就绪');
  const clean=editor.cloneNode(true) as HTMLElement;clean.querySelectorAll('[contenteditable="false"]').forEach(e=>e.remove());
  const normal=(value:string)=>value.normalize('NFC').replace(/\s+/g,'');
  const existing=normal(clean.textContent||'');
  if(existing===normal(expectedBody)&&heading.textContent===title)return {accepted:true};
  if(existing||(heading.textContent||'').trim())throw new Error('编辑页已有内容，请使用空白文章页');
  heading.focus();let range=document.createRange();range.selectNodeContents(heading);
  const selection=document.getSelection();selection?.removeAllRanges();selection?.addRange(range);
  document.execCommand('insertText',false,title);
  editor.focus();range=document.createRange();range.selectNodeContents(editor);selection?.removeAllRanges();selection?.addRange(range);
  const clipboard=new DataTransfer();clipboard.setData('text/html',html);clipboard.setData('text/plain',expectedBody);
  editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
  return {accepted:true};
}
