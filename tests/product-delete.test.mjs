import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {createAdmin} from '../server/auth.mjs';
import {openStore} from '../server/store.mjs';
import sharp from 'sharp';
import {applyCatalogPublication} from '../server/catalog-publication.mjs';
let app,dir,base,auth,password;
const source={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'shop-delete-'));app=createApp({dataDir:dir});password=randomBytes(24).toString('base64url');await createAdmin(app.store,'owner@example.test',password);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;const r=await fetch(base+'/api/admin/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password})});const body=await r.json();auth={Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':body.csrf}});
afterEach(async()=>{await new Promise(r=>app.server.close(r));app.store.close();await rm(dir,{recursive:true,force:true})});
async function remove(p,headers=auth){return fetch(base+'/api/admin/products/'+p.id,{method:'DELETE',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({version:p.version})})}
test('deletion enforces authentication CSRF origin and optimistic version and hides the product',async()=>{
 let p=app.store.products()[0];const image='/uploads/delete-fixture.webp';const bytes=await sharp({create:{width:1,height:1,channels:3,background:'#ccc'}}).webp().toBuffer();await writeFile(join(app.store.uploadDir,'delete-fixture.webp'),bytes);app.store.db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run(image,'delete-fixture.webp',1,1,bytes.length);p=app.store.saveProduct({...p,images:[image]},p.id);assert.equal((await fetch(base+image)).status,200);assert.equal((await remove(p,{})).status,401);assert.equal((await remove(p,{...auth,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await fetch(base+'/api/admin/products/'+p.id,{method:'DELETE',headers:{...auth,Origin:'https://other.invalid','Content-Type':'application/json'},body:JSON.stringify({version:p.version})})).status,403);
 assert.equal((await fetch(base+'/api/admin/products/'+p.id,{method:'DELETE',headers:{...auth,Origin:base,'Content-Type':'application/json'},body:'null'})).status,422);assert.equal((await remove({...p,version:0})).status,422);assert.equal((await remove({...p,version:p.version+1})).status,409);
 assert.equal((await remove(p)).status,200);assert.equal((await fetch(base+image)).status,404);assert(!app.store.products().some(x=>x.id===p.id));assert(!(await (await fetch(base+'/api/catalog')).json()).products.some(x=>x.id===p.id));assert.equal((await remove(p)).status,404);
 assert.throws(()=>app.store.saveProduct(p,p.id),e=>e.status===404);
});
test('active reservations block deletion; after cancellation historical order items remain intact',async()=>{
 const p=app.store.products().find(x=>x.id==='hat-line'),v=p.variants[0];
 const order=app.store.orders.create({customer:{name:'Тест',phone:'+375291234567',city:'Минск',address:'Тестовый адрес'},consent:true,delivery:'pickup',payment:'manual',shippingCents:0,items:[{id:p.id,sku:v.sku,qty:1,priceCents:Math.round(v.price*100)}]},randomUUID(),'test');
 const detail=app.store.orders.detail(order.receipt.id),snapshot=structuredClone(detail.items);
 assert.throws(()=>app.store.deleteProduct(p.id,app.store.products().find(x=>x.id===p.id).version),e=>e.status===409);
 app.store.orders.update(detail.id,{status:'cancelled',version:detail.version,note:''},'owner@example.test');
 app.store.deleteProduct(p.id,app.store.products().find(x=>x.id===p.id).version);assert.deepEqual(app.store.orders.detail(detail.id).items,snapshot);
});
test('deleted Emall products stay absent after imports restart and a pending publication decision',async()=>{
 const records=Array.from({length:5},(_,i)=>({externalId:String(100+i),name:'Synthetic '+i,cat:'beanies',variants:[{externalId:String(100+i),price:12,stock:2}]}));app.store.imports.apply(records,source);
 const link=app.store.db.prepare('SELECT product_id FROM import_products WHERE external_id=?').get('100'),p=app.store.products().find(x=>x.id===link.product_id);app.store.deleteProduct(p.id,p.version);
 app.store.imports.apply(records.map(r=>({...r,name:'Updated'})),source);assert(!app.store.products().some(x=>x.id===p.id));
 const plan=join(dir,'plan.json');await writeFile(plan,JSON.stringify({version:1,id:'emall-first-five-2026-11-04',source,externalIds:records.map(r=>r.externalId)}));assert.equal(applyCatalogPublication(app.store,plan).published,4);
 const second=openStore(dir);try{second.imports.apply(records,source);assert(!second.products().some(x=>x.id===p.id));assert.equal(second.db.prepare('SELECT count(*) n FROM import_products').get().n,5)}finally{second.close()}
});
test('admin confirmation can cancel deletion and then removes a card after accepting',async()=>{
 const {chromium}=await import('playwright'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.goto(base+'/admin');await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('[data-delete]').first().waitFor();const id=await page.locator('[data-delete]').first().getAttribute('data-delete');
 page.once('dialog',d=>d.dismiss());await page.locator('[data-delete="'+id+'"]').click();assert(app.store.products().some(p=>p.id===id));
 await page.locator('[data-edit="'+id+'"]').click();await page.getByRole('button',{name:'Удалить товар',exact:true}).waitFor();page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Удалить товар',exact:true}).click();await page.getByText('Товар удалён.',{exact:true}).waitFor();assert(!app.store.products().some(p=>p.id===id));assert.equal(await page.locator('[data-delete="'+id+'"]').count(),0);
 }finally{await browser.close()}
});
