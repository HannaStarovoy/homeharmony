// Verify and capture the real draft bundle using a disposable local shop database.
// This script never saves products, publishes drafts, or contacts Emall.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {randomBytes}=require('node:crypto');

const root=path.resolve(__dirname,'..'),draftBundleDir=path.join(root,'data/emall-drafts');
const debugPath='/tmp/emall-capture-debug.png';
let instance,browser,page,temporaryDirectory,stage='READ_BUNDLE';
function check(condition,code){if(!condition)throw new Error(code)}
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const photos=product=>[...new Set([...(product.images||[]),...product.variants.flatMap(v=>v.images||[])])];
const sourceManaged=product=>product.variants.some(v=>v.sourceManaged);

async function listen(port=0){
 await new Promise((resolve,reject)=>{
  instance.server.once('error',reject);
  instance.server.listen(port,'127.0.0.1',()=>{instance.server.off('error',reject);resolve()});
 });
 return 'http://127.0.0.1:'+instance.server.address().port;
}
async function closeInstance(){
 if(!instance)return;
 const current=instance;instance=null;
 try{
  if(current.server.listening)await new Promise((resolve,reject)=>{
   current.server.close(error=>error?reject(error):resolve());
   current.server.closeIdleConnections();
   current.server.closeAllConnections();
  });
 }finally{current.store.close()}
}
function verifyImported(manifest){
 const {store}=instance,scope=[manifest.source.provider,manifest.source.environment,manifest.source.account];
 const products=store.products(),managed=products.filter(sourceManaged);
 check(managed.length===5&&managed.every(p=>p.status==='draft'),'EXPECTED_FIVE_SOURCE_MANAGED_DRAFTS');
 const links=store.db.prepare('SELECT external_id,product_id FROM import_products WHERE provider=? AND environment=? AND account=? ORDER BY external_id').all(...scope);
 check(links.length===5,'EXPECTED_FIVE_IMPORT_LINKS');
 const byExternalId=new Map(links.map(link=>[link.external_id,link.product_id]));
 const result=[];
 for(const expected of manifest.products){
  const actual=managed.find(p=>p.id===byExternalId.get(expected.externalId));
  check(actual&&actual.name===expected.name,'IMPORTED_NAME_MISMATCH');
  check(same(actual.images,expected.images||[]),'IMPORTED_PRODUCT_PHOTOS_MISMATCH');
  check(actual.variants.length===expected.variants.length,'IMPORTED_VARIANT_COUNT_MISMATCH');
  for(const variant of expected.variants){
   const link=store.db.prepare('SELECT sku FROM import_variants WHERE provider=? AND environment=? AND account=? AND external_product_id=? AND external_id=?').get(...scope,expected.externalId,variant.externalId);
   const actualVariant=actual.variants.find(v=>v.sku===link?.sku);
   check(actualVariant?.sourceManaged,'IMPORTED_VARIANT_LINK_MISSING');
   const cents=store.db.prepare('SELECT price_cents FROM variants WHERE sku=?').get(link.sku)?.price_cents;
   check(cents===Math.round(variant.price*100)&&Math.round(actualVariant.price*100)===cents,'IMPORTED_PRICE_CENTS_MISMATCH');
   check(same(actualVariant.images,variant.images||[]),'IMPORTED_VARIANT_PHOTOS_MISMATCH');
  }
  check(photos(actual).length>0,'IMPORTED_PRODUCT_HAS_NO_PHOTOS');
  result.push(actual);
 }
 check(new Set(result.map(p=>p.id)).size===5,'IMPORTED_PRODUCTS_NOT_DISTINCT');
 return result;
}
function identitySnapshot(){
 return {
  products:instance.store.db.prepare('SELECT external_id,product_id FROM import_products ORDER BY external_id').all(),
  variants:instance.store.db.prepare('SELECT external_product_id,external_id,sku FROM import_variants ORDER BY external_product_id,external_id').all(),
  statuses:instance.store.db.prepare('SELECT id,status,version FROM products ORDER BY id').all(),
  runs:instance.store.db.prepare('SELECT count(*) AS n FROM import_runs').get().n
 };
}
async function verifyPublic(base,products,urls){
 const response=await fetch(base+'/api/catalog',{signal:AbortSignal.timeout(10000)});
 check(response.status===200,'PUBLIC_CATALOG_UNAVAILABLE');
 const catalog=await response.json(),ids=new Set(products.map(p=>p.id));
 check(Array.isArray(catalog.products)&&!catalog.products.some(p=>ids.has(p.id)||sourceManaged(p)),'DRAFT_EXPOSED_IN_PUBLIC_CATALOG');
 for(const url of urls){
  const response=await fetch(base+url,{signal:AbortSignal.timeout(10000)});
  check(response.status===404,'DRAFT_PHOTO_EXPOSED_PUBLICLY');
  await response.arrayBuffer();
 }
}
async function verifyAuthenticatedPhotos(base,urls){
 for(const url of urls){
  const response=await page.request.get(base+url,{timeout:10000});
  check(response.status()===200&&response.headers()['content-type']?.startsWith('image/webp'),'ADMIN_PHOTO_UNAVAILABLE');
  check((await response.body()).length>0,'ADMIN_PHOTO_EMPTY');
  await response.dispose();
 }
}
async function waitForPhotos(){
 await page.locator('img').evaluateAll(async images=>{
  await Promise.all(images.map(image=>image.decode()));
  if(images.some(image=>!image.complete||image.naturalWidth===0))throw new Error('Image did not decode');
 });
}
async function capture(file){
 const destination=path.join(root,file);
 await page.screenshot({path:destination,fullPage:true});
 const bytes=await fs.readFile(destination);
 check(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'SCREENSHOT_IS_NOT_PNG');
}

