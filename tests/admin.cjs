// Full admin -> SQLite -> public storefront workflow. Uses only temporary test data.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');
(async()=>{
 const {createApp}=await import('../server/app.mjs'),{createAdmin}=await import('../server/auth.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'homeharmony-admin-'));
 let instance=createApp({dataDir:dir});
 const password=crypto.randomBytes(24).toString('base64url');await createAdmin(instance.store,'owner@example.test',password);
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));
 const port=instance.server.address().port,base='http://127.0.0.1:'+port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 let debugPage;
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),publicPage=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
  debugPage=page;
  for(const p of [page,publicPage]){p.on('pageerror',error=>errors.push(error.message));p.on('dialog',dialog=>dialog.accept())}
  await page.goto(base+'/admin');
  await page.getByLabel('Email',{exact:true}).fill('owner@example.test');await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();
  await page.getByRole('button',{name:'+ Добавить товар',exact:true}).click();
  await page.getByRole('textbox',{name:'Название *',exact:true}).fill('Тестовый шампунь');
  await page.locator('#editor-category').selectOption('shampoos');
  await page.getByRole('textbox',{name:'Описание',exact:true}).fill('Товар создан через административную панель.');
  await page.getByRole('textbox',{name:'Значение характеристики 1',exact:true}).fill('Мягкое очищение');
  await page.getByLabel('Новый параметр варианта',{exact:true}).fill('Объём');await page.getByRole('button',{name:'Добавить параметр',exact:true}).click();
  await page.getByRole('textbox',{name:'Артикул варианта 1',exact:true}).fill('ADMIN-SHAMPOO-250');
  await page.getByRole('spinbutton',{name:'Цена варианта 1',exact:true}).fill('12.5');await page.getByRole('spinbutton',{name:'Остаток варианта 1',exact:true}).fill('7');
  await page.getByRole('textbox',{name:'Объём варианта 1',exact:true}).fill('250 мл');
  await page.getByRole('button',{name:'+ Добавить вариант',exact:true}).click();
  await page.getByRole('textbox',{name:'Артикул варианта 2',exact:true}).fill('ADMIN-SHAMPOO-500');
  await page.getByRole('spinbutton',{name:'Цена варианта 2',exact:true}).fill('21');await page.getByRole('spinbutton',{name:'Остаток варианта 2',exact:true}).fill('2');
  await page.getByRole('textbox',{name:'Объём варианта 2',exact:true}).fill('500 мл');
  const red=await sharp({create:{width:500,height:600,channels:3,background:'#d08680'}}).png().toBuffer();
  const blue=await sharp({create:{width:500,height:600,channels:3,background:'#80a9d0'}}).png().toBuffer();
  await page.locator('[data-upload="product"]').setInputFiles({name:'product.png',mimeType:'image/png',buffer:red});
  await page.locator('.editor-main > .panel').nth(1).locator('.photo img').waitFor();
  await page.locator('.variant').nth(1).locator('summary').click();
  await page.locator('[data-upload="1"]').setInputFiles({name:'variant.png',mimeType:'image/png',buffer:blue});
  await page.locator('.variant').nth(1).locator('.photo img').waitFor();
  await page.getByRole('button',{name:'Сохранить черновик',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Черновик сохранён'}).waitFor();
  let saved=instance.store.products().find(p=>p.name==='Тестовый шампунь');assert(saved);assert.equal(saved.status,'draft');assert.equal(saved.variants.length,2);
  assert(!(await (await fetch(base+'/api/catalog')).json()).products.some(p=>p.id===saved.id));
  assert.equal((await fetch(base+saved.images[0])).status,404);
  // A duplicate combination is rejected without losing entered form values.
  await page.getByRole('textbox',{name:'Объём варианта 2',exact:true}).fill('250 мл');
  await page.getByRole('button',{name:'Опубликовать товар',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/Сочетания/);
  await page.getByRole('textbox',{name:'Объём варианта 2',exact:true}).fill('500 мл');
  await page.getByRole('button',{name:'Опубликовать товар',exact:true}).click();await page.getByRole('status').filter({hasText:'доступен на витрине'}).waitFor();
  saved=instance.store.products().find(p=>p.id===saved.id);assert.equal(saved.status,'published');
  await publicPage.goto(base+'/?view=catalog&cat=shampoos&q='+encodeURIComponent('Тестовый шампунь'));
  assert.equal(await publicPage.locator('.catalog-results .product-card').count(),1);
  await publicPage.locator('.catalog-results [data-product]').first().click();
  assert.match(await publicPage.locator('.detail-price').innerText(),/12,5 BYN/);
  const main=publicPage.locator('.detail-main-img img');await main.waitFor();assert(await main.evaluate(img=>img.complete&&img.naturalWidth>0));const firstSrc=await main.getAttribute('src');
  await publicPage.locator('[data-option="Объём"][data-value="500 мл"]').click();assert.match(await publicPage.locator('.detail-price').innerText(),/21 BYN/);assert.notEqual(await main.getAttribute('src'),firstSrc);
  await publicPage.locator('.buy-row [data-add]').click();await publicPage.locator('.header-icons [data-go="cart"]').click();assert.match(await publicPage.locator('.cart-item').innerText(),/ADMIN-SHAMPOO-500/);assert.match(await publicPage.locator('.summary-line.total').innerText(),/21 BYN/);
  assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  // Changes survive an actual restart, and the admin session remains valid.
  await new Promise(resolve=>instance.server.close(resolve));instance.store.close();instance=createApp({dataDir:dir});await new Promise(resolve=>instance.server.listen(port,'127.0.0.1',resolve));
  await page.goto(base+'/admin');await page.getByRole('searchbox',{name:'Поиск товаров',exact:true}).fill('Тестовый шампунь');
  await page.getByRole('button',{name:'Редактировать',exact:true}).click();
  await page.getByRole('spinbutton',{name:'Цена варианта 2',exact:true}).fill('22.9');
  await page.getByRole('button',{name:'Сохранить на витрине',exact:true}).click();await page.getByRole('status').filter({hasText:'доступен на витрине'}).waitFor();
  await publicPage.goto(base+'/?view=product&product='+saved.id+'&sku=ADMIN-SHAMPOO-500');assert.match(await publicPage.locator('.detail-price').innerText(),/22,9 BYN/);
  await publicPage.screenshot({path:'/tmp/admin-product-mobile.png',fullPage:true});
  await page.screenshot({path:'/tmp/admin-editor-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'/tmp/admin-editor-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Сохранить и скрыть',exact:true}).click();await page.getByRole('status').filter({hasText:'Черновик сохранён'}).waitFor();
  await publicPage.reload();assert.equal(await publicPage.locator('.detail').count(),0);assert.equal((await fetch(base+saved.images[0])).status,404);
  await page.getByRole('button',{name:'Выйти',exact:true}).click();await page.getByRole('heading',{name:'Вход в панель'}).waitFor();
  // With an empty public catalog the homepage remains usable.
  for(const p of instance.store.products())instance.store.saveProduct({...p,status:'draft'},p.id);
  await publicPage.goto(base+'/');assert.equal(await publicPage.locator('.value-home').count(),1);
  assert.deepEqual(errors,[]);console.log('PASS: admin login, create with SKU/photos, draft isolation, publication, storefront/cart, restart/edit/hide/logout, mobile and empty catalog');
 }catch(error){await debugPage?.screenshot({path:'/tmp/admin-debug.png',fullPage:true}).catch(()=>{});throw error}finally{await browser.close();await new Promise(resolve=>instance.server.close(resolve));instance.store.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
