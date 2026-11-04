// Inspect an installed bulk package in a temporary shop; never edits source products.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomBytes}=require('node:crypto');
(async()=>{
 const root=path.resolve(__dirname,'..'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'emall-mass-browser-'));
 let app,browser;
 try{
  const manifest=JSON.parse(await fs.readFile(path.join(root,'data/emall-mass/manifest.json'),'utf8'));
  const [{createApp},{createAdmin}]=await Promise.all([import('../server/app.mjs'),import('../server/auth.mjs')]);
  app=createApp({dataDir:directory,draftBundleDir:path.join(root,'data/emall-drafts'),massBundleDir:path.join(root,'data/emall-mass'),publicationPlanPath:path.join(root,'data/emall-publication.json'),origin:null,secureCookies:false});
  const source=app.store.products().filter(p=>p.variants.some(v=>v.sourceManaged)),drafts=source.filter(p=>p.status==='draft');
  if(source.length!==manifest.products.length)throw Error('SOURCE_COUNT_MISMATCH');
  const password=randomBytes(32).toString('base64url');await createAdmin(app.store,'owner@example.test',password);
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1100}});let errors=0;
  page.on('pageerror',()=>errors++);await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());return u.origin===base&&(['GET','HEAD'].includes(r.method())||(r.method()==='POST'&&u.pathname==='/api/admin/login'))?route.continue():route.abort()});
  await page.goto(base+'/admin',{waitUntil:'networkidle'});await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.locator('#status-filter').selectOption('draft');await page.waitForFunction(n=>document.querySelectorAll('table.list tbody tr').length===n,drafts.length);
  await page.locator('img').evaluateAll(async images=>{await Promise.all(images.map(i=>i.decode()))});
  if(errors||await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('BROWSER_ERROR');
  await page.screenshot({path:path.join(root,'preview_emall_mass.png'),fullPage:false});
  const first=drafts[0];await page.locator('[data-edit="'+first.id+'"]').click();await page.locator('#product-form').waitFor();if(await page.locator('[name="name"]').inputValue()!==first.name)throw Error('EDITOR_MISMATCH');
  if(errors)throw Error('BROWSER_ERROR');console.log(JSON.stringify({sourceProducts:source.length,drafts:drafts.length,existingPublished:source.length-drafts.length,browserVerified:true}));
 }finally{await browser?.close();if(app){if(app.server.listening)await new Promise(r=>app.server.close(r));app.store.close()}await fs.rm(directory,{recursive:true,force:true})}
})().catch(()=>{console.error('Не удалось проверить массовый каталог в браузере.');process.exitCode=1});
