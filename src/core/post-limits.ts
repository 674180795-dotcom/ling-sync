import parseTweet from 'twitter-text/dist/esm/parseTweet';
import type {ContentDraft,PlatformId} from './model';
/** These limits include the exact separators and hashtag text sent to the form. */
export const postLimits:Partial<Record<PlatformId,number>>={xiaohongshu:1000,weixin:1000,channels:1000,douyin:1000,kuaishou:500,x:280,zsxq:10000};
export const postImageLimits:Record<PlatformId,number>={xiaohongshu:18,weixin:20,channels:18,douyin:18,kuaishou:31,x:4,zsxq:9,jike:9,bilibili:9};
export const tagText=(tags:string[])=>tags.map(t=>'#'+t.replace(/^#+/,'' )).join(' ');
export function editorBody(draft:ContentDraft,hasTitle:boolean){return [!hasTitle&&!draft.textAsImages?draft.title:'',!draft.textAsImages?draft.markdown:'',tagText(draft.tags)].filter(Boolean).join('\n\n');}
export function postCaption(draft:ContentDraft,platform:PlatformId){return editorBody(draft,!['x','kuaishou','zsxq','jike'].includes(platform));}
export function postLength(text:string,platform:PlatformId){return platform==='x'?parseTweet(text).weightedLength:text.length;}
// X eligibility is resolved against the complete text in the current native
// composer. An unknown account must not be classified as a 280-character account.
export function postOverflow(draft:ContentDraft,platform:PlatformId,xLimit?:number){const limit=platform==='x'?(draft.textAsImages?280:xLimit):postLimits[platform];if(draft.type!=='post'||limit===undefined)return;const length=postLength(postCaption(draft,platform),platform);if(length<=limit)return;const tagsLength=postLength(tagText(draft.tags),platform);return {platform,length,limit,tagsLength,canConvert:tagsLength<=limit};}
export function overflowPlatforms(draft:ContentDraft,platforms:PlatformId[]){return platforms.flatMap(p=>{const r=postOverflow(draft,p);return r?[r]:[];});}
export function cardSnapshot(draft:ContentDraft,cards:ContentDraft['media'],platform:PlatformId):ContentDraft{
 const check=postOverflow(draft,platform,280);if(check&&!check.canConvert)throw new Error(`标签本身已超出${check.limit}字符限制，请精简标签后重试。`);
 // New snapshots keep the user-selected lead image before numbered text cards.
 const media=[...draft.media,...cards];const limit=postImageLimits[platform];if(media.length>limit)throw new Error(`文字卡片与原附件共${media.length}张，超过此平台${limit}张上限；已保留原稿，未上传。`);
 if(!cards.length)throw new Error('文字卡片未生成，保留原稿并跳过。');return {...draft,media,textAsImages:true};
}
