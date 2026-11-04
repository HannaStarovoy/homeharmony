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
