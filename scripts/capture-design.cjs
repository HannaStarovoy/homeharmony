// Review actual catalog layouts with disposable data and a synthetic admin account.
const {chromium}=require('playwright'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomBytes}=require('node:crypto');
(async()=>{
 const root=path.resolve(__dirname,'..'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'homeharmony-design-'));
 let app,browser,stage='START';
 try{
  const [{createApp},{createAdmin}]=await Promise.all([import('../server/app.mjs'),import('../server/auth.mjs')]);
  app=createApp({dataDir:directory,draftBundleDir:path.join(root,'data/emall-drafts'),massBundleDir:path.join(root,'data/emall-mass'),publicationPlanPath:path.join(root,'data/emall-publication.json'),origin:null,secureCookies:false});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  const password=randomBytes(32).toString('base64url');await createAdmin(app.store,'owner@example.test',password);
  const scope=['emall','production','homeharmony-emall-main'];
  const link=app.store.db.prepare('SELECT product_id FROM import_products WHERE provider=? AND environment=? AND account=? AND external_id=?').get(...scope,'9366858');
  const product=app.store.products().find(p=>p.id===link.product_id);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];let blocked=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(u.origin===base&&(['GET','HEAD'].includes(r.method())||(r.method()==='POST'&&u.pathname==='/api/admin/login')))return route.continue();blocked++;return route.abort()});
  async function images(){await page.locator('img').evaluateAll(async list=>{list.forEach(img=>img.loading='eager');await Promise.all(list.map(img=>img.decode()));if(list.some(img=>img.naturalWidth===0))throw Error('IMAGE_MISSING')})}
  async function capture(name){await images();await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo({top:0,behavior:'instant'})});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(root,name),fullPage:false})}
  const measures=[];
  for(const width of [320,390,768,1024,1440]){
   await page.setViewportSize({width,height:width===1440?1100:1000});
   const routes=[['/','home'],['/?view=catalog&sort=new','catalog'],['/?view=product&product='+product.id,'product'],['/?view=cart','cart'],['/?view=checkout','checkout']];
   await page.goto(base+'/',{waitUntil:'networkidle'});
   await page.evaluate(item=>localStorage.setItem('store-demo-cart',JSON.stringify([item])),{id:product.id,sku:product.variants[0].sku,qty:1});
   for(const [route,name] of routes){
    stage=name+'-'+width;if(name==='home')await page.evaluate(()=>localStorage.removeItem('store-demo-cart'));else await page.evaluate(item=>localStorage.setItem('store-demo-cart',JSON.stringify([item])),{id:product.id,sku:product.variants[0].sku,qty:1});await page.goto(base+route,{waitUntil:'networkidle'});await images();
    if(name==='cart'&&await page.locator('.cart-item').count()!==1)throw Error('CART_CAPTURE_EMPTY');
    if(name==='checkout'&&await page.locator('#checkout-form').count()!==1)throw Error('CHECKOUT_CAPTURE_EMPTY');
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('OVERFLOW_'+stage);
    if(width===1440||width===390){
     const suffix=width===1440?'desktop':'mobile';await capture('preview_design_'+name+'_'+suffix+'.png');
     if(name==='home')await capture('preview_'+suffix+'.png');
     if(name==='catalog'&&width===1440)await capture('preview_catalog.png');
     const readings=await page.evaluate(()=>Object.fromEntries(['.product-name','.price','.quick-add button','.header-search input','.page-intro','.detail-info h1'].map(s=>{const el=document.querySelector(s);return [s,el?getComputedStyle(el).fontSize:null]})));measures.push({width,screen:name,fonts:readings});
    }
   }
  }
  await page.setViewportSize({width:1440,height:1100});stage='ADMIN_LOGIN';await page.goto(base+'/admin',{waitUntil:'networkidle'});await capture('preview_design_admin_login.png');
  await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.locator('#status-filter').waitFor();
  await page.locator('#status-filter').selectOption('draft');
  const boxes=page.locator('[data-select-product]');for(let i=0;i<Math.min(3,await boxes.count());i++)await page.locator('[data-select-product]').nth(i).check();
  stage='ADMIN_LIST';await capture('preview_design_admin_desktop.png');
  for(const width of [320,390,768,1024,1440]){await page.setViewportSize({width,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('ADMIN_OVERFLOW_'+width);if(width===390)await capture('preview_design_admin_mobile.png')}
  await page.setViewportSize({width:1440,height:1100});await page.locator('#status-filter').selectOption('all');await page.locator('[data-edit="'+product.id+'"]').click();await page.locator('#product-form').waitFor();stage='ADMIN_EDITOR';await capture('preview_design_editor_desktop.png');
  for(const width of [320,390,768,1024,1440]){await page.setViewportSize({width,height:1000});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('EDITOR_OVERFLOW_'+width);if(width===390)await capture('preview_design_editor_mobile.png')}
  if(errors.length||blocked)throw Error('BROWSER_ERRORS');
  console.log(JSON.stringify({reviewedViewports:5,storefrontScreens:5,adminScreens:3,sourceProducts:app.store.products().filter(p=>p.variants.some(v=>v.sourceManaged)).length,browserErrors:0,productWrites:0,measures}));
 }catch(e){console.error(JSON.stringify({error:e.message,stage}));throw e}
 finally{await browser?.close();if(app){if(app.server.listening)await new Promise(r=>app.server.close(r));app.store.close()}await fs.rm(directory,{recursive:true,force:true})}
})().catch(()=>process.exitCode=1);
