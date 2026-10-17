import {platformFor,type PlatformId} from './model';
export const normaliseBody = (text: string) => text.normalize('NFC').replace(/\s+/g, '');
export function semanticBody(root:Element) {
  const clone=root.cloneNode(true) as Element;
  clone.querySelectorAll('[contenteditable="false"],img').forEach(e=>e.remove());
  clone.querySelectorAll('br').forEach(e=>e.replaceWith(e.ownerDocument.createTextNode('\n')));
  const blocks='p,section,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th';
  const leaves=[...clone.querySelectorAll(blocks)].filter(e=>!e.querySelector(blocks));
  const values=(leaves.length?leaves:[clone]).map(e=>e.tagName.toLowerCase()==='pre'
    ? (e.textContent||'').normalize('NFC').replace(/\r\n?/g,'\n').trim()
    : (e.textContent||'').normalize('NFC').replace(/\s+/g,' ').trim());
  return values.filter(Boolean).join('\n');
}
export function formatSignature(root: Element): string {
  const records: {type:string;start:number;length:number;detail?:string}[]=[];
  let position=0;
  function walk(node:Node) {
    if(node.nodeType===Node.TEXT_NODE) { position+=normaliseBody(node.textContent||'').length; return; }
    if(node.nodeType!==Node.ELEMENT_NODE)return;
    const element=node as Element;const tag=element.tagName.toLowerCase();const start=position;
    if(tag==='img')return;
    for(const child of element.childNodes)walk(child);
    const length=position-start;if(!length)return;
    let type:string|undefined;
    if(/^h[1-6]$/.test(tag)||['blockquote','pre','code','table','tr','td','th'].includes(tag))type=tag;
    if(['strong','b'].includes(tag))type='strong';if(['em','i'].includes(tag))type='em';if(['s','del','strike'].includes(tag))type='s';
    if(tag==='ul'||tag==='ol') type=tag==='ul'||[...element.children].every(e=>e.getAttribute('data-list')==='bullet')?'ul':'ol';
    if(tag==='a') {type='a';records.push({type,start,length,detail:element.getAttribute('href')||''});return;}
    if(type)records.push({type,start,length,detail:tag==='code'||tag==='pre'?element.textContent||'':undefined});
  }
  for(const child of root.childNodes)walk(child);
  return JSON.stringify(records.sort((a,b)=>a.start-b.start||a.length-b.length||a.type.localeCompare(b.type)));
}
export function sameMedia(actual:string[],expected:string[]) { return actual.length===expected.length && actual.every((hash,index)=>hash===expected[index]); }
export function knownUploadPrefix(actual:string[],recorded?:string[]) {
  return actual.length===0 || !!recorded && actual.length<=recorded.length && actual.every((hash,index)=>hash===recorded[index]);
}
export function mediaIdentity(platform:PlatformId,source:string) {
  const url=new URL(source);
  if(url.protocol!=='https:')return '';
  // WeChat changes the same uploaded asset from /0 to /640 on persistence.
  // Preserve its complete CDN asset key; normalize only that size suffix.
  const pathname=platform==='weixin'&&url.hostname==='mmbiz.qpic.cn'&&/^\/\w*mmbiz_(?:png|jpg|jpeg|gif|webp)\/[^/]+\/(?:0|640)$/.test(url.pathname)
    ? url.pathname.replace(/\/(?:0|640)$/,'/0'):url.pathname;
  return url.origin+pathname;
}
export function targetMatches(platform:PlatformId,targetId:string,value:string) {
  const url=new URL(value);
  if(platform!=='zsxq')return url.origin===platformFor(platform).origin;
  return url.origin==='https://wx.zsxq.com'&&/^\d{5,30}$/.test(targetId)&&url.searchParams.get('groupId')===targetId;
}
