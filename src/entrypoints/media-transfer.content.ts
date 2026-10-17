import {z} from 'zod';
import {nativeMediaInput} from '../platforms/media-input';
import {MediaRefSchema,platformOrigins,PlatformIdSchema,ContentTypeSchema} from '../core/model';
const Packet=z.object({channel:z.literal('ling-sync-media-v5'),version:z.literal(5),platform:PlatformIdSchema,type:ContentTypeSchema,targetId:z.string().max(100).optional(),key:z.string().min(1).max(150),action:z.enum(['probe','begin','chunk','commit','stage','commit_batch','abort']),media:MediaRefSchema.optional(),index:z.number().int().nonnegative().optional(),chunk:z.string().max(140000).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional()});
export default defineContentScript({matches:['https://mp.weixin.qq.com/*','https://wx.zsxq.com/*','https://web.okjike.com/*','https://creator.douyin.com/*','https://cp.kuaishou.com/*','https://channels.weixin.qq.com/*','https://member.bilibili.com/*','https://x.com/*','https://t.bilibili.com/*','https://creator.xiaohongshu.com/*'],registration:'runtime',main(){
  const global=globalThis as unknown as Record<string,unknown>;if(global.__lingSyncMediaV5)return;global.__lingSyncMediaV5=true;
  let staged:{key:string;files:File[];media:z.infer<typeof MediaRefSchema>[];bytes:number}|undefined;
  let expiry:ReturnType<typeof setTimeout>|undefined;
  let transfer:{key:string;media:z.infer<typeof MediaRefSchema>;parts:Uint8Array[];bytes:number;index:number}|undefined;
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message?.channel!=='ling-sync-media-v5')return false;
    const parsed=Packet.safeParse(message);if(sender.id!==chrome.runtime.id||!parsed.success){reply({ok:false,error:'附件请求无效'});return false;}
    try {
      const p=parsed.data;if(!platformOrigins(p.platform,p.type).includes(location.origin))throw new Error('附件目标来源变化');if(p.platform==='zsxq'&&(!p.targetId||location.pathname!=='/group/'+p.targetId))throw new Error('附件目标星球变化');
      if(p.action==='probe'){if(!p.media)throw new Error('附件缺失');nativeMediaInput(p.platform,p.media);reply({ok:true});return false;}
      if(p.action==='abort'){if((transfer&&transfer.key!==p.key)||(staged&&staged.key!==p.key))throw new Error('Transfer ownership mismatch');transfer=undefined;staged=undefined;clearTimeout(expiry);reply({ok:true});return false;}
      if(p.action==='commit_batch'){
        if(transfer||!staged||staged.key!==p.key||!staged.files.length)throw new Error('批量附件尚未完整接收');
        const target=nativeMediaInput(p.platform,staged.media[0]!);if(staged.media.some(m=>nativeMediaInput(p.platform,m)!==target))throw new Error('批量附件目标控件变化');
        const data=new DataTransfer();for(const file of staged.files)data.items.add(file);
        if(target.tagName==='INPUT'){const input=target as HTMLInputElement;if(!input.multiple&&data.files.length>1)throw new Error('平台当前控件不接受多图');input.files=data.files;target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));if(target.hasAttribute('data-ling-sync-bili-picker'))target.remove();}else {target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}
        staged=undefined;clearTimeout(expiry);reply({ok:true});return false;
      }
      if(p.action==='begin'){if(!p.media)throw new Error('附件缺失');if(transfer||staged&&staged.key!==p.key)throw new Error('附件传输正在进行');transfer={key:p.key,media:p.media,parts:[],bytes:0,index:0};}
      else {
        if(!transfer||transfer.key!==p.key)throw new Error('附件传输已中断');
        if(p.action==='chunk'){
          if(p.index!==transfer.index||!p.chunk)throw new Error('附件块顺序不符');const decoded=atob(p.chunk);const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));
          if(bytes.length>96*1024||transfer.bytes+bytes.length>transfer.media.bytes)throw new Error('附件块长度不符');transfer.parts.push(bytes);transfer.bytes+=bytes.length;transfer.index++;
        } else {
          if(transfer.bytes!==transfer.media.bytes)throw new Error('附件不完整');
          // No arbitrary selector is accepted from messages. Find one compatible native control.
          if(p.action==='stage'){if(transfer.media.kind!=='image')throw new Error('只暂存批量图片');staged??={key:p.key,files:[],media:[],bytes:0};if(staged.files.length>=50||staged.bytes+transfer.bytes>64*1024*1024)throw new Error('批量图片超过64MiB本地限制');staged.files.push(new File(transfer.parts as BlobPart[],transfer.media.name,{type:transfer.media.mime}));staged.media.push(transfer.media);staged.bytes+=transfer.bytes;transfer=undefined;clearTimeout(expiry);expiry=setTimeout(()=>{staged=undefined;transfer=undefined;},120000);reply({ok:true});return false;}
          const input=nativeMediaInput(p.platform,transfer.media);
          const data=new DataTransfer();data.items.add(new File(transfer.parts as BlobPart[],transfer.media.name,{type:transfer.media.mime}));
          if(input.tagName==='INPUT'){const field=input as HTMLInputElement;field.files=data.files;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));if(input.hasAttribute('data-ling-sync-bili-picker'))input.remove();}else {input.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));}transfer=undefined;
        }
      }
      clearTimeout(expiry);if(transfer||staged)expiry=setTimeout(()=>{transfer=undefined;staged=undefined;},120000);
      reply({ok:true});
    } catch(error){if(parsed.data.action!=='probe'){if(transfer?.key===parsed.data.key)transfer=undefined;if(staged?.key===parsed.data.key)staged=undefined;}reply({ok:false,error:error instanceof Error?error.message:'附件传输失败'});}return false;
  });
}});
