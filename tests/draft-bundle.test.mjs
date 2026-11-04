// Artificial normalized catalog fixtures; none of these are real Emall products or responses.
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {openStore} from '../server/store.mjs';
import {loadDraftBundle} from '../server/draft-bundle.mjs';

const source={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
let dir,dataDir,bundleDir,store;
const count=table=>store.db.prepare('SELECT count(*) AS n FROM '+table).get().n;
beforeEach(async()=>{
 dir=await mkdtemp(join(tmpdir(),'homeharmony-draft-bundle-'));dataDir=join(dir,'store');bundleDir=join(dir,'bundle');
 await mkdir(join(bundleDir,'media'),{recursive:true});store=openStore(dataDir);
});
afterEach(async()=>{store.close();await rm(dir,{recursive:true,force:true})});
async function fixture({products=5,color='#1769e0'}={}){
 const bytes=await sharp({create:{width:40,height:30,channels:3,background:color}}).webp({quality:85}).toBuffer();
 const sha256=createHash('sha256').update(bytes).digest('hex'),url='/uploads/emall-'+sha256+'.webp';
 const manifest={version:1,source:{...source},products:Array.from({length:products},(_,i)=>({externalId:'fixture-product-'+i,name:'Искусственный товар '+i,cat:'beanies',summary:'Только внутренний тест.',attrs:{Материал:'Тестовый материал'},images:[url],variants:[{externalId:'fixture-variant-'+i,externalSku:'ТЕСТ-'+i,price:12.5,stock:5,options:{Цвет:'Чёрный'},images:[url]}]})),media:[{url,file:sha256+'.webp',sha256,width:40,height:30,bytes:bytes.length}]};
 await writeFile(join(bundleDir,'media',sha256+'.webp'),bytes);await save(manifest);return {manifest,bytes,url,sha256};
}
async function save(manifest){await writeFile(join(bundleDir,'manifest.json'),JSON.stringify(manifest))}
function linked(){return store.db.prepare('SELECT product_id FROM import_products WHERE provider=? AND environment=? AND account=? ORDER BY external_id').all(...Object.values(source)).map(row=>row.product_id)}
function imported(index=0){return store.products().find(p=>p.id===linked()[index])}
async function assertUntouched(){assert.equal(count('products'),14);assert.equal(count('media'),0);assert.equal(count('import_products'),0);assert.deepEqual(await readdir(store.uploadDir),[]);assert.equal(store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='draft_bundle_versions'").get().n,0)}

test('a missing manifest is a read-only no-op',async()=>{
 assert.deepEqual(loadDraftBundle(store,join(dir,'absent')),{applied:false,reason:'missing'});await assertUntouched();
});
test('five records become drafts with copied local photos, which are public only after publication',async()=>{
 const {bytes,url,sha256}=await fixture();const result=loadDraftBundle(store,bundleDir);
 assert.equal(result.created,5);assert.equal(result.applied,true);assert.equal(count('products'),19);assert.equal(store.products(true).length,14);
 assert.equal(linked().length,5);assert(linked().every(id=>store.products().find(p=>p.id===id).status==='draft'));
 assert.equal(count('media'),1);assert.deepEqual(await readFile(join(store.uploadDir,'emall-'+sha256+'.webp')),bytes);assert.equal(store.isPublicMedia(url),false);
 const product=imported();assert.equal(product.variants[0].externalSku,'ТЕСТ-0');assert.equal(product.variants[0].sourceManaged,true);assert.match(product.variants[0].sku,/^EMALL-P-[A-F0-9]{24}$/);
 store.saveProduct({...product,status:'published'},product.id);assert.equal(store.isPublicMedia(url),true);
 assert.equal(store.products(true).length,15);assert.equal(count('draft_bundle_versions'),1);
});
test('an unchanged bundle survives restart without duplicate products or overwriting manual edits',async()=>{
 await fixture();const first=loadDraftBundle(store,bundleDir),ids=linked(),product=imported();
 product.name='Имя продавца';product.variants[0].price=19.99;store.saveProduct(product,product.id);
 const version=imported().version;store.close();store=openStore(dataDir);
 const replay=loadDraftBundle(store,bundleDir);assert.equal(replay.reason,'unchanged');assert.equal(replay.digest,first.digest);
 assert.deepEqual(linked(),ids);assert.equal(count('products'),19);assert.equal(count('import_runs'),1);assert.equal(imported().name,'Имя продавца');assert.equal(imported().variants[0].price,19.99);assert.equal(imported().version,version);
});
test('an unchanged bundle repairs a missing upload without importing products again',async()=>{
 const {sha256,bytes}=await fixture();loadDraftBundle(store,bundleDir);const product=imported();product.name='Сохранённое имя';store.saveProduct(product,product.id);
 await rm(join(store.uploadDir,'emall-'+sha256+'.webp'));
 assert.equal(loadDraftBundle(store,bundleDir).reason,'unchanged');assert.equal(imported().name,'Сохранённое имя');assert.equal(count('import_runs'),1);assert.deepEqual(await readFile(join(store.uploadDir,'emall-'+sha256+'.webp')),bytes);
});
test('a changed bundle keeps source links, publication, stock, reservations and historical orders',async()=>{
 const {manifest}=await fixture({products:1});loadDraftBundle(store,bundleDir);const product=imported(),id=product.id,sku=product.variants[0].sku;
 product.status='published';product.cat='hats';product.attrs.Уход='Локальная заметка';store.saveProduct(product,id);
 store.db.prepare('INSERT INTO admins VALUES(?,?)').run('seller@example.test','test-password-hash');
 store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('existing-session','seller@example.test','existing-csrf',Date.now()+3600000);
 const receipt=store.orders.create({customer:{name:'Тест',phone:'+375291234567',city:'Минск',address:''},delivery:'pickup',payment:'manual',consent:true,shippingCents:0,items:[{id,sku,qty:1,priceCents:1250}]},randomUUID(),'bundle-test').receipt;
 manifest.products[0].name='Изменённое имя источника';manifest.products[0].variants[0].price=14;manifest.products[0].variants[0].stock=20;manifest.products[0].variants[0].externalSku='ИЗМЕНЁННЫЙ-ТЕСТ';await save(manifest);
 const result=loadDraftBundle(store,bundleDir),updated=imported();assert.equal(result.updated,1);assert.equal(updated.id,id);assert.equal(updated.variants[0].sku,sku);
 assert.equal(updated.name,'Изменённое имя источника');assert.equal(updated.variants[0].price,14);assert.equal(updated.variants[0].externalSku,'ИЗМЕНЁННЫЙ-ТЕСТ');assert.equal(updated.status,'published');assert.equal(updated.cat,'hats');assert.equal(updated.attrs.Уход,'Локальная заметка');
 assert.equal(updated.variants[0].stock,5);assert.equal(updated.variants[0].reserved,1);assert.equal(store.orders.detail(receipt.id).items[0].priceCents,1250);assert.equal(store.orders.detail(receipt.id).status,'new');assert.equal(count('admins'),1);assert.equal(count('sessions'),1);assert.equal(count('products'),15);
});
test('tampered bytes, metadata, foreign URLs, paths and unsafe product payloads fail before writes',async()=>{
 const {manifest,sha256,bytes}=await fixture();
 const corruptions=[
  value=>value.media[0].file='../outside.webp',
  value=>value.media[0].url='https://example.test/photo.webp',
  value=>value.media[0].bytes++,
  value=>value.media[0].width++,
  value=>value.source.environment='sandbox',
  value=>value.products=Array.from({length:5001},(_,i)=>({...value.products[0],externalId:String(i)})),
  value=>value.products[0].status='published',
  value=>value.products[0].images=['https://example.test/image.webp'],
  value=>value.products[0].variants[0].stock=null,
  value=>value.products[0].cat='missing',
  value=>value.products[0].privateApiToken='must-not-be-a-bundle-field',
 ];
 for(const mutate of corruptions){const bad=structuredClone(manifest);mutate(bad);await save(bad);assert.throws(()=>loadDraftBundle(store,bundleDir),/Invalid Emall draft bundle/);await assertUntouched()}
 await save(manifest);await writeFile(join(bundleDir,'media',sha256+'.webp'),Buffer.from('tampered'));
 assert.throws(()=>loadDraftBundle(store,bundleDir),/SHA-256/);await assertUntouched();
 // Even a matching hash and size must identify a WebP, rather than another uploaded file type.
 const wrong=structuredClone(manifest),wrongBytes=Buffer.from('This is not a WebP image.'),wrongHash=createHash('sha256').update(wrongBytes).digest('hex');
 wrong.media[0]={...wrong.media[0],sha256:wrongHash,file:wrongHash+'.webp',url:'/uploads/emall-'+wrongHash+'.webp',bytes:wrongBytes.length};
 for(const product of wrong.products){product.images=[wrong.media[0].url];product.variants[0].images=[wrong.media[0].url]}
 await writeFile(join(bundleDir,'media',wrong.media[0].file),wrongBytes);await save(wrong);assert.throws(()=>loadDraftBundle(store,bundleDir),/WebP/);await assertUntouched();
 await writeFile(join(bundleDir,'media',sha256+'.webp'),bytes);
});
test('symlinked manifest, media files and media directories are rejected before writes',async()=>{
 const {manifest,bytes,sha256}=await fixture();
 const outside=join(dir,'outside.webp');await writeFile(outside,bytes);const photo=join(bundleDir,'media',sha256+'.webp');await rm(photo);await symlink(outside,photo);
 assert.throws(()=>loadDraftBundle(store,bundleDir),/symlink/);await assertUntouched();
 await rm(join(bundleDir,'media'),{recursive:true});await mkdir(join(dir,'outside-media'));await writeFile(join(dir,'outside-media',sha256+'.webp'),bytes);await symlink(join(dir,'outside-media'),join(bundleDir,'media'));
 assert.throws(()=>loadDraftBundle(store,bundleDir),/symlink/);await assertUntouched();
 await writeFile(join(dir,'outside-manifest.json'),JSON.stringify(manifest));await rm(join(bundleDir,'manifest.json'));await symlink(join(dir,'outside-manifest.json'),join(bundleDir,'manifest.json'));
 assert.throws(()=>loadDraftBundle(store,bundleDir),/symlink/);await assertUntouched();
});
test('a conflicting upload or media registration is never overwritten',async()=>{
 const {url,sha256,bytes}=await fixture();const path=join(store.uploadDir,'emall-'+sha256+'.webp');
 await writeFile(path,'unrelated local bytes');assert.throws(()=>loadDraftBundle(store,bundleDir),/immutable content/);assert.equal(await readFile(path,'utf8'),'unrelated local bytes');assert.equal(count('products'),14);assert.equal(count('media'),0);
 await writeFile(path,bytes);store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(url,'unrelated.webp',40,30,bytes.length);
 assert.throws(()=>loadDraftBundle(store,bundleDir),/immutable content/);assert.equal(store.db.prepare('SELECT filename FROM media WHERE url=?').get(url).filename,'unrelated.webp');assert.equal(count('products'),14);
});
test('a failed import rolls back products and marker and removes only its new media resources',async()=>{
 const {sha256,url,bytes}=await fixture();const original=join(store.uploadDir,'unrelated.webp');await writeFile(original,'keep me');
 store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run('/uploads/unrelated.webp','unrelated.webp',1,1,7);
 store.db.exec("CREATE TRIGGER fail_bundle BEFORE INSERT ON import_variants BEGIN SELECT RAISE(ABORT,'simulated bundle failure'); END;");
 assert.throws(()=>loadDraftBundle(store,bundleDir),/simulated bundle failure/);assert.equal(count('products'),14);assert.equal(count('import_products'),0);assert.equal(count('import_runs'),0);assert.equal(count('draft_bundle_versions'),0);assert.equal(count('media'),1);assert.deepEqual(await readdir(store.uploadDir),['unrelated.webp']);assert.equal(await readFile(original,'utf8'),'keep me');
 // A pre-existing immutable file and registration belong to the store and survive a failed retry.
 await writeFile(join(store.uploadDir,'emall-'+sha256+'.webp'),bytes);store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(url,'emall-'+sha256+'.webp',40,30,bytes.length);
 assert.throws(()=>loadDraftBundle(store,bundleDir),/simulated bundle failure/);assert.equal(count('media'),2);assert.deepEqual(await readFile(join(store.uploadDir,'emall-'+sha256+'.webp')),bytes);
 store.db.exec('DROP TRIGGER fail_bundle');assert.equal(loadDraftBundle(store,bundleDir).created,5);
});
test('failure while recording the bundle version rolls back the core import too',async()=>{
 await fixture();store.db.exec(`CREATE TABLE draft_bundle_versions(provider TEXT NOT NULL,environment TEXT NOT NULL,account TEXT NOT NULL,digest TEXT NOT NULL,applied_at TEXT NOT NULL,PRIMARY KEY(provider,environment,account));
 CREATE TRIGGER fail_version BEFORE INSERT ON draft_bundle_versions BEGIN SELECT RAISE(ABORT,'simulated marker failure'); END;`);
 assert.throws(()=>loadDraftBundle(store,bundleDir),/simulated marker failure/);assert.equal(count('products'),14);assert.equal(count('import_products'),0);assert.equal(count('import_runs'),0);assert.equal(count('draft_bundle_versions'),0);assert.equal(count('media'),0);assert.deepEqual(await readdir(store.uploadDir),[]);
});

test('bulk bundle imports 500 drafts and independent slots preserve subsequent manual edits',async()=>{
 const {manifest}=await fixture({products:500});
 loadDraftBundle(store,bundleDir,{slot:'mass'});assert.equal(linked().length,500);assert.equal(store.products(true).length,14);
 const p=imported();store.saveProduct({...p,name:'Правка после импорта'},p.id);
 loadDraftBundle(store,bundleDir,{slot:'mass'});assert.equal(store.products().find(x=>x.id===p.id).name,'Правка после импорта');assert.equal(linked().length,500);
 const other=join(dir,'other');await mkdir(other);await mkdir(join(other,'media'));
 const image=manifest.media[0];await writeFile(join(other,'media',image.file),await readFile(join(bundleDir,'media',image.file)));
 await writeFile(join(other,'manifest.json'),JSON.stringify({...manifest,products:[{...manifest.products[0],externalId:'separate',variants:[{...manifest.products[0].variants[0],externalId:'separate'}]}]}));
 loadDraftBundle(store,other);loadDraftBundle(store,bundleDir,{slot:'mass'});loadDraftBundle(store,other);
 assert.equal(store.products().find(x=>x.id===p.id).name,'Правка после импорта');assert.equal(linked().length,501);
});
