// Buyer checkout and real order handling in a temporary database; no external services.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
(async()=>{
 const {createApp}=await import('../server/app.mjs'),{createAdmin}=await import('../server/auth.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'homeharmony-order-ui-'));let instance=createApp({dataDir:dir});
 const password=crypto.randomBytes(24).toString('base64url');await createAdmin(instance.store,'owner@example.test',password);
 instance.store.db.prepare('UPDATE variants SET stock=1 WHERE sku=?').run('HAT-LINE-BLACK-58');
 await new Promise(resolve=>instance.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+instance.server.address().port;
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});let buyer,admin;
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}});buyer=await context.newPage();admin=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];
  for(const page of [buyer,admin]){page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())}
  async function fillCheckout(page){
   await page.locator('[data-go="checkout"]').click();
   await page.locator('[name="name"]').fill('Тестовый покупатель');await page.locator('[name="phone"]').fill('+375291234567');await page.locator('[name="email"]').fill('buyer@example.test');
   await page.locator('[name="city"]').fill('Минск');await page.locator('[name="address"]').fill('Тестовый адрес');await page.locator('[name="note"]').fill('<script>window.untrusted=1</script>');await page.locator('#agree').check();
  }
  async function basket(id='hat-line',sku='HAT-LINE-BLACK-58'){
   await buyer.goto(base+'/?view=product&product='+id+'&sku='+sku);await buyer.locator('.buy-row [data-add]').click();await buyer.locator('.header-icons [data-go="cart"]').click();await fillCheckout(buyer);
  }
  async function openOrder(id){await admin.goto(base+'/admin#order/'+id);await admin.getByRole('heading',{name:'Заказ № '+String(id).padStart(6,'0'),exact:true}).waitFor()}
  async function stateIs(label){await admin.locator('.editor-side .badge').filter({hasText:label}).waitFor()}
  await basket();assert.equal(await buyer.locator('[name="payment"][value="online"]').count(),0);
  await buyer.getByRole('button',{name:'Отправить заказ',exact:true}).click({clickCount:2});await buyer.locator('#order-number').waitFor();const number=await buyer.locator('#order-number').innerText();assert.equal(number,'000001');
  assert.match(await buyer.locator('.success-page').innerText(),/63 BYN/);assert.equal(instance.store.orders.reserved('HAT-LINE-BLACK-58'),1);
  assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,1);assert.deepEqual(await buyer.evaluate(()=>JSON.parse(localStorage.getItem('store-demo-cart'))),[]);
  await buyer.reload();await buyer.locator('#order-number').waitFor();assert.equal(await buyer.locator('#order-number').innerText(),number);
  assert.equal(await buyer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await buyer.screenshot({path:'/tmp/order-confirmation-mobile.png',fullPage:true});
  await admin.goto(base+'/admin');await admin.getByLabel('Email',{exact:true}).fill('owner@example.test');await admin.getByLabel('Пароль',{exact:true}).fill(password);await admin.getByRole('button',{name:'Войти',exact:true}).click();
  await admin.getByRole('button',{name:'Заказы',exact:true}).click();await admin.getByRole('button',{name:'Открыть заказ',exact:true}).click();
  assert.match(await admin.locator('.order-contacts').innerText(),/buyer@example.test/);assert.match(await admin.locator('.order-note').first().innerText(),/<script>/);assert.equal(await admin.evaluate(()=>window.untrusted),undefined);
  assert.match(await admin.locator('.editor-main').innerText(),/HAT-LINE-BLACK-58/);
  await admin.screenshot({path:'/tmp/order-admin-desktop.png',fullPage:true});
  await admin.getByRole('button',{name:'Отменить заказ',exact:true}).click();await stateIs('Отменён');assert.equal(instance.store.orders.reserved('HAT-LINE-BLACK-58'),0);
  assert.equal(instance.store.products(true).find(p=>p.id==='hat-line').variants.find(v=>v.sku==='HAT-LINE-BLACK-58').stock,1);
  await buyer.reload();await buyer.getByRole('heading',{name:'Заказ больше не активен',exact:true}).waitFor();
  // The server creates order 2, but its response is lost. A retry must reuse the key.
  await basket();let lost=false;
  await buyer.route('**/api/orders',async route=>{if(!lost){lost=true;await route.fetch();await route.abort('failed')}else await route.continue()});
  await buyer.getByRole('button',{name:'Отправить заказ',exact:true}).click();await buyer.getByRole('alert').filter({hasText:'Подтверждение не получено'}).waitFor();assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,2);
  await buyer.unroute('**/api/orders');await buyer.getByRole('button',{name:'Отправить заказ',exact:true}).click();await buyer.locator('#order-number').waitFor();assert.equal(await buyer.locator('#order-number').innerText(),'000002');assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,2);
  await openOrder(2);await admin.getByRole('button',{name:'Подтвердить заказ',exact:true}).click();await stateIs('Подтверждён');
  await admin.getByRole('button',{name:'Передать в доставку',exact:true}).click();await stateIs('Отправлен');assert.equal(instance.store.orders.reserved('HAT-LINE-BLACK-58'),0);assert.equal(instance.store.db.prepare('SELECT stock FROM variants WHERE sku=?').get('HAT-LINE-BLACK-58').stock,0);
  await admin.getByRole('button',{name:'Завершить заказ',exact:true}).click();await stateIs('Завершён');
  // A lost response followed by a reload recovers the receipt even if the basket is reconciled.
  await basket('sponges-dish','SPONGES-5');await buyer.route('**/api/orders',async route=>{await route.fetch();await route.abort('failed')});
  await buyer.getByRole('button',{name:'Отправить заказ',exact:true}).click();await buyer.getByRole('alert').filter({hasText:'Подтверждение не получено'}).waitFor();await buyer.unroute('**/api/orders');await buyer.reload();await buyer.locator('#order-number').waitFor();assert.equal(await buyer.locator('#order-number').innerText(),'000003');assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,3);
  assert.equal(await buyer.evaluate(()=>JSON.stringify({...sessionStorage}).includes('buyer@example.test')),false);
  // A stale price yields an explicit cart review, retaining the buyer's contact fields.
  await basket('sponges-dish','SPONGES-5');instance.store.db.prepare('UPDATE variants SET price_cents=450 WHERE sku=?').run('SPONGES-5');
  await buyer.getByRole('button',{name:'Отправить заказ',exact:true}).click();await buyer.getByRole('alert').filter({hasText:'Цена товара изменилась'}).waitFor();assert.match(await buyer.locator('.cart-item').innerText(),/4,5 BYN/);assert.equal(instance.store.db.prepare('SELECT count(*) AS n FROM orders').get().n,3);
  await buyer.locator('[data-go="checkout"]').click();assert.equal(await buyer.locator('[name="name"]').inputValue(),'Тестовый покупатель');
  await admin.setViewportSize({width:390,height:844});await openOrder(3);assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await admin.screenshot({path:'/tmp/order-admin-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: buyer checkout, double submit, private admin orders, cancel/release, confirm/ship/complete, lost-response retry/reload, stale price and mobile');
 }catch(error){await buyer?.screenshot({path:'/tmp/order-buyer-debug.png',fullPage:true}).catch(()=>{});await admin?.screenshot({path:'/tmp/order-admin-debug.png',fullPage:true}).catch(()=>{});throw error}
 finally{await browser.close();await new Promise(resolve=>instance.server.close(resolve));instance.store.close();await fs.rm(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exit(1)});
