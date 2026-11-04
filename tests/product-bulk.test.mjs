import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.mjs';
import {createAdmin} from '../server/auth.mjs';
let app,dir,base,auth,password;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'shop-bulk-'));app=createApp({dataDir:dir});password=randomBytes(24).toString('base64url');await createAdmin(app.store,'owner@example.test',password);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.server.address().port;const r=await fetch(base+'/api/admin/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password})});const data=await r.json();auth={Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrf}});
afterEach(async()=>{await new Promise(r=>app.server.close(r));app.store.close();await rm(dir,{recursive:true,force:true})});
const selection=ps=>ps.map(p=>({id:p.id,version:p.version}));
const call=(body,headers=auth)=>fetch(base+'/api/admin/products/bulk',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
function drafts(){return [1,2,3].map(i=>app.store.saveProduct({name:'Bulk fixture '+i,cat:'beanies',status:'draft',attrs:{},images:[],variants:[{sku:'BULK-'+i,price:10,stock:5,options:{}}]}))}
test('bulk publish and withdrawal affect only selected rows and preserve inventory',async()=>{
 const ps=drafts(),chosen=selection(ps.slice(0,2));assert.equal((await call({action:'publish',products:chosen},{})).status,401);assert.equal((await call({action:'publish',products:chosen},{...auth,'X-CSRF-Token':'bad'})).status,403);
 const r=await call({action:'publish',products:chosen});assert.equal(r.status,200);assert.equal((await r.json()).changed,2);assert.equal(app.store.products(true).length,16);assert.equal(app.store.products().find(p=>p.id===ps[2].id).status,'draft');
 const current=app.store.products().filter(p=>chosen.some(c=>c.id===p.id));assert(current.every(p=>p.variants[0].stock===5));assert.equal((await call({action:'draft',products:selection(current)})).status,200);assert.equal(app.store.products(true).length,14);
});
test('invalid publication or stale versions roll back the complete group',async()=>{
 const ps=drafts();const bad=app.store.saveProduct({...ps[1],variants:[{...ps[1].variants[0],price:0}]},ps[1].id);
 assert.equal((await call({action:'publish',products:selection([ps[0],bad])})).status,422);assert.equal(app.store.products().find(p=>p.id===ps[0].id).status,'draft');
 assert.equal((await call({action:'delete',products:selection([ps[0],ps[1]])})).status,409);assert(app.store.products().some(p=>p.id===ps[0].id));
 for(const body of [{action:'unknown',products:selection(ps)},{action:'delete',products:[]},{action:'delete',products:[selection(ps)[0],selection(ps)[0]]},null])assert.equal((await call(body)).status,422);
});
test('reserved item prevents deleting every selected product',async()=>{
 const ps=drafts(),p=app.store.products().find(p=>p.id==='hat-line'),v=p.variants[0];app.store.orders.create({customer:{name:'Тест',phone:'+375291234567',city:'Минск'},consent:true,delivery:'pickup',payment:'manual',shippingCents:0,items:[{id:p.id,sku:v.sku,qty:1,priceCents:Math.round(v.price*100)}]},randomUUID(),'test');
 const current=app.store.products().find(x=>x.id===p.id);assert.equal((await call({action:'delete',products:selection([ps[0],current])})).status,409);assert(app.store.products().some(x=>x.id===ps[0].id));assert.equal((await call({action:'delete',products:selection(ps)})).status,200);assert(!app.store.products().some(x=>ps.some(p=>p.id===x.id)));
});
test('checkbox selection follows filters and bulk confirmation can be cancelled or applied',async()=>{
 const ps=drafts(),{chromium}=await import('playwright'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.goto(base+'/admin');await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('#search').fill('Bulk fixture');await page.locator('#select-all-products').check();assert.equal(await page.locator('[data-select-product]:checked').count(),3);
 await page.locator('#search').fill('Bulk fixture 1');assert.equal(await page.locator('[data-select-product]:checked').count(),0);await page.locator('#select-all-products').check();page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Применить к выбранным',exact:true}).click();assert.equal(app.store.products().find(p=>p.id===ps[0].id).status,'draft');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Применить к выбранным',exact:true}).click();await page.getByText('Обработано товаров: 1. Изменено: 1.',{exact:true}).waitFor();assert.equal(app.store.products().find(p=>p.id===ps[0].id).status,'published');assert.equal(app.store.products().find(p=>p.id===ps[1].id).status,'draft');assert.equal(await page.locator('[data-select-product]:checked').count(),0);await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{await browser.close()}
});
test('bulk category and prices validate and commit atomically',async()=>{
 const ps=drafts();
 assert.equal((await call({action:'category',products:selection(ps),category:'missing'})).status,422);
 assert.equal((await call({action:'category',products:selection(ps.slice(0,2)),category:'scarves'})).status,200);
 let current=app.store.products().filter(p=>ps.slice(0,2).some(x=>x.id===p.id));assert(current.every(p=>p.cat==='scarves'));
 assert.equal((await call({action:'price',products:selection(current),mode:'percent',amount:15})).status,200);
 current=app.store.products().filter(p=>ps.slice(0,2).some(x=>x.id===p.id));assert(current.every(p=>p.variants[0].price===11.5));
 assert.equal((await call({action:'price',products:selection(current),mode:'amount',amount:-12})).status,422);
 assert(current.every(p=>app.store.products().find(x=>x.id===p.id).variants[0].price===11.5));
 assert.equal(app.store.products().find(p=>p.id===ps[2].id).variants[0].price,10);
});
test('review filter and product copy create independent draft editor',async()=>{
 const ps=drafts(),{chromium}=await import('playwright'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{const page=await browser.newPage();await page.goto(base+'/admin');await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('#search').fill('Bulk fixture');await page.locator('#review-filter').check();assert.equal(await page.locator('[data-copy]').count(),3);await page.locator('#select-all-products').check();await page.locator('#bulk-action').selectOption('price');await page.locator('#price-amount').fill('10');await page.getByRole('button',{name:'Применить к выбранным',exact:true}).click();await page.getByRole('dialog').waitFor();assert((await page.locator('.price-preview-list').innerText()).includes('10 BYN → 20 BYN'));await page.getByRole('button',{name:'Отмена',exact:true}).click();assert.equal(app.store.products().find(p=>p.id===ps[0].id).variants[0].price,10);await page.locator('#bulk-action').selectOption('category');await page.locator('#bulk-category').selectOption('scarves');page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Применить к выбранным',exact:true}).click();await page.getByText('Обработано товаров: 3. Изменено: 3.',{exact:true}).waitFor();await page.locator('[data-copy="'+ps[0].id+'"]').click();await page.locator('#product-form').waitFor();assert.equal(await page.locator('[name=name]').inputValue(),'Bulk fixture 1 — копия');assert.equal(await page.locator('[data-variant-field=stock]').inputValue(),'0');assert.notEqual(await page.locator('[data-variant-field=sku]').inputValue(),ps[0].variants[0].sku);await page.getByRole('button',{name:'Сохранить черновик',exact:true}).click();await page.getByText('Черновик сохранён. Покупатели его не видят.',{exact:true}).waitFor();const copy=app.store.products().find(p=>p.name==='Bulk fixture 1 — копия');assert(copy);assert.equal(copy.status,'draft');assert.equal(copy.variants[0].stock,0)}finally{await browser.close()}
});
test('inline SKU editing saves only its row and preserves other pending edits',async()=>{
 const ps=drafts(),p=app.store.saveProduct({...ps[0],variants:[...ps[0].variants.map(v=>({...v,options:{Размер:'M'}})),{sku:'BULK-EXTRA',price:20,stock:6,options:{Размер:'L'}}]},ps[0].id);
 const {chromium}=await import('playwright'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
 try{
  const page=await browser.newPage();await page.goto(base+'/admin');await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('#search').fill('Bulk fixture 1');
  await page.getByLabel('Текущая цена BULK-1',{exact:true}).fill('12.50');await page.getByLabel('Остаток BULK-1',{exact:true}).fill('8');await page.getByLabel('Цена до скидки BULK-1',{exact:true}).fill('15');await page.getByLabel('Текущая цена BULK-EXTRA',{exact:true}).fill('25');
  await page.locator('[data-quick-save="BULK-1"]').click();await page.getByText('Цена и остаток сохранены: BULK-1',{exact:true}).waitFor();
  const saved=app.store.products().find(x=>x.id===p.id);assert.equal(saved.variants[0].price,12.5);assert.equal(saved.variants[0].old,15);assert.equal(saved.variants[0].stock,8);assert.equal(saved.variants[1].price,20);assert.equal(await page.getByLabel('Текущая цена BULK-EXTRA',{exact:true}).inputValue(),'25');assert.equal(await page.locator('#product-form').count(),0);
  await page.getByLabel('Остаток BULK-EXTRA',{exact:true}).fill('-1');await page.locator('[data-quick-save="BULK-EXTRA"]').click();await page.getByText('Укажите корректные цены и целый неотрицательный остаток.',{exact:true}).waitFor();assert.equal(app.store.products().find(x=>x.id===p.id).variants[1].stock,6);
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }finally{await browser.close()}
});
