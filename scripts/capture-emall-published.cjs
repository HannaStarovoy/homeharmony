// Verify the authorized publication in a disposable shop, without accounts or orders.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const draftBundleDir=path.join(root,'data/emall-drafts');
const publicationPlanPath=path.join(root,'data/emall-publication.json');
const debugPath='/tmp/emall-published-capture-debug.png';
let instance,browser,page,temporaryDirectory,stage='READ_BUNDLE';
const check=(condition,code)=>{if(!condition)throw new Error(code)};
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const photos=product=>[...new Set([...(product.images||[]),...product.variants.flatMap(v=>v.images||[])])];

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
   current.server.closeIdleConnections();current.server.closeAllConnections();
  });
 }finally{current.store.close()}
}
function verifyPublished(manifest){
 const {store}=instance,scope=[manifest.source.provider,manifest.source.environment,manifest.source.account];
 const managed=store.products().filter(p=>p.variants.some(v=>v.sourceManaged));
 check(managed.length===5&&managed.every(p=>p.status==='published'),'EXPECTED_FIVE_PUBLISHED_SOURCE_PRODUCTS');
 const links=store.db.prepare('SELECT external_id,product_id FROM import_products WHERE provider=? AND environment=? AND account=?').all(...scope);
 check(links.length===5,'EXPECTED_FIVE_SOURCE_LINKS');
 const result=[];
 for(const expected of manifest.products){
  const actual=managed.find(p=>p.id===links.find(link=>link.external_id===expected.externalId)?.product_id);
  check(actual&&actual.name===expected.name,'PUBLISHED_NAME_MISMATCH');
  check(same(actual.images,expected.images||[]),'PUBLISHED_PHOTOS_MISMATCH');
  check(actual.variants.length===expected.variants.length,'PUBLISHED_VARIANT_COUNT_MISMATCH');
  for(const variant of expected.variants){
   const link=store.db.prepare('SELECT sku FROM import_variants WHERE provider=? AND environment=? AND account=? AND external_product_id=? AND external_id=?').get(...scope,expected.externalId,variant.externalId);
   const actualVariant=actual.variants.find(v=>v.sku===link?.sku);
   check(actualVariant&&Math.round(actualVariant.price*100)===Math.round(variant.price*100),'PUBLISHED_PRICE_MISMATCH');
   check(actualVariant.stock===variant.stock,'PUBLISHED_STOCK_MISMATCH');
  }
  check(photos(actual).length>0,'PUBLISHED_PRODUCT_HAS_NO_PHOTOS');result.push(actual);
 }
 check(new Set(result.map(p=>p.id)).size===5,'PUBLISHED_PRODUCTS_NOT_DISTINCT');
 check(store.products(true).length===19,'PUBLISHED_CATALOG_COUNT_MISMATCH');
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
 // Each probe closes its own socket, so a restart cannot reuse an HTTP client
 // connection belonging to the previous server instance on the same port.
 const requestOptions=()=>({signal:AbortSignal.timeout(10000),headers:{Connection:'close'}});
 const response=await fetch(base+'/api/catalog',requestOptions());
 check(response.status===200,'PUBLIC_CATALOG_UNAVAILABLE');
 const catalog=await response.json();check(catalog.products?.length===19,'PUBLIC_CATALOG_COUNT_MISMATCH');
 for(const expected of products){
  const actual=catalog.products.find(p=>p.id===expected.id);
  check(actual&&actual.name===expected.name&&same(actual.images,expected.images),'PUBLISHED_PRODUCT_MISSING_FROM_PUBLIC_CATALOG');
  check(actual.variants.every((v,i)=>Math.round(v.price*100)===Math.round(expected.variants[i].price*100)),'PUBLIC_PRICE_MISMATCH');
 }
 for(const url of urls){
  const response=await fetch(base+url,requestOptions());
  check(response.status===200&&response.headers.get('content-type')?.startsWith('image/webp'),'PUBLIC_PHOTO_UNAVAILABLE');
  check((await response.arrayBuffer()).byteLength>0,'PUBLIC_PHOTO_EMPTY');
 }
}
async function waitForPhotos(){
 await page.locator('img').evaluateAll(async images=>{
  for(const image of images)image.loading='eager';
  await Promise.all(images.map(image=>image.decode()));
  if(images.some(image=>!image.complete||!image.naturalWidth))throw new Error('Image did not decode');
 });
}
async function capture(filename,{fullPage=false}={}){
 const destination=path.join(root,filename);await page.screenshot({path:destination,fullPage});
 check((await fs.readFile(destination)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'INVALID_SCREENSHOT');
}

(async()=>{
 const manifest=JSON.parse(await fs.readFile(path.join(draftBundleDir,'manifest.json'),'utf8'));
 check(manifest.products?.length===5,'EXPECTED_FIVE_MANIFEST_PRODUCTS');
 const urls=[...new Set(manifest.products.flatMap(photos))];
 check(urls.length===13&&urls.every(url=>/^\/uploads\/emall-[a-f0-9]{64}\.webp$/.test(url)),'INVALID_MANIFEST_PHOTOS');
 const {createApp}=await import('../server/app.mjs');
 temporaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'homeharmony-emall-published-'));
 const appOptions={dataDir:temporaryDirectory,draftBundleDir,publicationPlanPath,origin:null,secureCookies:false,reserveHours:24};
 stage='PUBLISH_IN_TEMPORARY_SHOP';instance=createApp(appOptions);
 let products=verifyPublished(manifest);const originalIdentity=identitySnapshot();
 let base=await listen();stage='PUBLIC_API';await verifyPublic(base,products,urls);
 stage='BROWSER';browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1500},deviceScaleFactor:1});
 let pageErrors=0,blockedRequests=0;
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin===base&&['GET','HEAD'].includes(request.method()))return route.continue();
  blockedRequests++;return route.abort();
 });
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>pageErrors++);
 stage='PUBLIC_CATALOG';await page.goto(base+'/?view=catalog&sort=new&size=24',{waitUntil:'networkidle'});
 await page.locator('.catalog-results .product-card').last().waitFor();
 check(await page.locator('.catalog-results .product-card').count()===19,'CATALOG_BROWSER_COUNT_MISMATCH');
 const firstFive=await page.locator('.catalog-results .product-visual').evaluateAll(elements=>elements.slice(0,5).map(element=>element.dataset.product));
 check(firstFive.length===5&&products.every(p=>firstFive.includes(p.id)),'PUBLISHED_PRODUCTS_NOT_FIRST_IN_NEW_CATALOG');
 for(const product of products){
  const visual=page.locator('.catalog-results .product-visual[data-product="'+product.id+'"]');
  check(await visual.count()===1&&await visual.locator('img').count()===1,'PUBLISHED_CARD_PHOTO_MISSING');
 }
 await waitForPhotos();check(pageErrors===0&&blockedRequests===0,'CATALOG_BROWSER_ERROR');
 await capture('preview_emall_published.png');
 stage='PUBLIC_PRODUCT';await page.goto(base+'/?view=product&product='+products[0].id,{waitUntil:'networkidle'});
 check(await page.locator('.detail-info h1').textContent()===products[0].name,'PRODUCT_BROWSER_NAME_MISMATCH');
 check(await page.locator('.detail-main-img img').count()===1,'PRODUCT_BROWSER_PHOTO_MISSING');
 check(await page.locator('.buy-row [data-add]').isEnabled(),'PUBLISHED_PRODUCT_CANNOT_BE_ADDED_TO_CART');
 await waitForPhotos();check(pageErrors===0&&blockedRequests===0,'PRODUCT_BROWSER_ERROR');
 await capture('preview_emall_published_product.png',{fullPage:true});
 stage='RESTART_CLOSE';const port=instance.server.address().port;
 await closeInstance();stage='RESTART_OPEN';instance=createApp(appOptions);
 stage='RESTART_LISTEN';base=await listen(port);
 stage='RESTART_STORE';products=verifyPublished(manifest);check(same(identitySnapshot(),originalIdentity),'RESTART_CHANGED_PUBLICATION');
 stage='RESTART_API';await verifyPublic(base,products,urls);
 console.log(JSON.stringify({verifiedPublished:products.length,verifiedPhotos:urls.length,publicCatalog:19,screenshots:2,verifiedRestarts:1}));
})().catch(async error=>{
 if(page&&!page.isClosed())await page.screenshot({path:debugPath,fullPage:true,timeout:5000}).catch(()=>{});
 console.error(JSON.stringify({error:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'CAPTURE_FAILED',stage,cause:typeof error.cause?.code==='string'&&/^[A-Z0-9_]+$/.test(error.cause.code)?error.cause.code:null,debugScreenshot:page?debugPath:null}));process.exitCode=1;
}).finally(async()=>{
 const results=await Promise.allSettled([browser?.close(),closeInstance()]);
 if(temporaryDirectory)try{await fs.rm(temporaryDirectory,{recursive:true,force:true})}catch{results.push({status:'rejected'})}
 if(results.some(result=>result.status==='rejected')){console.error(JSON.stringify({error:'CAPTURE_CLEANUP_FAILED'}));process.exitCode=1}
});