(async()=>{
 let manifest;
 try{manifest=JSON.parse(await fs.readFile(path.join(draftBundleDir,'manifest.json'),'utf8'))}
 catch(error){throw new Error(error.code==='ENOENT'?'DRAFT_BUNDLE_MISSING':'DRAFT_BUNDLE_UNREADABLE')}
 check(Array.isArray(manifest.products)&&manifest.products.length===5,'MANIFEST_MUST_CONTAIN_FIVE_PRODUCTS');
 const urls=[...new Set(manifest.products.flatMap(photos))];
 check(urls.length>0&&urls.every(url=>/^\/uploads\/emall-[a-f0-9]{64}\.webp$/.test(url)),'MANIFEST_PHOTO_URL_INVALID');
 const [{createApp},{createAdmin}]=await Promise.all([import('../server/app.mjs'),import('../server/auth.mjs')]);
 temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'homeharmony-emall-preview-'));
 const appOptions={dataDir:temporaryDirectory,draftBundleDir,origin:null,secureCookies:false,reserveHours:24};
 stage='IMPORT_BUNDLE';instance=createApp(appOptions);
 let products=verifyImported(manifest);
 const originalIdentity=identitySnapshot();
 const password=randomBytes(32).toString('base64url');
 await createAdmin(instance.store,'owner@example.test',password);
 let base=await listen();
 stage='PUBLIC_VISIBILITY';await verifyPublic(base,products,urls);
 stage='LAUNCH_CHROMIUM';
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1});
 let pageErrors=0,blockedRequests=0;
 // Restrict the browser to this loopback server and prohibit product writes.
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===base&&(['GET','HEAD'].includes(request.method())||(request.method()==='POST'&&url.pathname==='/api/admin/login')))return route.continue();
  blockedRequests++;return route.abort();
 });
 page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',()=>pageErrors++);
 stage='ADMIN_LOGIN';await page.goto(base+'/admin',{waitUntil:'networkidle'});
 await page.getByLabel('Email',{exact:true}).fill('owner@example.test');
 await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.locator('#status-filter').waitFor();
 stage='DRAFT_LIST';await page.locator('#status-filter').selectOption('draft');
 await page.waitForFunction(()=>document.querySelectorAll('table.list tbody tr').length===5);
 const rows=page.locator('table.list tbody tr');
 check(await rows.count()===5,'ADMIN_DRAFT_ROW_COUNT_MISMATCH');
 for(const product of products){
  const edit=page.locator('[data-edit="'+product.id+'"]');
  check(await edit.count()===1,'IMPORTED_DRAFT_MISSING_FROM_LIST');
  check(await edit.locator('xpath=ancestor::tr').locator('.item-name strong').textContent()===product.name,'ADMIN_DRAFT_NAME_MISMATCH');
 }
 await verifyAuthenticatedPhotos(base,urls);await waitForPhotos();
 check(pageErrors===0&&blockedRequests===0,'ADMIN_LIST_BROWSER_ERROR');
 await capture('preview_emall_drafts.png');
 stage='PRODUCT_EDITOR';
 await page.locator('[data-edit="'+products[0].id+'"]').click();
 await page.locator('#product-form').waitFor();
 check(await page.locator('[name="name"]').inputValue()===manifest.products[0].name,'EDITOR_NAME_MISMATCH');
 for(let i=0;i<products[0].variants.length;i++){
  const price=await page.locator('[data-variant-field="price"][data-index="'+i+'"]').inputValue();
  check(Math.round(Number(price)*100)===Math.round(manifest.products[0].variants[i].price*100),'EDITOR_PRICE_CENTS_MISMATCH');
  if(products[0].variants[i].images.length)await page.locator('[data-variant-photos="'+i+'"] > summary').click();
 }
 check(await page.locator('.photo img').count()>0,'EDITOR_PHOTOS_MISSING');
 await waitForPhotos();
 check(pageErrors===0&&blockedRequests===0,'PRODUCT_EDITOR_BROWSER_ERROR');
 await capture('preview_emall_product.png');
 stage='RESTART_IDEMPOTENCY';
 const port=instance.server.address().port;
 await closeInstance();instance=createApp(appOptions);base=await listen(port);
 products=verifyImported(manifest);
 check(same(identitySnapshot(),originalIdentity),'RESTART_CHANGED_PRODUCTS_OR_IDENTITIES');
 await page.goto(base+'/admin',{waitUntil:'networkidle'});
 await page.locator('#status-filter').selectOption('draft');
 await page.waitForFunction(()=>document.querySelectorAll('table.list tbody tr').length===5);
 await verifyPublic(base,products,urls);await verifyAuthenticatedPhotos(base,urls);
 check(pageErrors===0&&blockedRequests===0,'RESTART_BROWSER_ERROR');
 console.log(JSON.stringify({verifiedDrafts:products.length,verifiedPhotos:urls.length,screenshots:2,verifiedRestarts:1,published:0}));
})().catch(async error=>{
 if(page&&!page.isClosed()){
  // A failed login must not leave even the synthetic password in a debug capture.
  if(await page.locator('input[type="password"]').count())await page.locator('input[type="password"]').fill('').catch(()=>{});
  await page.screenshot({path:debugPath,fullPage:true,timeout:5000}).catch(()=>{});
 }
 const code=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'CAPTURE_FAILED';
 console.error(JSON.stringify({error:code,stage,debugScreenshot:page?debugPath:null}));process.exitCode=1;
}).finally(async()=>{
 const results=await Promise.allSettled([browser?.close(),closeInstance()]);
 if(temporaryDirectory){try{await fs.rm(temporaryDirectory,{recursive:true,force:true})}catch{results.push({status:'rejected'})}}
 if(results.some(result=>result.status==='rejected')){console.error(JSON.stringify({error:'CAPTURE_CLEANUP_FAILED'}));process.exitCode=1}
});
