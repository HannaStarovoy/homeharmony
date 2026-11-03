import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { createAdmin, passwordHash, login } from '../server/auth.mjs';
let app,dir,base,auth={},draft,image;
const password=randomBytes(24).toString('base64url');
async function request(path,{method='GET',body,headers={},authenticated=true}={}){
 const response=await fetch(base+path,{method,headers:{...(authenticated?auth:{}),...(method!=='GET'?{Origin:base}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json(),headers:response.headers};
}
function product(sku='API-TEST-1') {return {name:'Тестовый товар',cat:'creams',summary:'Описание <script>не исполняется</script>',attrs:{Назначение:'Уход'},images:[],status:'draft',variants:[{sku,price:12.5,old:15,stock:7,color:'#c0ffee',options:{Объём:'50 мл'},images:[]}]}}
async function signIn(){const result=await request('/api/admin/login',{method:'POST',authenticated:false,body:{email:'owner@example.test',password}});assert.equal(result.status,200);auth={Cookie:result.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':result.data.csrf};return result}
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'homeharmony-api-'));app=createApp({dataDir:dir});
 await createAdmin(app.store,'owner@example.test',password);
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
});
after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.store.close();await rm(dir,{recursive:true,force:true})});
test('public catalog is seeded once and contains only storefront fields',async()=>{
 const result=await request('/api/catalog',{authenticated:false});assert.equal(result.status,200);assert.equal(result.data.products.length,14);
 assert(!Object.hasOwn(result.data.products[0],'version'));assert(!Object.hasOwn(result.data.products[0],'status'));
 for(const path of ['/server/store.mjs','/.env.local','/var/shop.sqlite','/package.json'])assert.equal((await request(path,{authenticated:false})).status,404);
});
test('admin writes and private catalog require authentication',async()=>{
 assert.equal((await request('/api/admin/catalog',{authenticated:false})).status,401);
 assert.equal((await request('/api/admin/products',{method:'POST',body:product(),authenticated:false})).status,401);
 const bad=await request('/api/admin/login',{method:'POST',authenticated:false,body:{email:'owner@example.test',password:'wrong'}});assert.equal(bad.status,401);
});
test('login uses HttpOnly SameSite cookies; writes enforce origin and CSRF',async()=>{
 const result=await signIn();assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Strict/);
 assert.equal((await request('/api/admin/products',{method:'POST',body:product(),headers:{'X-CSRF-Token':'wrong'}})).status,403);
 assert.equal((await request('/api/admin/products',{method:'POST',body:product(),headers:{Origin:'https://other.example'}})).status,403);
 const status=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/catalog',{headers:{Host:'other.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});assert.equal(status,403);
});
test('draft creation persists products and separate SKU rows without exposing drafts publicly',async()=>{
 const result=await request('/api/admin/products',{method:'POST',body:product()});assert.equal(result.status,201);draft=result.data;
 assert.equal(draft.version,1);assert.equal(draft.variants[0].price,12.5);assert.equal(app.store.db.prepare('SELECT stock FROM variants WHERE sku=?').get('API-TEST-1').stock,7);
 assert(!(await request('/api/catalog',{authenticated:false})).data.products.some(p=>p.id===draft.id));
});
test('invalid prices, stock, category, dimensions, photos and duplicate options are rejected',async()=>{
 const changes=[p=>p.cat='unknown',p=>p.variants[0].price=-1,p=>p.variants[0].price=1.999,p=>p.variants[0].stock=1.5,p=>p.images=['https://example.test/image.png'],p=>p.variants.push({...p.variants[0],sku:'SECOND'}),p=>p.variants.push({...p.variants[0],sku:'SECOND',options:{Размер:'M'}}),p=>p.variants[0].old=10,p=>{p.status='published';p.variants[0].price=0}];
 for(const change of changes){const value=product('INVALID');change(value);assert.equal((await request('/api/admin/products',{method:'POST',body:value})).status,422)}
 assert.equal(app.store.products().length,15);
});
test('global SKU uniqueness is case insensitive and rolls back the whole save',async()=>{
 assert.equal((await request('/api/admin/products',{method:'POST',body:product('api-test-1')})).status,409);
 assert.equal(app.store.products().length,15);
});
test('photos are decoded, normalized and private while used by drafts',async()=>{
 const buffer=await sharp({create:{width:40,height:30,channels:3,background:'#1769e0'}}).png().toBuffer();
 const response=await fetch(base+'/api/admin/media',{method:'POST',headers:{...auth,Origin:base,'Content-Type':'image/png'},body:buffer});assert.equal(response.status,201);image=(await response.json()).url;
 assert.equal((await fetch(base+image)).status,404);
 const photo=await fetch(base+image,{headers:auth});assert.equal(photo.status,200);assert.equal((await sharp(Buffer.from(await photo.arrayBuffer())).metadata()).format,'webp');
 const svg=await fetch(base+'/api/admin/media',{method:'POST',headers:{...auth,Origin:base},body:'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'});assert.equal(svg.status,422);
 const bad=await fetch(base+'/api/admin/media',{method:'POST',headers:{...auth,Origin:base},body:'not a photo'});assert.equal(bad.status,422);
 const saved=await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,images:[image]}});assert.equal(saved.status,200);draft=saved.data;
 assert.equal((await fetch(base+image)).status,404);
});
test('publication exposes the saved product, SKU prices and photographs',async()=>{
 const saved=await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,status:'published'}});assert.equal(saved.status,200);draft=saved.data;
 const publicProduct=(await request('/api/catalog',{authenticated:false})).data.products.find(p=>p.id===draft.id);
 assert.equal(publicProduct.variants[0].price,12.5);assert.equal(publicProduct.variants[0].old,15);assert.deepEqual(publicProduct.images,[image]);assert.equal((await fetch(base+image)).status,200);
 const data=await fetch(base+'/catalog-data.js');assert.match(await data.text(),/Тестовый товар/);
});
test('optimistic version conflicts prevent silent overwrites; invalid updates are atomic',async()=>{
 const saved=await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,name:'Новое название'}});assert.equal(saved.status,200);
 assert.equal((await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,name:'Устаревшая запись'}})).status,409);
 draft=saved.data;
 assert.equal((await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,variants:[{...draft.variants[0],sku:'HAT-LINE-1'}]}})).status,409);
 const current=(await request('/api/admin/catalog')).data.products.find(p=>p.id===draft.id);assert.equal(current.name,'Новое название');assert.equal(current.variants[0].sku,'API-TEST-1');
});
test('returning to draft removes both product and photos from public access',async()=>{
 const saved=await request('/api/admin/products/'+draft.id,{method:'PUT',body:{...draft,status:'draft'}});assert.equal(saved.status,200);draft=saved.data;
 assert(!(await request('/api/catalog',{authenticated:false})).data.products.some(p=>p.id===draft.id));assert.equal((await fetch(base+image)).status,404);
});
test('data, authentication and media survive reopening the same SQLite database',async()=>{
 await new Promise(resolve=>app.server.close(resolve));app.store.close();
 app=createApp({dataDir:dir});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.server.address().port;
 const found=(await request('/api/admin/catalog')).data.products.find(p=>p.id===draft.id);assert.equal(found.name,'Новое название');assert.equal(found.status,'draft');assert.deepEqual(found.images,[image]);assert.equal(app.store.products().length,15);
});
test('logout invalidates the server-side session; login attempts are limited',async()=>{
 assert.equal((await request('/api/admin/logout',{method:'POST',body:{}})).status,200);
 assert.equal((await request('/api/admin/catalog')).status,401);
 for(let i=0;i<10;i++)assert.equal((await request('/api/admin/login',{method:'POST',authenticated:false,body:{email:'nobody@example.test',password:'wrong'}})).status,401);
 assert.equal((await request('/api/admin/login',{method:'POST',authenticated:false,body:{email:'owner@example.test',password}})).status,429);
});

