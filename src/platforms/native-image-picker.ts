// Packaged MAIN-world DOM interaction: intercept only the native image chooser
// created synchronously by the platform toolbar. No platform state/API is read.
export function uploadZsxqImage(targetId: string, name: string, mime: string, bytes: number[]) {
  if (location.origin !== 'https://wx.zsxq.com' || new URL(location.href).searchParams.get('groupId') !== targetId) throw new Error('目标星球已变化');
  const editor = document.querySelector<HTMLElement>('.ql-editor[contenteditable="true"]');
  const toolbar = document.querySelector<HTMLButtonElement>('.ql-toolbar button.ql-image');
  if (!editor || !toolbar || !bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('正文图片上传入口未就绪');
  editor.focus();
  const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  const original = HTMLInputElement.prototype.click;
  let picked = false;
  HTMLInputElement.prototype.click = function () {
    if (this.type !== 'file' || !/image|png|jpe?g|webp|gif/.test(this.accept)) return original.call(this);
    if (picked) throw new Error('图片上传控件重复触发');
    picked = true;
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mime }));
    this.files = transfer.files;
    this.dispatchEvent(new Event('change', { bubbles: true }));
  };
  try { toolbar.click(); } finally { HTMLInputElement.prototype.click = original; }
  if (!picked) throw new Error('未识别平台原生图片选择器');
  return { accepted: true };
}
