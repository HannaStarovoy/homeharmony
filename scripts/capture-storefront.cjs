// Capture the actual application with an isolated demo database.
const {chromium}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
(async()=>{
 const {createApp}=await import('../server/app.mjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'storefront-preview-'));
 const {server,store}=createApp({dataDir:dir});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const [width,height,name] of [[1440,1100,'desktop'],[390,1000,'mobile']]){
   await page.setViewportSize({width,height});await page.goto(base+'/',{waitUntil:'networkidle'});await page.locator('.hero-art img').evaluate(img=>img.decode());
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow at '+width);
   await page.screenshot({path:path.join(__dirname,'../preview_'+name+'.png')});
  }
  for(const [route,name] of [['/?view=catalog','catalog'],['/?view=product&product=hat-line','product'],['/?view=cart','cart']]){
   if(name==='cart')await page.evaluate(()=>localStorage.setItem('store-demo-cart',JSON.stringify([{id:'hat-line',sku:'HAT-LINE-1',qty:1},{id:'sponges-dish',sku:'SPONGES-5',qty:2}])));
   await page.setViewportSize({width:1440,height:1050});await page.goto(base+route,{waitUntil:'networkidle'});await page.screenshot({path:'/tmp/design-'+name+'-desktop.png',fullPage:true});if(name==='catalog')await fs.copyFile('/tmp/design-catalog-desktop.png',path.join(__dirname,'../preview_catalog.png'));
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/design-'+name+'-mobile.png',fullPage:true});
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Horizontal overflow on '+name);
  }
  for(const width of [320,360,414,768,1024,1280]){await page.setViewportSize({width,height:900});await page.goto(base+'/',{waitUntil:'networkidle'});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Home overflow at '+width)}
  if(errors.length)throw new Error(errors.join('\n'));console.log('Previews captured: home desktop/mobile; catalog, product and cart inspected.');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exit(1)});
