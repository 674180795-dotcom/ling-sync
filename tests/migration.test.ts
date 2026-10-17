import {expect,it,vi} from 'vitest';
import {openDB,deleteDB} from 'idb';
import {Blob as NativeBlob} from 'node:buffer';
it('v1升级完整保留草稿/Blob/快照/历史，并暂停旧队列',async()=>{
  const legacy=await openDB('ling-sync',1,{upgrade(d){d.createObjectStore('drafts',{keyPath:'id'});d.createObjectStore('media',{keyPath:'id'}).createIndex('draftId','draftId');d.createObjectStore('tasks',{keyPath:'id'});d.createObjectStore('accounts',{keyPath:'platform'});d.createObjectStore('settings');d.createObjectStore('logs',{keyPath:'id'});}});
  const media={id:crypto.randomUUID(),name:'old.png',mime:'image/png',bytes:5};
  const draft={id:crypto.randomUUID(),revision:9,type:'image_post',title:'旧稿',markdown:'A B\n\n原稿',media:[media],createdAt:10,updatedAt:20};
  await legacy.put('drafts',draft);await legacy.put('media',{...media,draftId:draft.id,blob:new NativeBlob(['hello'])});
  await legacy.put('tasks',{id:'old-task',batchId:'batch',snapshot:draft,platform:'zsxq',targetId:'12345678901234',status:'queued',createdAt:12,updatedAt:20,fingerprint:'old',attemptId:'old-attempt',progress:'等待'});
  await legacy.put('accounts',{platform:'weixin',status:'connected',checkedAt:20,targetId:''});await legacy.put('logs',{id:'history',message:'旧日志',time:20});legacy.close();
  vi.resetModules();const {db,claimNextTask}=await import('../src/core/repository');const upgraded=await db();
  expect(upgraded.version).toBe(3);const next=await upgraded.get('drafts',draft.id);expect(next).toMatchObject({revision:9,type:'post',markdown:draft.markdown,tags:[]});expect(next?.media[0]?.kind).toBe('image');
  const record=await upgraded.get('media',media.id);expect(await record!.blob.text()).toBe('hello');expect(record!.kind).toBe('image');
  expect(await upgraded.get('tasks','old-task')).toMatchObject({autoRun:false,status:'queued',snapshot:{revision:9,type:'post'}});expect(await claimNextTask()).toBeUndefined();
  expect(await upgraded.get('logs','history')).toMatchObject({message:'旧日志'});expect(await upgraded.get('accounts','weixin')).toMatchObject({status:'connected'});upgraded.close();
});
it('v2升级新增备份和去重存储，不改已有任务目标和快照',async()=>{
 await deleteDB('ling-sync');const legacy=await openDB('ling-sync',2,{upgrade(d){for(const name of ['drafts','tasks','accounts','logs'])d.createObjectStore(name,{keyPath:name==='accounts'?'platform':'id'});d.createObjectStore('media',{keyPath:'id'}).createIndex('draftId','draftId');d.createObjectStore('settings');}});
 const value={id:'kept',targetId:'12345',operation:'fill',status:'unknown',snapshot:{id:'source',revision:55,title:'原始长稿完整保留',markdown:'原文',media:[]}};await legacy.put('tasks',value);legacy.close();
 vi.resetModules();const {db}=await import('../src/core/repository');const next=await db();expect(next.version).toBe(3);expect(await next.get('tasks','kept')).toEqual(value);expect(await next.getAll('backups')).toEqual([]);expect(await next.getAll('receipts')).toEqual([]);next.close();
});
