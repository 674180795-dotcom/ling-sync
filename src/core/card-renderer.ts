import {z} from 'zod';
export const CardStyleSchema=z.object({
 background:z.enum(['solid','linear','radial']).default('solid'),color1:z.string().regex(/^#[0-9a-f]{6}$/i).default('#faf9f6'),color2:z.string().regex(/^#[0-9a-f]{6}$/i).default('#dfe9e3'),
 textColor:z.string().regex(/^#[0-9a-f]{6}$/i).default('#222325'),font:z.enum(['sans','serif','mono']).default('sans'),fontSize:z.number().min(24).max(72).default(40),lineHeight:z.number().min(1.2).max(2.2).default(1.7),letterSpacing:z.number().min(0).max(8).default(0),padding:z.number().min(48).max(160).default(80),angle:z.number().min(0).max(360).default(135),align:z.enum(['left','center']).default('left'),
});
export type CardStyle=z.infer<typeof CardStyleSchema>;
export const defaultCardStyle=CardStyleSchema.parse({});
export const cardFonts={sans:'"PingFang SC", system-ui, sans-serif',serif:'"Songti SC", "Noto Serif CJK SC", serif',mono:'"SFMono-Regular", "Menlo", monospace'};
export const cardPresets=[{name:'素纸',style:defaultCardStyle},{name:'青雾',style:{...defaultCardStyle,background:'linear' as const,color1:'#edf4e8',color2:'#c8ddd9',textColor:'#223f36'}},{name:'暮光',style:{...defaultCardStyle,background:'radial' as const,color1:'#f5d9d8',color2:'#dadcf0',font:'serif' as const}},{name:'夜读',style:{...defaultCardStyle,background:'linear' as const,color1:'#192c37',color2:'#394c54',textColor:'#f5f2e9'}}];
type Context=OffscreenCanvasRenderingContext2D|CanvasRenderingContext2D;
export type CardLine={text:string;size:number;bold:boolean;height:number};
const graphemes=(text:string)=>[...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].map(x=>x.segment);
export function wrapText(text:string,measure:(text:string)=>number,maxWidth:number){
 const result:string[]=[];for(const paragraph of text.replace(/\r\n?/g,'\n').split('\n')){let line='';for(const segment of graphemes(paragraph)){if(line&&measure(line+segment)>maxWidth){result.push(line);line='';}line+=segment;}result.push(line);}return result;
}
export function cardPages(lines:string[],capacity=17,maxPages=18){if(lines.length>capacity*maxPages)throw new Error(`文字图片最多${maxPages}页，请缩短内容或自行添加图片。`);return Array.from({length:Math.ceil(lines.length/capacity)},(_,i)=>lines.slice(i*capacity,(i+1)*capacity));}
const setFont=(ctx:Context,size:number,bold:boolean,style:CardStyle)=>{ctx.font=`${bold?'600':'400'} ${size}px ${cardFonts[style.font]}`;};
const width=(ctx:Context,text:string,spacing:number)=>ctx.measureText(text).width+Math.max(0,graphemes(text).length-1)*spacing;
/** Markdown is rendered locally as typography. Links remain text; no fetch or URL parser. */
export function layoutCards(ctx:Context,input:{title:string;markdown:string;tags:string[]},style:CardStyle):CardLine[][]{
 const paragraphs=[...(input.title?[{text:input.title,size:style.fontSize*1.35,bold:true},{text:'',size:style.fontSize,bold:false}]:[]),...input.markdown.replace(/\r\n?/g,'\n').split('\n').map(line=>{const heading=line.match(/^#{1,6}\s+(.+)$/);return {text:(heading?heading[1]!:line).replace(/^\s*[-*+]\s+/,'• ').replace(/^>\s?/,'│ ').replace(/\*\*(.+?)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1').replace(/^```.*$/,''),size:heading?style.fontSize*1.2:style.fontSize,bold:!!heading};}),...(input.tags.length?[{text:'',size:style.fontSize,bold:false},{text:input.tags.map(t=>'#'+t.replace(/^#/,'' )).join(' '),size:style.fontSize,bold:false}]:[])];
 if(![input.title,input.markdown,...input.tags].join('').trim())throw new Error('请先填写动态内容');
 const available=1440-style.padding*2-48;const pages:CardLine[][]=[[]];let used=0;
 for(const p of paragraphs){setFont(ctx,p.size,p.bold,style);const lines=wrapText(p.text,text=>width(ctx,text,style.letterSpacing),1080-style.padding*2);for(const text of lines){const height=p.text?p.size*style.lineHeight:style.fontSize*.7;if(used+height>available&&pages.at(-1)!.length){pages.push([]);used=0;}if(pages.length>18)throw new Error('文字图片最多18页，请缩短内容或调小字号。');pages.at(-1)!.push({text,size:p.size,bold:p.bold,height});used+=height;}}
 return pages;
}
export function drawCard(ctx:Context,lines:CardLine[],style:CardStyle,index:number,total:number){
 let fill:string|CanvasGradient=style.color1;
 if(style.background==='linear'){const rad=style.angle*Math.PI/180;const dx=Math.sin(rad)*540,dy=-Math.cos(rad)*720;fill=ctx.createLinearGradient(540-dx,720-dy,540+dx,720+dy);fill.addColorStop(0,style.color1);fill.addColorStop(1,style.color2);}
 if(style.background==='radial'){fill=ctx.createRadialGradient(350,360,0,540,720,1000);fill.addColorStop(0,style.color1);fill.addColorStop(1,style.color2);}
 ctx.fillStyle=fill;ctx.fillRect(0,0,1080,1440);ctx.fillStyle=style.textColor;ctx.textBaseline='top';let y=style.padding;
 for(const line of lines){setFont(ctx,line.size,line.bold,style);let x=style.align==='center'?(1080-width(ctx,line.text,style.letterSpacing))/2:style.padding;if(style.letterSpacing){for(const char of graphemes(line.text)){ctx.fillText(char,x,y);x+=ctx.measureText(char).width+style.letterSpacing;}}else ctx.fillText(line.text,x,y);y+=line.height;}
 ctx.globalAlpha=.55;ctx.font=`24px ${cardFonts[style.font]}`;ctx.fillText(`${index+1} / ${total}`,style.padding,1440-style.padding);ctx.globalAlpha=1;
}
export async function renderCardBlobs(input:{title:string;markdown:string;tags:string[];cardStyle?:CardStyle}){
 const style=CardStyleSchema.parse(input.cardStyle||{});const canvas=new OffscreenCanvas(1080,1440);const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器不能生成文字图片，请手动添加图片');const pages=layoutCards(ctx,input,style);const blobs:Blob[]=[];
 for(let i=0;i<pages.length;i++){drawCard(ctx,pages[i]!,style,i,pages.length);blobs.push(await canvas.convertToBlob({type:'image/png'}));}return blobs;
}
