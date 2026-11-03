// Run: node tests/product.cjs (Playwright + Chromium).
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const css=fs.readFileSync(require('node:path').join(__dirname,'../storefront.css'),'utf8');
const seed=fs.readFileSync(require('node:path').join(__dirname,'../catalog-data.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://shop.test/**',r=>r.fulfill({contentType:new URL(r.request().url()).pathname==='/storefront.css'?'text/css':'text/html',body:new URL(r.request().url()).pathname==='/storefront.css'?css:new URL(r.request().url()).pathname==='/catalog-data.js'?seed:html}));
  const open=async(id,sku='')=>page.goto(`http://shop.test/?view=product&product=${id}${sku?'&sku='+sku:''}`);
  const option=(key,value)=>page.locator(`[data-option="${key}"][data-value="${value}"]`);
  const add=()=>page.locator('.buy-row [data-add]');
  const price=()=>page.locator('.detail-price').innerText();
  const plus=()=>page.getByRole('button',{name:'Увеличить количество',exact:true});
  await open('hat-line');assert.match(await price(),/^50 BYN/);
  await option('Размер','56–58').click();assert.match(await price(),/^55 BYN/);
  assert(await option('Цвет','Бордо').isDisabled());
  await option('Цвет','Бежевый').click();assert(await add().isDisabled());assert.match(await page.locator('.stock-info').innerText(),/Нет в наличии/);
  await option('Цвет','Чёрный').click();assert.match(page.url(),/sku=HAT-LINE-BLACK-58/);
  await page.reload();assert.equal(await option('Размер','56–58').getAttribute('aria-pressed'),'true');assert.match(await price(),/^55 BYN/);
  await page.goBack();assert.match(await price(),/^55 BYN/); // Sold-out beige SKU is also a shareable link.
  assert(await add().isDisabled());await page.goForward();assert(await add().isEnabled());
  for(let i=0;i<3;i++)await plus().click();assert(await plus().isDisabled());
  for(let i=0;i<2;i++)await page.getByRole('button',{name:'Уменьшить количество',exact:true}).click();
  await add().click();assert.match(await page.locator('.stock-info').innerText(),/В корзине: 2/);
  const before=await page.locator('.detail-main-img').innerHTML();await page.getByRole('button',{name:'Изображение 2',exact:true}).click();assert.notEqual(await page.locator('.detail-main-img').innerHTML(),before);
  await page.screenshot({path:'/tmp/product-hat-desktop.png',fullPage:true});
  await open('shampoo-satin');await option('Объём','500 мл').click();assert.match(await price(),/^58 BYN/);await add().click();
  await open('sponges-dish');assert.equal(await page.locator('[data-option="Цвет"]').count(),0);
  await option('Упаковка','10 шт.').click();assert.match(await price(),/^6 BYN/);assert(await add().isDisabled());
  await option('Упаковка','5 шт.').click();assert.match(await price(),/^3,5 BYN/);await plus().click();await add().click();
  await open('sweets-mix');assert.equal(await page.locator('.product-options').count(),0);
  assert.match(await page.locator('.detail-attrs').innerText(),/Срок годности/);assert.match(await page.locator('.detail-attrs').innerText(),/250 г/);
  await add().click();
  // Mobile cards have no horizontal overflow in all four categories.
  await page.setViewportSize({width:390,height:844});
  for(const id of ['hat-line','shampoo-satin','sponges-dish','sweets-mix']){
   await open(id);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert(await add().isVisible());
   await page.screenshot({path:`/tmp/product-${id}-mobile.png`,fullPage:true});
  }
  await page.locator('.header-icons [data-go="cart"]').click();assert.equal(await page.locator('.cart-item').count(),4);
  const total=await page.locator('.summary-line.total').innerText();assert.match(total,/182,9 BYN/);
  assert.match(await page.locator('.cart-item').first().innerText(),/56–58/);
  await page.locator('.cart-img').first().click();assert.match(page.url(),/sku=HAT-LINE-BLACK-58/);await page.goBack();
  await page.reload();assert.equal(await page.locator('.cart-item').count(),4);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('store-demo-cart')));
  assert(saved.every(item=>item.sku&&!Object.hasOwn(item,'variantIndex')));
  await page.locator('[data-go="checkout"]').click();assert.match(await page.locator('.summary-line.total').innerText(),/190,9 BYN/);
  // Once the stock of a SKU is in the basket, a repeated add is disabled.
  await open('hat-line','HAT-LINE-BLACK-58');await plus().click();await add().click();assert(await add().isDisabled());
  await page.reload();assert(await add().isDisabled());
  // Migration preserves a valid old cart; malformed/unknown entries are dropped.
  await page.evaluate(()=>localStorage.setItem('store-demo-cart',JSON.stringify([{id:'hat-line',variantIndex:0,qty:2},{id:'bad',sku:'x',qty:1},{id:'hat-line',variantIndex:999,qty:1},{id:'hat-line',variantIndex:0,qty:-1},null])));
  await page.goto('http://shop.test/?view=cart');assert.equal(await page.locator('.cart-item').count(),1);assert.match(await page.locator('.summary-line.total').innerText(),/100 BYN/);
  await page.goto('http://shop.test/?view=catalog&cat=shampoos&min=50&attr.Объём=250 мл');assert.equal(await page.locator('.catalog-results .product-card').count(),0);
  await page.goto('http://shop.test/?view=catalog&cat=shampoos&min=50&attr.Объём=500 мл');assert.equal(await page.locator('.catalog-results .product-card').count(),1);assert.match(await page.locator('.catalog-results .price').innerText(),/58 BYN/);
  await page.locator('.catalog-results [data-product]').first().click();assert.match(page.url(),/sku=SHAMPOO-SATIN-2/);
  await open('hat-line','invalid-sku');assert.match(page.url(),/sku=HAT-LINE-1/);
  assert.deepEqual(errors,[]);console.log('PASS: four product types, SKU options/prices/stock, URL/history, gallery, mobile layout, mixed cart/checkout, limits and legacy-cart migration');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
