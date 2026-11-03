// Internal normalized records only. These fixtures are NOT Emall API responses.
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import{tmpdir}from'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {openStore} from '../server/store.mjs';
let dir,store;
const sandbox={provider:'emall',environment:'sandbox',account:'test-seller'};
const production={...sandbox,environment:'production'};
function records(count=6){return Array.from({length:count},(_,i)=>({externalId:'test-product-'+i,name:'Тестовый импорт '+i,cat:'beanies',summary:'Внутренний тест, не товар Emall.',attrs:{Материал:'Тестовый материал'},variants:[{externalId:'test-variant-'+i,externalSku:'Исходный артикул '+i,price:12.5,stock:5,options:{Цвет:'Чёрный'},images:[]}]}))}
const count=()=>store.db.prepare('SELECT count(*) AS n FROM products').get().n;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'homeharmony-import-'));store=openStore(dir)});
afterEach(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
test('preview defaults to five and writes neither source links nor product records',()=>{
 const preview=store.imports.preview(records(),sandbox);assert.equal(preview.selected,5);assert.equal(preview.remaining,1);assert.equal(preview.created,5);assert.equal(count(),14);assert.equal(store.db.prepare('SELECT count(*) AS n FROM import_products').get().n,0);
 assert(preview.items.every(item=>item.warnings.some(w=>w.code==='NO_LOCAL_PHOTOS')));
});
test('first batch creates five drafts, preserves source articles and replay creates no duplicates',()=>{
 const first=store.imports.apply(records(),sandbox);assert.equal(first.created,5);assert.equal(count(),19);assert.equal(store.products(true).length,14);
 const again=store.imports.apply(records(),sandbox);assert.equal(again.created,0);assert.equal(again.unchanged,5);assert.equal(count(),19);
 assert.deepEqual(again.items.map(item=>item.productId),first.items.map(item=>item.productId));
 const item=store.products().find(p=>p.id===first.items[0].productId);assert.equal(item.status,'draft');assert.equal(item.variants[0].externalSku,'Исходный артикул 0');assert.equal(item.variants[0].sourceManaged,true);
});
test('sandbox, production and seller accounts cannot overwrite each other',()=>{
 const row=records(1),a=store.imports.apply(row,sandbox),b=store.imports.apply(row,production),c=store.imports.apply(row,{...production,account:'different-test-seller'});
 assert.equal(new Set([a.items[0].productId,b.items[0].productId,c.items[0].productId]).size,3);assert.equal(count(),17);
 const product=store.products().find(p=>p.id===a.items[0].productId);assert.throws(()=>store.saveProduct({...product,status:'published'},product.id),e=>e.status===409);
});
test('changing source article preserves the same local SKU and mapping',()=>{
 const data=records(1),first=store.imports.apply(data,sandbox),sku=first.items[0].variants[0].localSku;data[0].variants[0].externalSku='Новый артикул';
 store.imports.apply(data,sandbox);const item=store.products().find(p=>p.id===first.items[0].productId);assert.equal(item.variants[0].sku,sku);assert.equal(item.variants[0].externalSku,'Новый артикул');assert.equal(count(),15);
});
test('updates preserve local stock, reservations, publication state, category and extra attributes',()=>{
 const data=records(1),first=store.imports.apply(data,production),id=first.items[0].productId;
 let item=store.products().find(p=>p.id===id);item.status='published';item.attrs.Уход='Локальное поле';item.cat='hats';store.saveProduct(item,id);
 const sku=item.variants[0].sku,order=store.orders.create({customer:{name:'Тест',phone:'+375291234567',city:'Минск',address:''},delivery:'pickup',payment:'manual',consent:true,shippingCents:0,items:[{id,sku,qty:1,priceCents:1250}]},'12345678-1234-4123-8123-123456789012','test').receipt;
 data[0].name='Обновлённое имя';data[0].variants[0].price=14;data[0].variants[0].stock=20;
 const update=store.imports.apply(data,production);assert.equal(update.updated,1);assert(update.items[0].warnings.some(w=>w.code==='LOCAL_STOCK_PRESERVED'));
 item=store.products().find(p=>p.id===id);assert.equal(item.name,'Обновлённое имя');assert.equal(item.status,'published');assert.equal(item.cat,'hats');assert.equal(item.attrs.Уход,'Локальное поле');assert.equal(item.variants[0].stock,5);assert.equal(item.variants[0].reserved,1);assert.equal(item.variants[0].price,14);assert.equal(store.orders.detail(order.id).items[0].priceCents,1250);
});
test('a source subset does not delete previously imported or manually added variants',()=>{
 const data=records(1);data[0].variants.push({...data[0].variants[0],externalId:'second',options:{Цвет:'Белый'}});const first=store.imports.apply(data,sandbox);
 const id=first.items[0].productId;data[0].variants.pop();const update=store.imports.apply(data,sandbox);assert.equal(store.products().find(p=>p.id===id).variants.length,2);assert(update.items[0].warnings.some(w=>w.code==='EXISTING_VARIANTS_RETAINED'));
});
test('invalid categories, missing prices/stock, repeated identities and remote photo URLs fail before changes',()=>{
 const changes=[d=>d[1].cat='missing',d=>delete d[1].variants[0].price,d=>delete d[1].variants[0].stock,d=>d[1].attrs='invalid',d=>d[1].externalId=d[0].externalId,d=>d[1].variants.push({...d[1].variants[0]}),d=>d[1].images=['https://unverified.example/photo.jpg']];
 for(const change of changes){const data=records(2);change(data);assert.throws(()=>store.imports.apply(data,sandbox),e=>e.status===422);assert.equal(count(),14);assert.equal(store.db.prepare('SELECT count(*) AS n FROM import_products').get().n,0)}
});
test('failure after creating a product rolls back product, variant, link and batch log together',()=>{
 store.db.exec("CREATE TRIGGER simulate_fault BEFORE INSERT ON import_variants BEGIN SELECT RAISE(ABORT,'simulated transaction failure'); END;");
 assert.throws(()=>store.imports.apply(records(1),sandbox));assert.equal(count(),14);assert.equal(store.db.prepare('SELECT count(*) AS n FROM import_products').get().n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM import_runs').get().n,0);
 store.db.exec('DROP TRIGGER simulate_fault');assert.equal(store.imports.apply(records(1),sandbox).created,1);
});
test('bindings survive restart and linked SKUs cannot be accidentally renamed/deleted',()=>{
 const first=store.imports.apply(records(1),sandbox),id=first.items[0].productId;store.close();store=openStore(dir);
 assert.equal(store.imports.apply(records(1),sandbox).unchanged,1);const product=store.products().find(p=>p.id===id);product.variants[0].sku='MANUAL-RENAME';assert.throws(()=>store.saveProduct(product,id),e=>e.status===409);assert.equal(count(),15);
});
test('the internal transaction option cannot be used without an active transaction',()=>{
 assert.throws(()=>store.saveProduct({},undefined,{withinTransaction:true}),/active transaction/);
});

test('normalization keeps repeated whitespace-equivalent records unchanged',()=>{
 const data=records(1);data[0].summary='  Текст  ';data[0].variants[0].options.Цвет=' Чёрный ';
 store.imports.apply(data,sandbox);assert.equal(store.imports.apply(data,sandbox).unchanged,1);
});
test('the developer CLI previews, applies five and can be resumed without duplicate products',async()=>{
 const file=join(dir,'internal-fixture.json');await writeFile(file,JSON.stringify({source:sandbox,products:records()}));
 async function run(apply=false){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/import-normalized.mjs','--file',file,...(apply?['--apply']:[])],{cwd:new URL('../',import.meta.url),env:{...process.env,SHOP_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>{if(code)reject(new Error(stderr));else resolve(JSON.parse(stdout))});
 })}
 assert.equal((await run()).created,5);assert.equal(count(),14);assert.equal((await run(true)).created,5);assert.equal(count(),19);assert.equal((await run(true)).unchanged,5);
});
test('import migration preserves orders and reserved stock in the preceding database schema',()=>{
 const order=store.orders.create({customer:{name:'Тест',phone:'+375291234567',city:'Минск',address:''},delivery:'pickup',payment:'manual',consent:true,shippingCents:0,items:[{id:'hat-line',sku:'HAT-LINE-1',qty:1,priceCents:5000}]},randomUUID(),'migration-test').receipt;
 store.db.exec('DROP TABLE import_variants; DROP TABLE import_products; DROP TABLE import_runs; DELETE FROM migrations WHERE version=3;');store.close();store=openStore(dir);
 assert.equal(store.orders.detail(order.id).status,'new');assert.equal(store.orders.reserved('HAT-LINE-1'),1);assert.equal(count(),14);assert.equal(store.products(true).find(p=>p.id==='hat-line').variants[0].stock,11);
});
