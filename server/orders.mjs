import { createHash } from 'node:crypto';
import { Problem } from './errors.mjs';
export const deliveries={courier:{name:'Курьерская доставка',priceCents:800},post:{name:'Почтовая доставка',priceCents:600},pickup:{name:'Самовывоз',priceCents:0}};
export const statuses={new:'Новый',confirmed:'Подтверждён',shipped:'Отправлен',completed:'Завершён',cancelled:'Отменён',expired:'Резерв истёк'};
const transitions={new:['confirmed','cancelled'],confirmed:['shipped','completed','cancelled'],shipped:['completed'],completed:[],cancelled:[],expired:[]};
const hash=value=>createHash('sha256').update(value).digest('hex');
const keyPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const changed=message=>new Problem(409,message,'items','CART_CHANGED');
function keyHash(key){if(typeof key!=='string'||!keyPattern.test(key))throw new Problem(422,'Обновите страницу и повторите оформление заказа.');return hash(key.toLowerCase())}
function text(value,label,max,required=false){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new Problem(422,`Проверьте поле «${label}».`);return value.trim()}
export function normalizeOrder(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Problem(422,'Некорректные данные заказа.');
 const f=input.customer;if(!f||typeof f!=='object'||Array.isArray(f))throw new Problem(422,'Укажите контактные данные.');
 if(typeof input.delivery!=='string'||!Object.hasOwn(deliveries,input.delivery))throw new Problem(422,'Выберите способ доставки.');
 if(input.payment!=='manual')throw new Problem(422,'Оплата согласуется с продавцом. Онлайн-оплата пока не подключена.');
 if(input.consent!==true)throw new Problem(422,'Подтвердите согласие на обработку данных для оформления заказа.');
 const name=text(f.name,'Имя',120,true),rawPhone=text(f.phone,'Телефон',40,true),digits=rawPhone.replace(/\D/g,'');
 if(!/^[+()\d\s-]+$/.test(rawPhone)||digits.length<7||digits.length>15)throw new Problem(422,'Проверьте номер телефона.');
 const email=text(f.email??'','Email',200);if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Problem(422,'Проверьте электронную почту.');
 const city=text(f.city,'Город',120,true),address=input.delivery==='pickup'?'':text(f.address,'Адрес',500,true),note=text(f.note??'','Комментарий',1000);
 if(!Number.isSafeInteger(input.shippingCents)||input.shippingCents<0)throw new Problem(422,'Проверьте стоимость доставки.');
 if(!Array.isArray(input.items)||!input.items.length||input.items.length>100)throw new Problem(422,'В заказе должно быть от 1 до 100 позиций.');
 const seen=new Set();
 const items=input.items.map(item=>{
  if(!item||typeof item!=='object')throw new Problem(422,'Проверьте состав заказа.');
  const id=text(item.id,'Товар',80,true),sku=text(item.sku,'Артикул',64,true).toUpperCase();
  if(!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)||seen.has(sku))throw new Problem(422,'Вариант товара должен встречаться в заказе один раз.');seen.add(sku);
  if(!Number.isSafeInteger(item.qty)||item.qty<1||item.qty>1_000_000||!Number.isSafeInteger(item.priceCents)||item.priceCents<=0)throw new Problem(422,'Проверьте количество и цену товара.');
  return {id,sku,qty:item.qty,priceCents:item.priceCents};
 }).sort((a,b)=>a.sku.localeCompare(b.sku,'en'));
 return {customer:{name,phone:(rawPhone.startsWith('+')?'+':'')+digits,email,city,address,note},delivery:input.delivery,payment:'manual',consent:true,shippingCents:input.shippingCents,items};
}
export function createOrderStore(db,{reserveHours=24}={}){
 if(!Number.isFinite(reserveHours)||reserveHours<1||reserveHours>168)throw new Error('SHOP_RESERVE_HOURS must be between 1 and 168.');
 db.exec(`CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,idempotency_hash TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
  customer TEXT NOT NULL,delivery TEXT NOT NULL,payment TEXT NOT NULL,consent_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new','confirmed','shipped','completed','cancelled','expired')),
  subtotal_cents INTEGER NOT NULL,shipping_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reserved_until INTEGER,version INTEGER NOT NULL DEFAULT 1);
 CREATE INDEX IF NOT EXISTS orders_pending ON orders(status,reserved_until);
 CREATE TABLE IF NOT EXISTS order_items(
  order_id INTEGER NOT NULL REFERENCES orders(id),sku TEXT NOT NULL,product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,variant_name TEXT NOT NULL,options TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK(qty>0),unit_cents INTEGER NOT NULL CHECK(unit_cents>0),PRIMARY KEY(order_id,sku));
 CREATE TABLE IF NOT EXISTS reservations(
  order_id INTEGER NOT NULL REFERENCES orders(id),sku TEXT NOT NULL COLLATE NOCASE REFERENCES variants(sku),
  qty INTEGER NOT NULL CHECK(qty>0),PRIMARY KEY(order_id,sku));
 CREATE INDEX IF NOT EXISTS reservation_sku ON reservations(sku);
 CREATE TABLE IF NOT EXISTS order_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),status TEXT NOT NULL,actor TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS order_limits(address_hash TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires INTEGER NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(2);`);
 db.function('order_fold',{deterministic:true},value=>String(value??'').toLocaleLowerCase('ru').replace(/ё/g,'е'));
 const reserved=sku=>Number(db.prepare('SELECT coalesce(sum(qty),0) AS qty FROM reservations WHERE sku=?').get(sku).qty);
 function event(id,status,actor,note,now){db.prepare('INSERT INTO order_events(order_id,status,actor,note,created_at) VALUES(?,?,?,?,?)').run(id,status,actor,note,now)}
 function expireWithin(now){
  const rows=db.prepare("SELECT id FROM orders WHERE status='new' AND reserved_until<=?").all(now);
  for(const row of rows){
   db.prepare("UPDATE orders SET status='expired',reserved_until=NULL,version=version+1,updated_at=? WHERE id=?").run(now,row.id);
   db.prepare('DELETE FROM reservations WHERE order_id=?').run(row.id);event(row.id,'expired','system','Истёк срок ожидания подтверждения.',now);
  }
  return rows.length;
 }
 function expire(now=Date.now()){
  db.exec('BEGIN IMMEDIATE');try{const count=expireWithin(now);db.exec('COMMIT');return count}catch(error){db.exec('ROLLBACK');throw error}
 }
 function receipt(row){return {id:row.id,number:String(row.id).padStart(6,'0'),status:row.status,statusName:statuses[row.status],subtotalCents:row.subtotal_cents,shippingCents:row.shipping_cents,totalCents:row.total_cents,createdAt:row.created_at,reservedUntil:row.reserved_until}}
 function findReceipt(key){expire();const row=db.prepare('SELECT * FROM orders WHERE idempotency_hash=?').get(keyHash(key));if(!row)throw new Problem(404,'Подтверждение заказа не найдено.');return receipt(row)}
 function create(input,key,address){
  const value=normalizeOrder(input),keyDigest=keyHash(key),requestDigest=hash(JSON.stringify(value)),now=Date.now();
  db.exec('BEGIN IMMEDIATE');
  try{
   expireWithin(now);
   const existing=db.prepare('SELECT * FROM orders WHERE idempotency_hash=?').get(keyDigest);
   if(existing){if(existing.request_hash!==requestDigest)throw new Problem(409,'Состав отправляемого заказа изменился. Проверьте корзину и повторите оформление.');db.exec('COMMIT');return {replayed:true,receipt:receipt(existing)}}
   if(value.shippingCents!==deliveries[value.delivery].priceCents)throw changed('Стоимость доставки изменилась. Проверьте корзину.');
   const lines=value.items.map(item=>{
    const v=db.prepare('SELECT v.*,p.status,p.name AS product_name FROM variants v JOIN products p ON p.id=v.product_id WHERE v.sku=? AND v.product_id=?').get(item.sku,item.id);
    if(!v||v.status!=='published')throw changed('Один из товаров больше недоступен. Проверьте корзину.');
    if(v.price_cents!==item.priceCents)throw changed('Цена товара изменилась. Проверьте корзину перед отправкой.');
    if(item.qty>v.stock-reserved(v.sku))throw changed(`Недостаточно товара «${v.product_name}». Проверьте количество в корзине.`);
    return {...item,variant:v};
   });
   const subtotal=lines.reduce((sum,item)=>sum+item.qty*item.variant.price_cents,0),shipping=deliveries[value.delivery].priceCents;
   if(!Number.isSafeInteger(subtotal+shipping)||subtotal+shipping>100_000_000)throw new Problem(422,'Сумма заказа превышает допустимую. Свяжитесь с продавцом.');
   db.prepare('DELETE FROM order_limits WHERE expires<=?').run(now);
   const addressHash=hash(address||'unknown'),limit=db.prepare('SELECT attempts FROM order_limits WHERE address_hash=?').get(addressHash);
   if(limit?.attempts>=10)throw new Problem(429,'Слишком много заказов за короткое время. Повторите позже или свяжитесь с продавцом.');
   const result=db.prepare("INSERT INTO orders(idempotency_hash,request_hash,customer,delivery,payment,consent_version,status,subtotal_cents,shipping_cents,total_cents,created_at,updated_at,reserved_until) VALUES(?,?,?,?,?,?,'new',?,?,?,?,?,?)")
    .run(keyDigest,requestDigest,JSON.stringify(value.customer),value.delivery,'manual','order-contact-v1',subtotal,shipping,subtotal+shipping,now,now,now+reserveHours*3600000);
   const id=Number(result.lastInsertRowid);
   for(const line of lines){
    db.prepare('INSERT INTO order_items VALUES(?,?,?,?,?,?,?,?)').run(id,line.sku,line.id,line.variant.product_name,line.variant.name,line.variant.options,line.qty,line.variant.price_cents);
    db.prepare('INSERT INTO reservations VALUES(?,?,?)').run(id,line.sku,line.qty);
   }
   db.prepare('INSERT INTO order_limits VALUES(?,1,?) ON CONFLICT(address_hash) DO UPDATE SET attempts=attempts+1').run(addressHash,now+3600000);
   event(id,'new','customer','Заказ создан, товары зарезервированы.',now);
   const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);db.exec('COMMIT');return {replayed:false,receipt:receipt(row)};
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 function detail(id,{skipExpire=false}={}){
  if(!skipExpire)expire();const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!row)throw new Problem(404,'Заказ не найден.');
  return {...receipt(row),version:row.version,updatedAt:row.updated_at,customer:JSON.parse(row.customer),delivery:row.delivery,deliveryName:deliveries[row.delivery].name,payment:'manual',items:db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sku').all(id).map(i=>({sku:i.sku,productId:i.product_id,name:i.product_name,variant:i.variant_name,options:JSON.parse(i.options),qty:i.qty,priceCents:i.unit_cents,totalCents:i.qty*i.unit_cents})),events:db.prepare('SELECT status,actor,note,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY id').all(id).map(e=>({...e})),allowedStatuses:transitions[row.status]};
 }
 function update(id,input,actor){
  if(!input||typeof input!=='object'||typeof input.status!=='string'||!Object.hasOwn(statuses,input.status)||input.status==='expired')throw new Problem(422,'Выберите статус заказа.');
  const note=text(input.note??'','Комментарий',1000),now=Date.now();
  db.exec('BEGIN IMMEDIATE');
  try{
   expireWithin(now);const current=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!current)throw new Problem(404,'Заказ не найден.');
   if(current.status===input.status){const result=detail(id,{skipExpire:true});db.exec('COMMIT');return result}
   if(current.version!==input.version)throw new Problem(409,'Заказ уже изменён. Обновите карточку перед сменой статуса.');
   if(!transitions[current.status].includes(input.status))throw new Problem(409,'Этот переход статуса недоступен. Отправленные и завершённые заказы нельзя отменить через эту кнопку.');
   if(current.status==='confirmed'&&['shipped','completed'].includes(input.status)){
    const held=db.prepare('SELECT sku,qty FROM reservations WHERE order_id=?').all(id);
    const count=db.prepare('SELECT count(*) AS n FROM order_items WHERE order_id=?').get(id).n;
    if(held.length!==count)throw new Problem(409,'Резерв заказа изменился. Проверьте остатки перед отправкой.');
    for(const line of held){
     const result=db.prepare('UPDATE variants SET stock=stock-? WHERE sku=? AND stock>=?').run(line.qty,line.sku,line.qty);
     if(!result.changes)throw new Problem(409,'Остатка недостаточно для отправки. Проверьте склад.');
    }
    db.prepare('UPDATE products SET version=version+1,updated_at=? WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?)').run(new Date(now).toISOString(),id);
    db.prepare('DELETE FROM reservations WHERE order_id=?').run(id);
   }
   if(input.status==='cancelled')db.prepare('DELETE FROM reservations WHERE order_id=?').run(id);
   db.prepare('UPDATE orders SET status=?,reserved_until=NULL,version=version+1,updated_at=? WHERE id=?').run(input.status,now,id);
   event(id,input.status,actor,note,now);const result=detail(id,{skipExpire:true});db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 function list({status='all',search='',page=1}={}){
  expire();if(status!=='all'&&!Object.hasOwn(statuses,status))throw new Problem(422,'Неверный статус.');
  search=text(search,'Поиск',120);const conditions=[],params=[];
  if(status!=='all'){conditions.push('status=?');params.push(status)}
  if(search){const q='%'+search.toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[\\%_]/g,c=>'\\'+c)+'%';conditions.push("(printf('%06d',id) LIKE ? ESCAPE '\\' OR order_fold(json_extract(customer,'$.name')) LIKE ? ESCAPE '\\' OR json_extract(customer,'$.phone') LIKE ? ESCAPE '\\')");params.push(q,q,q)}
  const where=conditions.length?'WHERE '+conditions.join(' AND '):'';
  const total=db.prepare('SELECT count(*) AS n FROM orders '+where).get(...params).n,pages=Math.max(1,Math.ceil(total/25));
  page=Number(page);if(!Number.isSafeInteger(page)||page<1)throw new Problem(422,'Неверный номер страницы.');page=Math.min(page,pages);
  const orders=db.prepare('SELECT * FROM orders '+where+' ORDER BY id DESC LIMIT 25 OFFSET ?').all(...params,(page-1)*25).map(row=>{const customer=JSON.parse(row.customer);return {...receipt(row),customer:{name:customer.name,phone:customer.phone},qty:db.prepare('SELECT sum(qty) AS n FROM order_items WHERE order_id=?').get(row.id).n}});
  const counts=Object.fromEntries(db.prepare('SELECT status,count(*) AS n FROM orders GROUP BY status').all().map(r=>[r.status,r.n]));
  return {orders,total,page,pages,statuses,counts};
 }
 return {create,detail,update,list,findReceipt,expire,reserved,reserveHours};
}
