import type {ContentDraft,MediaRef} from './model';
import {db} from './repository';
const recipe='text-card-v2';
export {wrapText,cardPages} from './card-renderer';
import {renderCardBlobs} from './card-renderer';
/** Native worker canvas: no remote renderer, no service, no draft modification. */
const rendering=new Map<string,Promise<MediaRef[]>>();
export function textImages(draft:ContentDraft):Promise<MediaRef[]>{
 const key=draft.id+':'+draft.revision;const active=rendering.get(key);if(active)return active;
 const pending=renderTextImages(draft).finally(()=>rendering.delete(key));rendering.set(key,pending);return pending;
}
async function renderTextImages(draft:ContentDraft):Promise<MediaRef[]>{
 if(draft.type!=='post')throw new Error('文字图片只用于动态');
 const d=await db();const prefix=`ling-text-${recipe}-r${draft.revision}-`;
 const cached=(await d.getAllFromIndex('media','draftId',draft.id)).filter(m=>m.name.startsWith(prefix)).sort((a,b)=>a.name.localeCompare(b.name));
 if(cached.length)return cached.map(({blob:_blob,draftId:_draft,...ref})=>ref);
 const blobs=await renderCardBlobs(draft);const entries=[];
 for(let index=0;index<blobs.length;index++){
  const blob=blobs[index]!;const ref:MediaRef={id:crypto.randomUUID(),kind:'image',name:prefix+String(index+1).padStart(2,'0')+'.png',mime:'image/png',bytes:blob.size,width:1080,height:1440};entries.push({...ref,draftId:draft.id,blob});
 }
 // All pages become visible together, so a failed render cannot cache a partial set.
 const tx=d.transaction('media','readwrite');for(const entry of entries)await tx.store.put(entry);await tx.done;
 return entries.map(({blob:_blob,draftId:_draft,...ref})=>ref);
}
