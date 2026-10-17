import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');const m=JSON.parse(await fs.readFile(path.join(root,'dist/manifest.json'),'utf8'));
assert.equal(m.name,'灵同步');assert.equal(m.manifest_version,3);
assert.deepEqual(new Set(m.permissions),new Set(['storage','scripting','sidePanel','alarms']));
assert.deepEqual(new Set(m.optional_host_permissions),new Set(['https://mp.weixin.qq.com/*','https://wx.zsxq.com/*','https://web.okjike.com/*','https://creator.douyin.com/*','https://cp.kuaishou.com/*','https://channels.weixin.qq.com/*','https://member.bilibili.com/*','https://x.com/*','https://creator.xiaohongshu.com/*','https://t.bilibili.com/*']));
assert.ok(!m.host_permissions?.length);assert.ok(!m.externally_connectable);assert.ok(!m.content_scripts?.length);assert.ok(!m.key);
async function files(dir){return(await Promise.all((await fs.readdir(dir,{withFileTypes:true})).map(async e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]))).flat();}
const all=await files(path.join(root,'dist'));const ownSource=await files(path.join(root,'src'));
for(const relative of [m.background.service_worker,m.side_panel.default_path,m.options_ui.page,...Object.values(m.icons)])assert.ok(all.includes(path.join(root,'dist',relative)),`missing manifest asset: ${relative}`);
for(const file of all.filter(f=>f.endsWith('.html'))){
  const html=await fs.readFile(file,'utf8');
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
    const asset=match[1];assert.ok(!/^https?:/.test(asset),'remote extension asset');
    assert.ok(all.includes(path.join(root,'dist',asset.replace(/^\//,''))),`missing HTML asset: ${asset}`);
  }
}
const folder=/^\d+\.\d+\.\d+-dev\.\d+$/.test(m.version_name||'')?path.join('release',m.version_name):'release';
const zip=path.join(root,folder,'ling-sync.zip');
const listed=spawnSync('/usr/bin/unzip',['-Z1',zip],{encoding:'utf8'});assert.equal(listed.status,0);
const entries=listed.stdout.trim().split('\n').filter(e=>!e.endsWith('/'));
assert.equal(new Set(entries).size,entries.length);assert.ok(entries.includes('manifest.json'));
assert.deepEqual(new Set(entries),new Set(all.map(f=>path.relative(path.join(root,'dist'),f))));
for(const entry of entries){assert.ok(!entry.startsWith('/')&&!entry.split('/').includes('..'));const extracted=spawnSync('/usr/bin/unzip',['-p',zip,entry],{maxBuffer:5*1024*1024});assert.equal(extracted.status,0);assert.deepEqual(extracted.stdout,await fs.readFile(path.join(root,'dist',entry)),`ZIP differs: ${entry}`);}
for(const f of all.filter(f=>/\.js$/.test(f))){const s=await fs.readFile(f,'utf8');assert.ok(!/copydog\.art|paiban\.md|jejejajkcbhejfiocemmddgbkdlhhngm|eval\s*\(|new Function\s*\(/.test(s),`forbidden reference/dynamic code: ${path.relative(root,f)}`);}
for(const f of ownSource.filter(f=>/\.(ts|tsx)$/.test(f))){const s=await fs.readFile(f,'utf8');assert.ok(!/copydog\.art|operate_appmsg|authorization\s*:\s*['"]Bearer|cookie\s*:\s*['"]/.test(s),`forbidden credential/reference dependency: ${f}`);}
const result={manifest:true,permissions:true,packagedScriptsOnly:true,assetReferences:true,zipMatchesDist:true,referenceDependencies:false,sourceFiles:ownSource.length,distributionFiles:all.length,bytes:(await Promise.all(all.map(f=>fs.stat(f)))).reduce((sum,s)=>sum+s.size,0)};
await fs.mkdir(path.join(root,'research'),{recursive:true});await fs.writeFile(path.join(root,'research/build-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
