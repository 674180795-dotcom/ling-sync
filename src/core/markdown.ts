import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(markdown: string, mediaUrls: Record<string, string> = {}) {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true });
  const clean = DOMPurify.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'form', 'input', 'button', 'style', 'svg', 'math'], FORBID_ATTR: ['style', 'srcset', 'id', 'name'], ADD_URI_SAFE_ATTR: ['data-media-id'] });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  for (const image of doc.querySelectorAll('img')) {
    const original = image.getAttribute('src') || '';
    const id = original.startsWith('ling-media://') ? original.slice(13) : '';
    if (id && mediaUrls[id]?.startsWith('blob:')) image.src = mediaUrls[id]!;
    else { const text = doc.createElement('span'); text.className = 'image-placeholder'; text.textContent = `[图片：${image.alt || '请使用下方本地图片附件'}]`; image.replaceWith(text); }
  }
  for (const anchor of doc.querySelectorAll('a')) { anchor.target = '_blank'; anchor.rel = 'noreferrer noopener'; }
  return doc.body.innerHTML;
}
