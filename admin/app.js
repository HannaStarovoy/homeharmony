const app=document.querySelector('#admin-app');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(value)+' BYN';
const clone=value=>JSON.parse(JSON.stringify(value));
const state={selected:new Map(),visibleIds:[],bulkAction:'publish',user:null,csrf:'',catalog:null,editor:null,attrs:[],dimensions:[],search:'',status:'all',category:'all',message:'',error:'',busy:false,uploading:false,setupRequired:false,dirty:false,openVariantPhotos:new Set(),view:location.hash.startsWith('#order')?'orders':'products',ordersData:null,order:null,orderSearch:'',orderStatus:'all',orderPage:1};
async function api(path,{method='GET',body,raw=false}={}) {
 const headers={};if(method!=='GET')headers['X-CSRF-Token']=state.csrf;
 if(body!==undefined&&!raw)headers['Content-Type']='application/json';
 const response=await fetch(path,{method,headers,body:body===undefined?undefined:raw?body:JSON.stringify(body),credentials:'same-origin'});
 const data=await response.json();
 if(!response.ok){
  if(response.status===401&&path!=='/api/admin/login'){state.user=null;state.selected.clear();state.setupRequired=data.setupRequired;renderLogin()}
  throw new Error(data.message||'Не удалось выполнить операцию.');
 }
 return data;
}
function messageHTML(){return state.error?`<div class="notice error" role="alert">${esc(state.error)}</div>`:state.message?`<div class="notice success" role="status">${esc(state.message)}</div>`:''}
function showMessage(){const box=document.querySelector('#messages');if(box)box.innerHTML=messageHTML()}
function header(){return `<header class="topbar"><div class="wrap"><div class="brand"><span class="mark">М</span><span class="brand-copy"><strong>Управление магазином</strong><small>Каталог, остатки и заказы</small></span></div><nav class="top-links"><button class="btn ${state.view==='products'?'secondary':'plain'} small" data-admin-view="products">Товары</button><button class="btn ${state.view==='orders'?'secondary':'plain'} small" data-admin-view="orders">Заказы</button><a href="/" target="_blank" rel="noopener">Открыть витрину ↗</a><button class="btn plain small" data-action="logout">Выйти</button></nav></div></header>`}
function path(id){const result=[];let current=state.catalog.categories.find(c=>c.id===id);while(current){if(current.id!=='all')result.unshift(current.name);current=state.catalog.categories.find(c=>c.id===current.parent)}return result.join(' / ')}
function categoryOptions(value,all=false){return `${all?'<option value="all">Все категории</option>':'<option value="">Выберите категорию</option>'}${state.catalog.categories.filter(c=>c.id!=='all').map(c=>`<option value="${c.id}" ${value===c.id?'selected':''}>${esc(path(c.id))}</option>`).join('')}`}
function templateFor(id){let current=state.catalog.categories.find(c=>c.id===id);while(current){if(state.catalog.templates[current.id])return state.catalog.templates[current.id];current=state.catalog.categories.find(c=>c.id===current.parent)}return {attributes:[],dimensions:[]}}
function renderLogin(){
 app.innerHTML=`<main class="login"><div class="brand"><span class="mark">М</span><span class="brand-copy"><strong>Управление магазином</strong><small>Каталог, остатки и заказы</small></span></div><section class="panel"><h1>Вход в панель</h1><p class="muted">Товары и заказы вашего магазина.</p><div id="messages">${messageHTML()}</div>${state.setupRequired?'<div class="notice">Сначала создайте учётную запись владельца в терминале проекта командой <code>npm run admin:create</code>. Пароля по умолчанию нет.</div>':''}<form id="login-form"><label class="field">Email<input type="email" name="email" autocomplete="username" required maxlength="200"></label><label class="field">Пароль<input type="password" name="password" autocomplete="current-password" required maxlength="256"></label><button class="btn" type="submit">Войти</button></form></section><a href="/">← Вернуться в магазин</a></main>`;
}
async function loadCatalog(){state.catalog=await api('/api/admin/catalog');state.selected.clear()}
async function loadOrders(){state.ordersData=await api('/api/admin/orders?'+new URLSearchParams({q:state.orderSearch,status:state.orderStatus,page:state.orderPage}))}
async function readAdminRoute(){
 const current=location.hash,id=current.match(/^#order\/([1-9]\d*)$/)?.[1];
 state.error='';state.message='';state.order=null;
 if(current.startsWith('#order')){
  state.view='orders';
  try{if(id){const result=await api('/api/admin/orders/'+id);if(location.hash!==current)return;state.order=result}else await loadOrders()}
  catch(error){if(!state.user)return;state.error=error.message;await loadOrders()}
 }else{state.view='products';await loadCatalog()}
 render();
}
window.addEventListener('hashchange',async()=>{
 if(!state.user)return;
 if(state.busy||state.uploading||(state.dirty&&!confirm('Перейти без сохранения товара?'))){history.replaceState(null,'',state.view==='orders'?(state.order?'#order/'+state.order.id:'#orders'):'#products');return}
 state.editor=null;state.dirty=false;try{await readAdminRoute()}catch(error){setError(error)}
});
const orderTime=value=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Minsk',dateStyle:'short',timeStyle:'short'}).format(value);
const orderLabels={new:'Новый',confirmed:'Подтверждён',shipped:'Отправлен',completed:'Завершён',cancelled:'Отменён',expired:'Резерв истёк'};
function renderOrders(){
 const data=state.ordersData;
 app.innerHTML=header()+`<main class="wrap page"><div class="heading"><div><h1>Заказы</h1><span class="muted">Новых: ${data.counts.new||0} · Подтверждённых: ${data.counts.confirmed||0}</span></div><button class="btn secondary" data-action="refresh-orders">Обновить список</button></div><div id="messages">${messageHTML()}</div><form id="order-search-form" class="toolbar"><input type="search" name="query" aria-label="Поиск заказов" placeholder="Номер, имя или телефон" value="${esc(state.orderSearch)}" maxlength="120"><select id="order-status-filter" aria-label="Статус заказа"><option value="all">Все статусы</option>${Object.entries(orderLabels).map(([key,label])=>`<option value="${key}" ${state.orderStatus===key?'selected':''}>${label}</option>`).join('')}</select><button class="btn secondary" type="submit">Найти</button></form><section class="panel table-scroll">${data.orders.length?`<table class="list"><thead><tr><th>Заказ</th><th>Покупатель</th><th>Товары</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${data.orders.map(order=>`<tr><td><strong>№ ${esc(order.number)}</strong><p class="hint">${orderTime(order.createdAt)} (Минск)</p></td><td>${esc(order.customer.name)}<p class="hint">${esc(order.customer.phone)}</p></td><td>${order.qty} шт.</td><td>${money(order.totalCents/100)}</td><td><span class="badge order-${order.status}">${esc(order.statusName)}</span></td><td><button class="btn secondary small" data-order="${order.id}">Открыть заказ</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty"><h2>Заказов пока нет</h2><p class="muted">Здесь появятся отправленные покупателями заказы. Можно изменить условия поиска.</p></div>'}</section><nav class="actions" aria-label="Страницы заказов"><button class="btn plain small" data-order-page="${data.page-1}" ${data.page<=1?'disabled':''}>← Назад</button><span class="hint">Страница ${data.page} из ${data.pages} · Найдено: ${data.total}</span><button class="btn plain small" data-order-page="${data.page+1}" ${data.page>=data.pages?'disabled':''}>Далее →</button></nav></main>`;
}
function renderOrder(){
 const o=state.order,actions={confirmed:'Подтвердить заказ',shipped:'Передать в доставку',completed:'Завершить заказ',cancelled:'Отменить заказ'};
 app.innerHTML=header()+`<main class="wrap page"><div class="heading"><div><button class="btn plain small" data-action="back-orders">← К списку заказов</button><h1 style="margin-top:15px">Заказ № ${esc(o.number)}</h1><span class="hint">${orderTime(o.createdAt)} (Минск)</span></div><button class="btn secondary" data-action="refresh-order">Обновить карточку</button></div><div id="messages">${messageHTML()}</div><div class="editor-layout"><div class="editor-main"><section class="panel"><h2>Покупатель</h2><dl class="order-contacts">${[['Имя',o.customer.name],['Телефон',o.customer.phone],['Email',o.customer.email||'Не указан'],['Город',o.customer.city],['Адрес',o.delivery==='pickup'?'Самовывоз':o.customer.address],['Доставка',o.deliveryName],['Оплата','По согласованию с продавцом']].map(([key,value])=>`<div><dt>${key}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${o.customer.note?`<h3>Комментарий покупателя</h3><p class="order-note">${esc(o.customer.note)}</p>`:''}</section><section class="panel table-scroll"><h2>Состав заказа</h2><table class="list"><thead><tr><th>Товар / SKU</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${o.items.map(item=>`<tr><td><strong>${esc(item.name)}</strong><p class="hint">${esc(item.variant)} · ${esc(item.sku)}</p></td><td>${item.qty}</td><td>${money(item.priceCents/100)}</td><td>${money(item.totalCents/100)}</td></tr>`).join('')}</tbody></table><div class="order-totals"><p>Товары <strong>${money(o.subtotalCents/100)}</strong></p><p>Доставка <strong>${money(o.shippingCents/100)}</strong></p><p>Итого <strong>${money(o.totalCents/100)}</strong></p></div><p class="hint">Цены и названия сохранены на момент оформления заказа.</p></section><section class="panel"><h2>История заказа</h2><ol class="order-history">${o.events.map(event=>`<li><strong>${esc(orderLabels[event.status]||event.status)}</strong> · ${orderTime(event.createdAt)}<p class="hint">${esc(event.actor==='customer'?'Покупатель':event.actor==='system'?'Автоматически':event.actor)}</p>${event.note?`<p class="order-note">${esc(event.note)}</p>`:''}</li>`).join('')}</ol></section></div><aside class="editor-side"><section class="panel"><h2>Статус заказа</h2><p><span class="badge order-${o.status}">${esc(o.statusName)}</span></p><p class="hint">${o.status==='new'?`Резерв до ${orderTime(o.reservedUntil)} (Минск). Без подтверждения он освободится автоматически.`:o.status==='confirmed'?'Товары в резерве до отправки, завершения или отмены.':o.status==='shipped'||o.status==='completed'?'Товары списаны с физического остатка.':'Резерв освобождён.'}</p>${o.allowedStatuses.length?`<label class="field" style="margin-top:18px">Комментарий к изменению<textarea id="order-status-note" maxlength="1000" rows="3" placeholder="Необязательно"></textarea></label><div class="actions">${o.allowedStatuses.map(status=>`<button class="btn ${status==='cancelled'?'danger':'secondary'}" data-order-state="${status}">${actions[status]}</button>`).join('')}</div>`:''}<p class="footer-note">Оплата и доставка согласуются вручную. Нажатие кнопки не отправляет платёж или заявку в службу доставки.</p></section></aside></div></main>`;
}

function renderList(){
 const products=state.catalog.products.filter(p=>{
  const matchCategory=state.category==='all'||path(p.cat).startsWith(path(state.category));
  const q=state.search.trim().toLocaleLowerCase('ru');
  return (state.status==='all'||p.status===state.status)&&matchCategory&&(!q||[p.name,path(p.cat),...p.variants.map(v=>v.sku)].join(' ').toLocaleLowerCase('ru').includes(q));
 });
 state.visibleIds=products.map(p=>p.id);
 app.innerHTML=header()+`<main class="wrap page"><div class="heading"><div><span class="heading-eyebrow">Рабочее пространство</span><h1>Товары</h1><p class="heading-description">Карточки, цены и наличие — всё в одном месте</p></div><button class="btn" data-action="new">+ Добавить товар</button></div><section class="overview" aria-label="Сводка по товарам"><div class="metric"><div><span class="metric-label">Всего товаров</span><strong>${state.catalog.products.length}</strong></div><span class="metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></span></div><div class="metric published-metric"><div><span class="metric-label">На витрине</span><strong>${state.catalog.products.filter(p=>p.status==='published').length}</strong></div><span class="metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m5 12 4 4L19 6"/><path d="M20 12v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h7"/></svg></span></div><div class="metric draft-metric"><div><span class="metric-label">Черновики</span><strong>${state.catalog.products.filter(p=>p.status==='draft').length}</strong></div><span class="metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 14h8M8 17h5"/></svg></span></div><div class="metric stock-metric"><div><span class="metric-label">Нет в наличии</span><strong>${state.catalog.products.filter(p=>p.variants.every(v=>Math.max(0,v.stock-(v.reserved||0))===0)).length}</strong></div><span class="metric-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m3 7 9-4 9 4v10l-9 4-9-4ZM3 7l9 4 9-4M12 11v10"/><path d="m8 5 9 4"/></svg></span></div></section><div id="messages">${messageHTML()}</div><div class="toolbar"><input type="search" id="search" aria-label="Поиск товаров" placeholder="Название или артикул" value="${esc(state.search)}"><select id="status-filter" aria-label="Статус товара"><option value="all">Все статусы</option><option value="draft" ${state.status==='draft'?'selected':''}>Черновики</option><option value="published" ${state.status==='published'?'selected':''}>На витрине</option></select><select id="category-filter" aria-label="Категория товара">${categoryOptions(state.category,true)}</select></div><div class="bulk-toolbar"><span aria-live="polite">Выбрано: ${state.selected.size}</span><select id="bulk-action" aria-label="Действие с выбранными товарами"><option value="publish" ${state.bulkAction==='publish'?'selected':''}>Опубликовать</option><option value="draft" ${state.bulkAction==='draft'?'selected':''}>Вернуть в черновики</option><option value="delete" ${state.bulkAction==='delete'?'selected':''}>Удалить</option></select><button class="btn small" data-action="bulk-apply" ${!state.selected.size||state.busy?'disabled':''}>Применить к выбранным</button><button class="btn plain small" data-action="clear-selection" ${!state.selected.size||state.busy?'disabled':''}>Снять выбор</button><span class="hint">При обновлении списка, поиске или смене фильтров выбор сбрасывается.</span></div><section class="panel table-scroll">${products.length?`<table class="list product-list"><thead><tr><th class="selection-cell"><input type="checkbox" id="select-all-products" aria-label="Выбрать все найденные товары" ${products.length&&products.every(p=>state.selected.has(p.id))?'checked':''} ${state.busy?'disabled':''}></th><th>Товар</th><th>Категория</th><th>Цена</th><th>Остаток</th><th>Статус</th><th></th></tr></thead><tbody>${products.map(p=>{
 const image=p.images?.[0]||p.variants.flatMap(v=>v.images||[])[0];const prices=p.variants.map(v=>v.price);
 return `<tr><td class="selection-cell"><input type="checkbox" data-select-product="${p.id}" aria-label="Выбрать ${esc(p.name)}" ${state.selected.has(p.id)?'checked':''} ${state.busy?'disabled':''}></td><td><div class="item-name">${image?`<img class="thumb" src="${esc(image)}" alt="">`:'<span class="thumb placeholder" aria-hidden="true">▧</span>'}<div><strong>${esc(p.name)}</strong><span class="hint">${p.variants.length} SKU</span></div></div></td><td>${esc(path(p.cat))}</td><td>${new Set(prices).size>1?'от ':''}${money(Math.min(...prices))}</td><td>${p.variants.reduce((n,v)=>n+v.stock,0)} шт.<p class="hint">Резерв: ${p.variants.reduce((n,v)=>n+(v.reserved||0),0)}</p></td><td><span class="badge ${p.status}">${p.status==='published'?'На витрине':'Черновик'}</span></td><td><button class="btn secondary small" data-edit="${p.id}">Редактировать</button> <button class="btn danger small" data-delete="${p.id}">Удалить</button></td></tr>`;
 }).join('')}</tbody></table>`:'<div class="empty"><h2>Товары не найдены</h2><p class="muted">Измените условия поиска или добавьте новый товар.</p></div>'}</section></main>`;
 const allBox=document.querySelector('#select-all-products');if(allBox)allBox.indeterminate=products.some(p=>state.selected.has(p.id))&&!products.every(p=>state.selected.has(p.id));
 document.querySelectorAll('#search,#status-filter,#category-filter,#bulk-action').forEach(input=>input.disabled=state.busy);
}
function emptyVariant(){return {sku:'SKU-'+crypto.randomUUID().slice(0,8).toUpperCase(),price:0,old:0,stock:0,color:'#cad6e8',options:Object.fromEntries(state.dimensions.map(key=>[key,''])),images:[]}}
function startEditor(product){
 state.error='';state.message='';state.dirty=!product;state.openVariantPhotos=new Set();
 state.editor=product?clone(product):{name:'',cat:'',summary:'',attrs:{},images:[],status:'draft',variants:[]};
 state.attrs=Object.entries(state.editor.attrs).map(([key,value])=>({key,value}));
 state.dimensions=[...new Set(state.editor.variants.flatMap(v=>Object.keys(v.options)))];
 if(!state.editor.variants.length)state.editor.variants.push(emptyVariant());
 renderEditor();
 window.scrollTo({top:0,behavior:'instant'});
}
function photosHTML(images,target){return `<div class="photo-list">${images.map((url,i)=>`<div class="photo"><img src="${esc(url)}" alt="Фотография ${i+1}">${i===0?'<span class="main-label">Основная</span>':`<button type="button" class="btn plain" data-photo-main="${target}" data-index="${i}">Сделать основной</button>`}<button type="button" class="btn danger" data-photo-remove="${target}" data-index="${i}">Убрать фото</button></div>`).join('')}</div><label class="field">Добавить фотографии<input type="file" accept="image/jpeg,image/png,image/webp" multiple data-upload="${target}" ${state.uploading?'disabled':''}></label>`}
function renderEditor(){
 const p=state.editor,suggestions=templateFor(p.cat);
 app.innerHTML=header()+`<main class="wrap page"><div class="heading"><div><button class="btn plain small" data-action="back">← К списку товаров</button><h1 style="margin-top:15px">${p.id?'Редактирование товара':'Новый товар'}</h1></div>${p.id&&p.status==='published'?`<a class="btn secondary" href="/?view=product&product=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Посмотреть на витрине ↗</a>`:''}</div><div id="messages">${messageHTML()}</div><form id="product-form" novalidate><fieldset class="form-body" ${state.busy?'disabled':''}><div class="editor-layout"><div class="editor-main"><section class="panel"><h2>Основное</h2><label class="field">Название *<input name="name" data-product-field="name" value="${esc(p.name)}" maxlength="200" required></label><label class="field">Категория *<select name="category" id="editor-category" required>${categoryOptions(p.cat)}</select></label><label class="field">Описание<textarea rows="5" name="summary" data-product-field="summary" maxlength="10000">${esc(p.summary)}</textarea></label></section><section class="panel"><h2>Фотографии товара</h2><p class="hint">JPEG, PNG или WebP, до 8 МБ за файл. До 8 фото. Первое фото — основное; у варианта можно задать свои.</p>${photosHTML(p.images,'product')}</section><section class="panel"><h2>Характеристики</h2><p class="hint">Общие сведения: состав, назначение, уход. Цвет, объём и другие поля выбора задаются ниже у вариантов.</p><div style="margin-top:14px">${state.attrs.map((attr,i)=>`<div class="kv-row"><input aria-label="Название характеристики ${i+1}" data-attr-key="${i}" placeholder="Характеристика" value="${esc(attr.key)}" maxlength="60"><input aria-label="Значение характеристики ${i+1}" data-attr-value="${i}" placeholder="Значение" value="${esc(attr.value)}" maxlength="500"><button type="button" class="btn plain small" data-attr-remove="${i}" aria-label="Убрать характеристику ${i+1}">×</button></div>`).join('')}</div><button type="button" class="btn secondary small" data-action="add-attribute">+ Характеристика</button></section><section class="panel"><h2>Варианты и остатки</h2><p class="hint">У каждого SKU свои цена, остаток и фотографии. Для товара без выбора оставьте один SKU без параметров.</p>${p.variants.some(v=>v.sourceManaged)?'<p class="hint">Товар перенесён из Emall. Перед публикацией проверьте категорию, фотографии и остаток: учёт резервов маркетплейса требует сверки.</p>':''}<div class="dimensions">${state.dimensions.map((key,i)=>`<span class="dimension">${esc(key)}<button type="button" data-dimension-remove="${i}" aria-label="Убрать параметр ${esc(key)}">×</button></span>`).join('')}</div><div class="dimension-add"><input id="dimension-name" list="suggested-dimensions" aria-label="Новый параметр варианта" placeholder="Цвет, размер, объём…" maxlength="60"><datalist id="suggested-dimensions">${suggestions.dimensions.map(key=>`<option value="${esc(key)}">`).join('')}</datalist><button type="button" class="btn secondary small" data-action="add-dimension">Добавить параметр</button></div>${p.variants.map((v,i)=>`<article class="variant"><div class="variant-heading"><h3>Вариант ${i+1}</h3><button type="button" class="btn danger small" data-variant-remove="${i}" ${p.variants.length===1?'disabled':''}>Убрать вариант</button></div><div class="grid"><label class="field">Артикул (SKU) *<input data-variant-field="sku" data-index="${i}" value="${esc(v.sku)}" maxlength="64" ${v.sourceManaged?'readonly':''} aria-label="Артикул варианта ${i+1}">${v.externalSku?`<span class="hint">Артикул Emall: ${esc(v.externalSku)}</span>`:''}</label><label class="field">Цена, BYN *<input type="number" min="0" step="0.01" data-variant-field="price" data-index="${i}" value="${v.price}" aria-label="Цена варианта ${i+1}"></label><label class="field">Физический остаток, шт. *<input type="number" min="0" step="1" data-variant-field="stock" data-index="${i}" value="${v.stock}" aria-label="Остаток варианта ${i+1}"><span class="hint">Резерв: ${v.reserved||0} · Доступно: ${Math.max(0,v.stock-(v.reserved||0))}</span></label><label class="field">Старая цена, BYN<input type="number" min="0" step="0.01" data-variant-field="old" data-index="${i}" value="${v.old||''}" aria-label="Старая цена варианта ${i+1}" placeholder="Без скидки"></label>${state.dimensions.map(key=>`<label class="field">${esc(key)} *<input data-option-key="${esc(key)}" data-index="${i}" value="${esc(v.options[key])}" maxlength="500" aria-label="${esc(key)} варианта ${i+1}"></label>`).join('')}${state.dimensions.includes('Цвет')?`<label class="field">Оттенок для каталога<input type="color" data-variant-field="color" data-index="${i}" value="${esc(v.color)}" aria-label="Оттенок варианта ${i+1}"></label>`:''}</div><details data-variant-photos="${i}" ${state.openVariantPhotos.has(i)?'open':''}><summary>Фотографии этого варианта (${v.images?.length||0})</summary>${photosHTML(v.images||[],String(i))}</details></article>`).join('')}<button type="button" class="btn secondary" style="margin-top:18px" data-action="add-variant">+ Добавить вариант</button></section></div><aside class="editor-side"><section class="panel"><h2>Сохранение</h2><p><span class="badge ${p.status}">${p.status==='published'?'На витрине':'Черновик'}</span></p><p class="hint">Черновик виден только в панели. Публикация покажет товар покупателям на витрине этого магазина.</p><div class="actions" style="margin-top:18px"><button class="btn" type="submit" name="intent" value="published" ${state.busy||state.uploading?'disabled':''}>${state.busy?'Сохраняем…':p.status==='published'?'Сохранить на витрине':'Опубликовать товар'}</button><button class="btn secondary" type="submit" name="intent" value="draft" ${state.busy||state.uploading?'disabled':''}>${p.status==='published'?'Сохранить и скрыть':'Сохранить черновик'}</button></div>${state.uploading?'<p role="status" class="hint">Загружаем фотографии…</p>':''}<p class="footer-note">Перед публикацией проверьте цены, остатки и описание товара.</p>${p.id?`<button type="button" class="btn danger" data-delete="${p.id}" style="margin-top:16px">Удалить товар</button>`:''}</section></aside></div></fieldset></form></main>`;
}
function render(){if(!state.user)return renderLogin();if(state.view==='orders'){if(state.order)return renderOrder();if(state.ordersData)return renderOrders();return}if(state.editor)renderEditor();else renderList()}
async function boot(){try{const user=await api('/api/admin/session');Object.assign(state,{user:user.email,csrf:user.csrf});await loadCatalog();if(state.view==='orders')await readAdminRoute();else render()}catch(error){state.error=state.setupRequired?'':error.message;renderLogin()}}
function setError(error){state.error=error.message;state.message='';showMessage();document.querySelector('#messages')?.scrollIntoView({block:'center',behavior:'smooth'})}
function imageList(target){return target==='product'?state.editor.images:(state.editor.variants[Number(target)].images??=[])}
function applyCategory(cat){
 state.editor.cat=cat;state.dirty=true;state.message='';
 const suggestions=templateFor(cat);
 const existing=new Set(state.attrs.map(a=>a.key));
 // Keep entered attributes; replace only blank suggestions from the previous category.
 state.attrs=state.attrs.filter(a=>a.value.trim()||suggestions.attributes.includes(a.key));
 for(const key of suggestions.attributes)if(!existing.has(key)&&!state.dimensions.includes(key))state.attrs.push({key,value:''});
 renderEditor();
}
function cleanProduct(status){
 const p=clone(state.editor);p.status=status;p.attrs=Object.create(null);
 for(const {key,value} of state.attrs){
  if(!value.trim())continue;
  if(!key.trim())throw new Error('Заполните название и значение характеристики или уберите пустую строку.');
  if(Object.hasOwn(p.attrs,key.trim()))throw new Error('Названия характеристик должны различаться.');
  p.attrs[key.trim()]=value.trim();
 }
 // Empty suggested fields are optional; entered values are kept on category changes.
 return p;
}
app.addEventListener('input',e=>{
 const d=e.target.dataset,value=e.target.value;
 if(state.editor&&e.target.id!=='search'){state.dirty=true;state.message='';showMessage()}
 if(d.productField)state.editor[d.productField]=value;
 if(d.attrKey!==undefined)state.attrs[Number(d.attrKey)].key=value;
 if(d.attrValue!==undefined)state.attrs[Number(d.attrValue)].value=value;
 if(d.variantField){const numeric=['price','old','stock'].includes(d.variantField);state.editor.variants[Number(d.index)][d.variantField]=numeric?(value===''?0:Number(value)):value}
 if(d.optionKey)state.editor.variants[Number(d.index)].options[d.optionKey]=value;
 if(e.target.id==='search'){const start=e.target.selectionStart;state.search=value;state.selected.clear();renderList();const input=document.querySelector('#search');input.focus();input.setSelectionRange(start,start)}
});
app.addEventListener('toggle',e=>{if(e.target.dataset.variantPhotos!==undefined){const index=Number(e.target.dataset.variantPhotos);if(e.target.open)state.openVariantPhotos.add(index);else state.openVariantPhotos.delete(index)}},true);
app.addEventListener('change',async e=>{
 const d=e.target.dataset;
 if(d.selectProduct!==undefined){if(state.busy)return;const p=state.catalog.products.find(p=>p.id===d.selectProduct);if(p){if(e.target.checked)state.selected.set(p.id,p.version);else state.selected.delete(p.id)}renderList();document.querySelector('[data-select-product="'+d.selectProduct+'"]')?.focus();return}
 if(e.target.id==='select-all-products'){if(state.busy)return;for(const id of state.visibleIds){const p=state.catalog.products.find(p=>p.id===id);if(e.target.checked)state.selected.set(id,p.version);else state.selected.delete(id)}renderList();document.querySelector('#select-all-products')?.focus();return}
 if(e.target.id==='bulk-action'){state.bulkAction=e.target.value;return}
 if(e.target.id==='status-filter'){state.status=e.target.value;state.selected.clear();renderList()}
 if(e.target.id==='category-filter'){state.category=e.target.value;state.selected.clear();renderList()}
 if(e.target.id==='order-status-filter'){state.orderStatus=e.target.value;state.orderPage=1;try{await loadOrders();render()}catch(error){setError(error)}}
 if(e.target.id==='editor-category')applyCategory(e.target.value);
 if(d.upload!==undefined){
  const files=[...e.target.files],images=imageList(d.upload);
  if(images.length+files.length>8)return setError(new Error('Можно добавить до 8 фотографий.'));
  state.uploading=true;state.error='';state.message='';state.dirty=true;if(d.upload!=='product')state.openVariantPhotos.add(Number(d.upload));renderEditor();
  try{for(const file of files){if(file.size>8*1024*1024)throw new Error('Размер фотографии не должен превышать 8 МБ.');const result=await api('/api/admin/media',{method:'POST',body:file,raw:true});images.push(result.url)}}catch(error){setError(error)}finally{state.uploading=false;render()}
 }
});
app.addEventListener('click',async e=>{
 const button=e.target.closest('button');if(!button||button.disabled||state.uploading||state.busy)return;const d=button.dataset;
 try{
  if(d.action==='logout'){if(state.dirty&&!confirm('Выйти без сохранения изменений?'))return;await api('/api/admin/logout',{method:'POST',body:{}});state.user=null;state.selected.clear();state.editor=null;state.dirty=false;state.message='';state.error='';renderLogin();return}
  if(d.adminView){
   if(state.dirty&&!confirm('Перейти без сохранения товара?'))return;
   state.view=d.adminView;state.editor=null;state.order=null;state.dirty=false;state.error='';state.message='';
   history.replaceState(null,'',state.view==='orders'?'#orders':'#products');
   if(state.view==='orders')await loadOrders();else await loadCatalog();render();return;
  }
  if(d.order){state.order=await api('/api/admin/orders/'+d.order);state.view='orders';state.error='';state.message='';history.replaceState(null,'','#order/'+d.order);render();return}
  if(d.action==='back-orders'){state.order=null;state.error='';state.message='';history.replaceState(null,'','#orders');await loadOrders();render();return}
  if(d.action==='refresh-orders'){await loadOrders();render();return}
  if(d.action==='refresh-order'){state.order=await api('/api/admin/orders/'+state.order.id);state.error='';state.message='';render();return}
  if(d.orderPage){state.orderPage=Number(d.orderPage);await loadOrders();render();return}
  if(d.orderState){
   if(d.orderState==='cancelled'&&!confirm('Отменить заказ и освободить резерв?'))return;
   if(['shipped','completed'].includes(d.orderState)&&!confirm('Подтвердить изменение статуса? При первой отправке или выдаче товары будут списаны со склада.'))return;
   const payload={status:d.orderState,version:state.order.version,note:document.querySelector('#order-status-note')?.value||''};
   state.busy=true;document.querySelectorAll('[data-order-state]').forEach(b=>b.disabled=true);
   try{state.order=await api('/api/admin/orders/'+state.order.id,{method:'PUT',body:payload});state.message='Статус заказа сохранён.';state.error='';await loadCatalog()}finally{state.busy=false;render()}return;
  }
  if(d.delete){
   const product=state.catalog.products.find(p=>p.id===d.delete);if(!product)return;
   if(!confirm('Удалить товар «'+product.name+'»? Он исчезнет из каталога и админки. Повторный импорт Emall его не восстановит.'))return;
   state.busy=true;button.disabled=true;
   try{await api('/api/admin/products/'+product.id,{method:'DELETE',body:{version:product.version}});state.editor=null;state.dirty=false;state.error='';state.message='Товар удалён.';state.selected.delete(product.id);await loadCatalog()}finally{state.busy=false;render()}
   return;
  }
  if(d.action==='clear-selection'){state.selected.clear();renderList();return}
  if(d.action==='bulk-apply'){
   const action=state.bulkAction,products=[...state.selected].map(([id,version])=>({id,version}));if(!products.length)return;
   const verb={publish:'Опубликовать',draft:'Вернуть в черновики',delete:'Удалить'}[action];
   if(!confirm(verb+' выбранные товары ('+products.length+')?'+(action==='delete'?' Повторный импорт Emall не восстановит удалённые товары.':'')))return;
   state.busy=true;renderList();
   try{const result=await api('/api/admin/products/bulk',{method:'POST',body:{action,products}});state.selected.clear();state.message='Обработано товаров: '+result.selected+'. Изменено: '+result.changed+'.';state.error='';await loadCatalog()}
   finally{state.busy=false;render()}
   return;
  }
  if(d.action==='new')return startEditor();
  if(d.edit)return startEditor(state.catalog.products.find(p=>p.id===d.edit));
  if(d.action==='back'){if(state.dirty&&!confirm('Вернуться к списку? Несохранённые изменения будут потеряны.'))return;state.editor=null;state.dirty=false;state.error='';state.message='';renderList();return}
  if(state.editor&&(d.action?.startsWith('add-')||d.attrRemove!==undefined||d.dimensionRemove!==undefined||d.variantRemove!==undefined||d.photoRemove!==undefined||d.photoMain!==undefined)){state.dirty=true;state.message=''}
  if(d.action==='add-attribute'){state.attrs.push({key:'',value:''});renderEditor()}
  if(d.attrRemove!==undefined){state.attrs.splice(Number(d.attrRemove),1);renderEditor()}
  if(d.action==='add-dimension'){
   const key=document.querySelector('#dimension-name').value.trim();
   if(!key||key.length>60||['__proto__','constructor','prototype'].includes(key))throw new Error('Укажите название параметра.');
   if(state.dimensions.length>=5)throw new Error('Можно добавить до 5 параметров выбора.');
   if(state.dimensions.includes(key))throw new Error('Такой параметр уже добавлен.');
   if(state.attrs.some(a=>a.key===key&&a.value.trim()))throw new Error('Уберите общую характеристику с таким названием перед добавлением параметра выбора.');
   state.attrs=state.attrs.filter(a=>a.key!==key);state.dimensions.push(key);state.editor.variants.forEach(v=>v.options[key]='');renderEditor();
  }
  if(d.dimensionRemove!==undefined){const key=state.dimensions.splice(Number(d.dimensionRemove),1)[0];state.editor.variants.forEach(v=>delete v.options[key]);renderEditor()}
  if(d.action==='add-variant'){if(state.editor.variants.length>=100)throw new Error('Можно добавить до 100 вариантов.');if(!state.dimensions.length)throw new Error('Сначала добавьте параметр выбора: например, размер, объём или упаковку.');state.editor.variants.push(emptyVariant());renderEditor()}
  if(d.variantRemove!==undefined){state.editor.variants.splice(Number(d.variantRemove),1);state.openVariantPhotos=new Set();renderEditor()}
  if(d.photoRemove!==undefined){imageList(d.photoRemove).splice(Number(d.index),1);renderEditor()}
  if(d.photoMain!==undefined){const images=imageList(d.photoMain),[url]=images.splice(Number(d.index),1);images.unshift(url);renderEditor()}
 }catch(error){setError(error)}
});
app.addEventListener('submit',async e=>{
 e.preventDefault();state.error='';state.message='';
 if(e.target.id==='order-search-form'){state.orderSearch=new FormData(e.target).get('query')||'';state.orderPage=1;try{await loadOrders();render()}catch(error){setError(error)}return}
 if(e.target.id==='login-form'){
  const button=e.target.querySelector('button');button.disabled=true;
  try{const fields=new FormData(e.target);const user=await api('/api/admin/login',{method:'POST',body:{email:fields.get('email'),password:fields.get('password')}});state.user=user.email;state.csrf=user.csrf;state.setupRequired=false;await loadCatalog();if(state.view==='orders')await readAdminRoute();else render()}catch(error){setError(error);button.disabled=false}
 }
 if(e.target.id==='product-form'){
  if(state.busy||state.uploading)return;
  try{
   const status=e.submitter?.value||'draft',payload=cleanProduct(status);
   state.busy=true;renderEditor();
   const result=await api('/api/admin/products'+(payload.id?'/'+payload.id:''),{method:payload.id?'PUT':'POST',body:payload});
   state.editor=result;state.dirty=false;await loadCatalog();
   state.attrs=Object.entries(result.attrs).map(([key,value])=>({key,value}));
   state.message=status==='published'?'Товар сохранён и доступен на витрине.':'Черновик сохранён. Покупатели его не видят.';
  }catch(error){state.error=error.message}finally{state.busy=false;render();document.querySelector('#messages')?.scrollIntoView({block:'center',behavior:'smooth'})}
 }
});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue=''}});
boot();