test('admin CLI provisions without logging passwords, enforces explicit reset and revokes sessions',async()=>{
 const target=await mkdtemp(join(tmpdir(),'homeharmony-cli-'));
 const args=['scripts/admin-user.mjs','--email','cli@example.test'];
 async function run(extra=[]){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[...args,...extra],{cwd:new URL('../',import.meta.url),env:{...process.env,SHOP_DATA_DIR:target,SHOP_ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,output}));
 })}
 try{
  const first=await run();assert.equal(first.code,0);assert(!first.output.includes(password));
  assert.equal((await run()).code,1);assert.equal((await run(['--reset'])).code,0);
 }finally{await rm(target,{recursive:true,force:true})}
 await createAdmin(app.store,'owner@example.test',password,{reset:true});
 app.store.db.prepare('DELETE FROM login_limits').run();await signIn();
 await createAdmin(app.store,'owner@example.test',password,{reset:true});assert.equal((await request('/api/admin/session')).status,401);
 await signIn();app.store.db.prepare('UPDATE sessions SET expires=0').run();assert.equal((await request('/api/admin/catalog')).status,401);
});

test('a password reset during verification cannot grant a session with the old password',async()=>{
 app.store.db.prepare('DELETE FROM sessions').run();
 const replacement=await passwordHash(randomBytes(24).toString('base64url'));
 const pending=login(app.store,'owner@example.test',password,'reset-race-test');
 app.store.db.prepare('UPDATE admins SET password_hash=? WHERE email=?').run(replacement,'owner@example.test');
 await assert.rejects(pending,error=>error.status===401);
 assert.equal(app.store.db.prepare('SELECT count(*) AS total FROM sessions').get().total,0);
});
