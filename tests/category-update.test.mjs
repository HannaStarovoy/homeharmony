import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.mjs';
test('category update moves earrings once and preserves inventory and later edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'category-upgrade-'));let store;
 try{
  store=openStore(dir);const p=store.saveProduct({name:'Серьги с кристаллом',cat:'accessories',summary:'Описание',attrs:{},images:[],status:'draft',variants:[{sku:'EARRING-TEST',price:15,stock:3,options:{}}]});
  store.db.prepare('DELETE FROM migrations WHERE version=4').run();store.close();store=openStore(dir);
  const moved=store.products().find(x=>x.id===p.id);assert.equal(moved.cat,'jewelry');assert.equal(moved.variants[0].price,15);assert.equal(moved.variants[0].stock,3);assert.equal(moved.version,p.version+1);
  assert.equal(store.categories().find(c=>c.id==='oral-care').parent,'cosmetics');assert.equal(store.categories().find(c=>c.id==='nail-care').parent,'beauty-health');
  store.saveProduct({...moved,cat:'accessories'},moved.id);store.close();store=openStore(dir);assert.equal(store.products().find(x=>x.id===p.id).cat,'accessories');
 }finally{store?.close();await rm(dir,{recursive:true,force:true})}
});
test('beauty taxonomy upgrade moves neckwarmers once and retains inventory and manual edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beauty-upgrade-'));let store;
 try{
  store=openStore(dir);const p=store.saveProduct({name:'Манишка Эмираты',cat:'scarves',summary:'Описание',attrs:{},images:[],status:'draft',variants:[{sku:'NECKWARMER-TEST',price:30,stock:7,options:{}}]});
  store.db.prepare('DELETE FROM migrations WHERE version=5').run();store.db.prepare("UPDATE categories SET parent='all',name='Косметика и бытовая химия' WHERE id='cosmetics'").run();store.close();store=openStore(dir);
  const categories=store.categories(),children=categories.filter(c=>c.parent==='cosmetics').map(c=>c.id).sort();assert.deepEqual(children,['chemicals','face-care','foot-care','hair','oral-care']);assert.equal(categories.find(c=>c.id==='cosmetics').parent,'beauty-health');assert.equal(categories.find(c=>c.id==='cosmetics').name,'Косметика');assert.equal(categories.find(c=>c.id==='neckwarmers').parent,'accessories');
  const moved=store.products().find(x=>x.id===p.id);assert.equal(moved.cat,'neckwarmers');assert.equal(moved.variants[0].stock,7);assert.equal(moved.variants[0].price,30);store.saveProduct({...moved,cat:'scarves'},moved.id);store.close();store=openStore(dir);assert.equal(store.products().find(x=>x.id===p.id).cat,'scarves');
 }finally{store?.close();await rm(dir,{recursive:true,force:true})}
});
test('restoring an older backup applies the current beauty category upgrade',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beauty-backup-'));let store;
 try{store=openStore(dir);const p=store.saveProduct({name:'Манишка',cat:'scarves',attrs:{},images:[],status:'draft',variants:[{sku:'BEAUTY-BACKUP',price:15,stock:2,options:{}}]});store.db.prepare('DELETE FROM migrations WHERE version=5').run();store.db.prepare("UPDATE categories SET parent='all' WHERE id='cosmetics'").run();const bytes=await store.backups.exportBackup();await store.backups.restore(bytes);assert.equal(store.categories().find(c=>c.id==='cosmetics').parent,'beauty-health');assert.equal(store.products().find(x=>x.id===p.id).cat,'neckwarmers');assert(store.db.prepare('SELECT 1 FROM migrations WHERE version=5').get())}finally{store?.close();await rm(dir,{recursive:true,force:true})}
});
