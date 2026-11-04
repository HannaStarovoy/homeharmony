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
  assert.equal(store.categories().find(c=>c.id==='oral-care').parent,'beauty-health');assert.equal(store.categories().find(c=>c.id==='nail-care').parent,'beauty-health');
  store.saveProduct({...moved,cat:'accessories'},moved.id);store.close();store=openStore(dir);assert.equal(store.products().find(x=>x.id===p.id).cat,'accessories');
 }finally{store?.close();await rm(dir,{recursive:true,force:true})}
});
