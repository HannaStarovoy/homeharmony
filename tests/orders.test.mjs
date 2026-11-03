import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID,randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app.mjs';
import { createAdmin } from '../server/auth.mjs';
let dir,app,base,auth,password;
async function call(path,{method='GET',body,key,privateRequest=false,headers={}}={}){
 const response=await fetch(base+path,{method,headers:{...(privateRequest?auth:{}),...(method!=='GET'?{Origin:base}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(key?{'Idempotency-Key':key}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json()};
}
function checkout(sku='HAT-LINE-1',qty=1){const p=app.store.products(true).find(p=>p.variants.some(v=>v.sku===sku)),v=p.variants.find(v=>v.sku===sku);return {customer:{name:'Тестовый покупатель',phone:'+375 (29) 123-45-67',email:'buyer@example.test',city:'Минск',address:'Тестовый адрес',note:'Тестовый комментарий'},delivery:'courier',payment:'manual',consent:true,shippingCents:800,items:[{id:p.id,sku,qty,priceCents:Math.round(v.price*100)}]}}
async function create(body=checkout(),key=randomUUID()){const response=await call('/api/orders',{method:'POST',body,key});assert.equal(response.status,201);return {...response.data,key}}
async function detail(id){return (await call('/api/admin/orders/'+id,{privateRequest:true})).data}
async function transition(id,status){const order=await detail(id);return call('/api/admin/orders/'+id,{method:'PUT',privateRequest:true,body:{status,version:order.version,note:'Тест'}})}
const held=sku=>app.store.orders.reserved(sku),physical=sku=>app.store.db.prepare('SELECT stock FROM variants WHERE sku=?').get(sku)?.stock;
beforeEach(async()=>{
 dir=await mkdtemp(join(tmpdir(),'homeharmony-orders-'));app=createApp({dataDir:dir});password=randomBytes(24).toString('base64url');await createAdmin(app.store,'owner@example.test',password);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
 const response=await fetch(base+'/api/admin/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password})});const session=await response.json();auth={Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
});
afterEach(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(dir,{recursive:true,force:true})});
test('guest order snapshots actual prices, reserves availability and hides customer data publicly',async()=>{
 const body=checkout(),order=await create(body);assert.equal(order.totalCents,5800);assert.equal(held('HAT-LINE-1'),1);assert.equal(physical('HAT-LINE-1'),12);
 assert(!('customer' in order));assert(!JSON.stringify(order).includes(body.customer.email));
 const publicProduct=(await call('/api/catalog')).data.products.find(p=>p.id==='hat-line');assert.equal(publicProduct.variants[0].stock,11);
 const adminProduct=app.store.products().find(p=>p.id==='hat-line');assert.equal(adminProduct.variants[0].reserved,1);assert.equal(adminProduct.variants[0].available,11);
 const saved=await detail(order.id);assert.equal(saved.customer.phone,'+375291234567');assert.equal(saved.items[0].priceCents,5000);assert.equal(saved.status,'new');assert.equal(saved.events.length,1);
 assert.equal((await call('/api/admin/orders')).status,401);assert.equal((await call('/api/admin/orders/'+order.id)).status,401);
 assert.equal((await call('/api/orders/receipt')).status,422);assert.equal((await call('/api/orders/receipt',{key:randomUUID()})).status,404);
 assert.equal((await call('/api/orders/receipt',{key:order.key})).data.number,order.number);
});
test('replays after price changes or reservation exhaustion return the same order without reserving again',async()=>{
 const body=checkout('HAT-LINE-1',12),key=randomUUID(),first=await create(body,key);
 app.store.db.prepare('UPDATE variants SET price_cents=6000 WHERE sku=?').run('HAT-LINE-1');
 const replay=await call('/api/orders',{method:'POST',body:{...body,items:[...body.items].reverse()},key});assert.equal(replay.status,200);assert.equal(replay.data.id,first.id);assert.equal(held('HAT-LINE-1'),12);
 const changed=await call('/api/orders',{method:'POST',body:{...body,customer:{...body.customer,name:'Другое имя'}},key});assert.equal(changed.status,409);assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,1);
});
test('invalid consent, contacts, quantity, duplicated SKU, shipping and payment cannot reserve stock',async()=>{
 const cases=[p=>p.consent=false,p=>p.customer.phone='wrong',p=>p.customer.name='',p=>p.customer.email='invalid',p=>p.customer.address='',p=>p.items[0].qty=1.5,p=>p.items[0].qty=-1,p=>p.items.push(p.items[0]),p=>p.payment='online',p=>p.delivery='teleport',p=>p.delivery=['courier']];
 for(const change of cases){const body=checkout();change(body);assert.equal((await call('/api/orders',{method:'POST',body,key:randomUUID()})).status,422)}
 const wrongShipping=checkout();wrongShipping.shippingCents=0;assert.equal((await call('/api/orders',{method:'POST',body:wrongShipping,key:randomUUID()})).status,409);
 assert.equal(held('HAT-LINE-1'),0);assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,0);
});
test('changed prices, insufficient quantity, hidden products and one bad line roll back the whole order',async()=>{
 const price=checkout();price.items[0].priceCents=1;assert.equal((await call('/api/orders',{method:'POST',body:price,key:randomUUID()})).data.code,'CART_CHANGED');
 const tooMany=checkout('HAT-LINE-1',13);assert.equal((await call('/api/orders',{method:'POST',body:tooMany,key:randomUUID()})).status,409);
 const mixed=checkout();mixed.items.push({id:'unknown',sku:'UNKNOWN',qty:1,priceCents:10});assert.equal((await call('/api/orders',{method:'POST',body:mixed,key:randomUUID()})).status,409);
 const hidden=checkout();const p=app.store.products().find(p=>p.id==='hat-line');app.store.saveProduct({...p,status:'draft'},p.id);assert.equal((await call('/api/orders',{method:'POST',body:hidden,key:randomUUID()})).status,409);assert.equal(held('HAT-LINE-1'),0);
});
test('cancel releases only its own reservation; repeated cancellation is idempotent',async()=>{
 const one=await create(),two=await create();assert.equal(held('HAT-LINE-1'),2);
 const old=await detail(one.id);assert.equal((await transition(one.id,'cancelled')).status,200);assert.equal(held('HAT-LINE-1'),1);assert.equal(physical('HAT-LINE-1'),12);
 const repeat=await call('/api/admin/orders/'+one.id,{method:'PUT',privateRequest:true,body:{status:'cancelled',version:old.version}});assert.equal(repeat.status,200);assert.equal(held('HAT-LINE-1'),1);assert.equal((await detail(one.id)).events.length,2);
 assert.equal((await transition(one.id,'confirmed')).status,409);assert.equal((await detail(two.id)).status,'new');
});
test('confirmation retains the reserve; shipping decrements physical stock only once',async()=>{
 const order=await create();assert.equal((await transition(order.id,'shipped')).status,409);
 assert.equal((await transition(order.id,'confirmed')).status,200);assert.equal(held('HAT-LINE-1'),1);assert.equal((await detail(order.id)).reservedUntil,null);
 const staleProduct=app.store.products().find(p=>p.id==='hat-line');
 assert.equal((await transition(order.id,'shipped')).status,200);assert.equal(physical('HAT-LINE-1'),11);assert.equal(held('HAT-LINE-1'),0);
 assert.equal((await transition(order.id,'shipped')).status,200);assert.equal(physical('HAT-LINE-1'),11);
 assert.equal((await transition(order.id,'cancelled')).status,409);assert.equal((await transition(order.id,'completed')).status,200);assert.equal(physical('HAT-LINE-1'),11);
 assert.throws(()=>app.store.saveProduct(staleProduct,staleProduct.id),error=>error.status===409);
});
test('pickup can complete from confirmed; snapshots survive product changes',async()=>{
 const body=checkout();body.delivery='pickup';body.shippingCents=0;body.customer.address='';const order=await create(body);assert.equal(order.totalCents,5000);
 const p=app.store.products().find(p=>p.id==='hat-line');p.name='Изменённое название';p.variants[0].price=62;app.store.saveProduct(p,p.id);
 assert.equal((await detail(order.id)).items[0].name,'Шапка «Линия»');assert.equal((await detail(order.id)).items[0].priceCents,5000);
 await transition(order.id,'confirmed');assert.equal((await transition(order.id,'completed')).status,200);assert.equal(physical('HAT-LINE-1'),11);assert.equal(held('HAT-LINE-1'),0);
});
test('expiry releases pending reservations; replay cannot revive an expired order',async()=>{
 const body=checkout(),order=await create(body);app.store.db.prepare('UPDATE orders SET reserved_until=? WHERE id=?').run(Date.now()-1,order.id);
 await call('/api/catalog');assert.equal(held('HAT-LINE-1'),0);assert.equal((await detail(order.id)).status,'expired');
 const replay=await call('/api/orders',{method:'POST',body,key:order.key});assert.equal(replay.status,200);assert.equal(replay.data.status,'expired');assert.equal(held('HAT-LINE-1'),0);
});
test('admin cannot remove, redefine or reduce physical stock below an active reservation',async()=>{
 const order=await create(checkout('HAT-LINE-1',2));const original=app.store.products().find(p=>p.id==='hat-line');
 for(const change of [p=>p.variants=p.variants.filter(v=>v.sku!=='HAT-LINE-1'),p=>p.variants[0].stock=1,p=>p.variants[0].options.Размер='Другой']){
  const p=JSON.parse(JSON.stringify(original));change(p);assert.throws(()=>app.store.saveProduct(p,p.id),error=>error.status===409);
 }
 assert.equal(held('HAT-LINE-1'),2);assert.equal(physical('HAT-LINE-1'),12);await transition(order.id,'cancelled');
 const p=app.store.products().find(p=>p.id==='hat-line');p.variants=p.variants.filter(v=>v.sku!=='HAT-LINE-1');app.store.saveProduct(p,p.id);assert.equal((await detail(order.id)).items[0].sku,'HAT-LINE-1');
});
test('admin order edits enforce CSRF and optimistic concurrency; search and pagination are private',async()=>{
 const order=await create();const original=await detail(order.id);
 assert.equal((await call('/api/admin/orders/'+order.id,{method:'PUT',privateRequest:true,headers:{'X-CSRF-Token':'wrong'},body:{status:'confirmed',version:original.version}})).status,403);
 await transition(order.id,'confirmed');assert.equal((await call('/api/admin/orders/'+order.id,{method:'PUT',privateRequest:true,body:{status:'cancelled',version:original.version}})).status,409);
 const list=await call('/api/admin/orders?status=confirmed&q='+encodeURIComponent(order.number),{privateRequest:true});assert.equal(list.data.total,1);assert.equal(list.data.orders[0].id,order.id);
 assert.equal((await call('/api/admin/orders?status=wrong',{privateRequest:true})).status,422);
 assert.equal((await call('/api/orders',{method:'POST',body:checkout(),key:randomUUID(),headers:{Origin:'https://other.example'}})).status,403);
});
test('orders and reservations survive restart without seeding twice',async()=>{
 const order=await create();await new Promise(resolve=>app.server.close(resolve));app.store.close();app=createApp({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
 assert.equal((await detail(order.id)).status,'new');assert.equal(held('HAT-LINE-1'),1);assert.equal(app.store.products().length,14);
});
test('order creation rate limit allows replay without charging another attempt',async()=>{
 for(let i=0;i<10;i++)await create(checkout('SPONGES-5'));
 const extra=await call('/api/orders',{method:'POST',body:checkout('SPONGES-5'),key:randomUUID()});assert.equal(extra.status,429);assert.equal(held('SPONGES-5'),10);
});
async function concurrentOrders(keys){
 const barrier=new SharedArrayBuffer(8),gate=new Int32Array(barrier),workers=[];
 const body=checkout('HAT-LINE-1');app.store.db.prepare('UPDATE variants SET stock=1 WHERE sku=?').run('HAT-LINE-1');
 const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.module);const s=openStore(workerData.dir);parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.barrier),1,0);try{const r=s.orders.create(workerData.body,workerData.key,'worker');parentPort.postMessage({id:r.receipt.id,replayed:r.replayed})}catch(e){parentPort.postMessage({status:e.status})}finally{s.close()}})().catch(e=>{throw e});`;
 const results=keys.map(key=>new Promise((resolve,reject)=>{const worker=new Worker(code,{eval:true,workerData:{module:new URL('../server/store.mjs',import.meta.url).href,dir,body,key,barrier}});workers.push(worker);worker.on('error',reject);worker.on('message',message=>{if(message.ready){if(Atomics.add(gate,0,1)+1===keys.length){Atomics.store(gate,1,1);Atomics.notify(gate,1,keys.length)}}else resolve(message)})}));
 try{return await Promise.all(results)}finally{await Promise.all(workers.map(w=>w.terminate()))}
}
test('parallel database connections cannot sell the last SKU twice',async()=>{
 const results=await concurrentOrders([randomUUID(),randomUUID()]);assert.equal(results.filter(r=>r.id).length,1);assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(held('HAT-LINE-1'),1);assert.equal(physical('HAT-LINE-1'),1);
});
test('parallel replays with one idempotency key create a single order and reservation',async()=>{
 const key=randomUUID(),results=await concurrentOrders([key,key]);assert(results.every(r=>r.id===results[0].id));assert.equal(results.filter(r=>r.replayed).length,1);assert.equal(held('HAT-LINE-1'),1);assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,1);
});

test('mixed-category orders use the price and reservation of each individual SKU',async()=>{
 const body=checkout('HAT-LINE-BLACK-58',2);
 body.items.push(checkout('SHAMPOO-SATIN-2').items[0],checkout('SPONGES-5',2).items[0],checkout('SWEETS-250').items[0]);
 const order=await create(body);assert.equal(order.subtotalCents,18290);assert.equal(order.totalCents,19090);assert.equal((await detail(order.id)).items.length,4);
 assert.equal(held('HAT-LINE-BLACK-58'),2);assert.equal(held('SPONGES-5'),2);await transition(order.id,'cancelled');
 for(const item of body.items)assert.equal(held(item.sku),0);
});
test('admin order pagination clamps the page and searches Russian names without case sensitivity',async()=>{
 app.store.db.prepare('UPDATE variants SET stock=40 WHERE sku=?').run('SPONGES-5');
 for(let i=0;i<26;i++)app.store.orders.create(checkout('SPONGES-5'),randomUUID(),'pagination-'+i);
 const first=await call('/api/admin/orders',{privateRequest:true});assert.equal(first.data.total,26);assert.equal(first.data.orders.length,25);assert.equal(first.data.pages,2);
 const last=await call('/api/admin/orders?page=999',{privateRequest:true});assert.equal(last.data.page,2);assert.equal(last.data.orders.length,1);
 const found=await call('/api/admin/orders?q='+encodeURIComponent('тестовый'),{privateRequest:true});assert.equal(found.data.total,26);
});

test('migration from the previous product-only database preserves products and admin access',async()=>{
 const before=app.store.products().map(p=>({id:p.id,name:p.name,stock:p.variants.map(v=>v.stock)}));
 app.store.db.exec('DROP TABLE reservations; DROP TABLE order_items; DROP TABLE order_events; DROP TABLE order_limits; DROP TABLE orders; DELETE FROM migrations WHERE version=2;');
 await new Promise(resolve=>app.server.close(resolve));app.store.close();app=createApp({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
 assert.deepEqual(app.store.products().map(p=>({id:p.id,name:p.name,stock:p.variants.map(v=>v.stock)})),before);
 assert.equal((await call('/api/admin/session',{privateRequest:true})).status,200);assert.equal((await call('/api/admin/orders',{privateRequest:true})).data.total,0);assert.equal((await create()).status,'new');
});
