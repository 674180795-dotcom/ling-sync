import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');const svg=await fs.readFile(path.join(root,'public/brand.svg'));
for(const size of [16,32,48,128])await sharp(svg).resize(size,size).png().toFile(path.join(root,`public/icon-${size}.png`));
if(process.argv.includes('--fixtures')){
await fs.mkdir(path.join(root,'tests/fixtures'),{recursive:true});
await sharp({create:{width:900,height:600,channels:3,background:'#f6f4ec'}}).composite([{input:await sharp(svg).resize(180,180).png().toBuffer(),left:360,top:210}]).png().toFile(path.join(root,'tests/fixtures/test-image.png'));

}
