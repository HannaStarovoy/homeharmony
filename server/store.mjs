import {initRecovery,snapshot,recordHistory,recoveryTools} from './recovery.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Problem } from './errors.mjs';
import { createOrderStore } from './orders.mjs';
import { createImportStore } from './imports.mjs';
import { loadDraftBundle } from './draft-bundle.mjs';
import { updateCategories } from './category-update.mjs';
import { applyCatalogPublication } from './catalog-publication.mjs';
export { Problem } from './errors.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const json = value => JSON.stringify(value);
export function openStore(dataDir = process.env.SHOP_DATA_DIR || join(root, 'var'), {reserveHours=Number(process.env.SHOP_RESERVE_HOURS||24),draftBundleDir=null,publicationPlanPath=null,massBundleDir=null}={}) {
  dataDir = resolve(dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const uploadDir = join(dataDir, 'uploads');
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, 'shop.sqlite');
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT REFERENCES categories(id));
    CREATE TABLE IF NOT EXISTS products(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id),
      summary TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}', images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('draft','published')), type TEXT NOT NULL DEFAULT 'generic',
      tag TEXT NOT NULL DEFAULT '', popularity INTEGER NOT NULL DEFAULT 0, date_rank INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS product_status ON products(status, category_id);
    CREATE TABLE IF NOT EXISTS variants(
      sku TEXT PRIMARY KEY COLLATE NOCASE, product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL, options TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents>=0),
      old_cents INTEGER NOT NULL DEFAULT 0 CHECK(old_cents>=0), stock INTEGER NOT NULL CHECK(stock>=0),
      color TEXT NOT NULL, images TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS variants_product ON variants(product_id, position);
    CREATE TABLE IF NOT EXISTS admins(email TEXT PRIMARY KEY, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES admins(email), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_limits(address TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS media(url TEXT PRIMARY KEY, filename TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL);
  `);
  if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='deleted_at'))db.exec('ALTER TABLE products ADD COLUMN deleted_at TEXT');
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=1').get()) {
    // A JSON assignment is also readable by a static browser; no execution of the seed file.
    const source = readFileSync(join(root, 'catalog-data.js'), 'utf8');
    const seed = JSON.parse(source.slice(source.indexOf('window.catalogData = ') + 'window.catalogData = '.length).trim().replace(/;$/, ''));
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of seed.categories) db.prepare('INSERT INTO categories VALUES(?,?,?)').run(c.id, c.name, c.parent);
      for (const p of seed.products) {
        db.prepare('INSERT INTO products(id,name,category_id,summary,attrs,images,status,type,tag,popularity,date_rank,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(p.id,p.name,p.cat,p.summary,json(p.attrs),json(p.images||[]),'published',p.type,p.tag,p.pop,p.date,new Date().toISOString());
        p.variants.forEach((v,i) => db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(v.sku,p.id,v.name,json(v.options),Math.round((v.price??p.price)*100),Math.round((v.old??p.old??0)*100),v.stock,v.color||'#cad6e8',json(v.images||[]),i));
      }
      db.prepare('INSERT INTO migrations VALUES(1)').run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  }
  if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='merge_protected'))db.exec('ALTER TABLE products ADD COLUMN merge_protected INTEGER NOT NULL DEFAULT 0');
  initRecovery(db);
  const orders=createOrderStore(db,{reserveHours});
  const categories = () => db.prepare('SELECT id,name,parent FROM categories ORDER BY rowid').all().map(c => ({...c}));
  function products(publishedOnly = false,{expire=true}={}) {
    if(expire)orders.expire();
    const rows = db.prepare(`SELECT * FROM products WHERE deleted_at IS NULL ${publishedOnly ? "AND status='published'" : ''} ORDER BY date_rank DESC, id`).all();
    const variants = db.prepare('SELECT * FROM variants ORDER BY position').all();
    const emallIds=new Map(db.prepare("SELECT product_id,external_id FROM import_products WHERE provider='emall'").all().map(row=>[row.product_id,row.external_id]));
    const sources=new Map(db.prepare('SELECT sku,external_sku,external_product_id FROM import_variants').all().map(row=>[row.sku,row]));
    const byProduct = new Map();
    for (const v of variants) {
      if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
      byProduct.get(v.product_id).push({sku:v.sku,name:v.name,options:JSON.parse(v.options),price:v.price_cents/100,old:v.old_cents/100,stock:publishedOnly?Math.max(0,v.stock-orders.reserved(v.sku)):v.stock,...(publishedOnly?{}:{reserved:orders.reserved(v.sku),available:Math.max(0,v.stock-orders.reserved(v.sku))}),color:v.color,images:JSON.parse(v.images),...(sources.has(v.sku)?{externalSku:sources.get(v.sku).external_sku,sourceManaged:true,...(!publishedOnly?{emallProductId:sources.get(v.sku).external_product_id}:{})}:{})});
    }
    return rows.map(p => {
      const list = byProduct.get(p.id) || [];
      const value = {id:p.id,name:p.name,cat:p.category_id,summary:p.summary,attrs:Object.fromEntries(Object.entries(JSON.parse(p.attrs)).filter(([key])=>!/импорт[её]р|importer/iu.test(key))),images:JSON.parse(p.images),type:p.type,tag:p.tag,pop:p.popularity,date:p.date_rank,price:Math.min(...list.map(v=>v.price)),old:list[0]?.old||0,variants:list};
      return publishedOnly ? value : {...value,status:p.status,version:p.version,updatedAt:p.updated_at,...(emallIds.has(p.id)?{emallId:emallIds.get(p.id)}:{})};
    });
  }
  function saveProduct(input,id,{withinTransaction=false,returnProduct=true}={}) {
    if(withinTransaction&&!db.isTransaction)throw new Error('An import requires an active transaction.');
    if(!withinTransaction)orders.expire();
    const value = validateProduct(input, categories(), db);
    if(!withinTransaction)db.exec('BEGIN IMMEDIATE');
    try {
      const current = id ? db.prepare('SELECT version,type,tag,popularity,date_rank FROM products WHERE id=? AND deleted_at IS NULL').get(id) : null;
      if (id && !current) throw new Problem(404, 'Товар не найден.');
      if (current && input.version !== current.version) throw new Problem(409, 'Товар уже изменён в другом окне. Откройте его заново перед сохранением.');
      const productId = id || randomUUID();
      const historyBefore=snapshot(db,[productId]);
      for (const v of value.variants) {
        const owner = db.prepare('SELECT product_id FROM variants WHERE sku=?').get(v.sku);
        if (owner && owner.product_id !== productId) throw new Problem(409, `Артикул ${v.sku} уже используется другим товаром.`, 'variants');
      }
      const source=db.prepare('SELECT environment FROM import_products WHERE product_id=?').get(productId);
      if(source?.environment==='sandbox'&&value.status==='published')throw new Problem(409,'Тестовый товар Emall нельзя публиковать в рабочем каталоге.');
      if(current){
        const existing=db.prepare('SELECT sku,options FROM variants WHERE product_id=?').all(productId);
        for(const old of existing){
          const hold=orders.reserved(old.sku),replacement=value.variants.find(v=>v.sku===old.sku);
          if(!replacement&&db.prepare('SELECT 1 FROM import_variants WHERE sku=?').get(old.sku))throw new Problem(409,'Артикул связан с источником импорта. Уберите товар с витрины вместо удаления связанного SKU.');
          if(hold&&!replacement)throw new Problem(409,'Нельзя удалить вариант: он зарезервирован в заказе.');
          if(replacement&&replacement.stock<hold)throw new Problem(409,`Физический остаток ${old.sku} не может быть меньше резерва (${hold} шт.).`);
          const canonical=object=>JSON.stringify(Object.keys(object).sort().map(k=>[k,object[k]]));
          if(hold&&canonical(JSON.parse(old.options))!==canonical(replacement.options))throw new Problem(409,'Нельзя менять параметры SKU, пока по нему есть резерв.');
        }
      }
      if (current) {
        db.prepare('UPDATE products SET name=?,category_id=?,summary=?,attrs=?,images=?,status=?,version=version+1,updated_at=? WHERE id=?')
          .run(value.name,value.cat,value.summary,json(value.attrs),json(value.images),value.status,new Date().toISOString(),productId);
        const keep=new Set(value.variants.map(v=>v.sku));
        for(const row of db.prepare('SELECT sku FROM variants WHERE product_id=?').all(productId))if(!keep.has(row.sku))db.prepare('DELETE FROM variants WHERE sku=?').run(row.sku);
      } else {
        db.prepare('INSERT INTO products(id,name,category_id,summary,attrs,images,status,date_rank,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(productId,value.name,value.cat,value.summary,json(value.attrs),json(value.images),value.status,Date.now(),new Date().toISOString());
      }
      value.variants.forEach((v,i)=>db.prepare('INSERT INTO variants VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,options=excluded.options,price_cents=excluded.price_cents,old_cents=excluded.old_cents,stock=excluded.stock,color=excluded.color,images=excluded.images,position=excluded.position').run(v.sku,productId,v.name,json(v.options),v.priceCents,v.oldCents,v.stock,v.color,json(v.images),i));
      recordHistory(db,'edit',historyBefore,snapshot(db,[productId]));
      if(!withinTransaction)db.exec('COMMIT');
      return returnProduct?products(false,{expire:false}).find(p=>p.id===productId):db.prepare('SELECT id,version FROM products WHERE id=?').get(productId);
    } catch (error) { if(!withinTransaction)db.exec('ROLLBACK'); throw error; }
  }
  function deleteProduct(id,version,{withinTransaction=false}={}){
    if(withinTransaction&&!db.isTransaction)throw new Error('A batch delete requires an active transaction.');
    if(!Number.isSafeInteger(version)||version<1)throw new Problem(422,'Обновите список товаров перед удалением.');
    if(!withinTransaction){orders.expire();db.exec('BEGIN IMMEDIATE')}
    try{
      const historyBefore=snapshot(db,[id]);
      const product=db.prepare('SELECT version FROM products WHERE id=? AND deleted_at IS NULL').get(id);
      if(!product)throw new Problem(404,'Товар не найден.');
      if(product.version!==version)throw new Problem(409,'Товар уже изменён. Обновите страницу перед удалением.');
      for(const v of db.prepare('SELECT sku FROM variants WHERE product_id=?').all(id))if(orders.reserved(v.sku)>0)throw new Problem(409,'Нельзя удалить товар с активным резервом в заказе. Сначала обработайте или отмените заказ.');
      db.prepare("UPDATE products SET status='draft',deleted_at=?,updated_at=?,version=version+1 WHERE id=?").run(new Date().toISOString(),new Date().toISOString(),id);
      recordHistory(db,'delete',historyBefore,snapshot(db,[id]));
      if(!withinTransaction)db.exec('COMMIT');return {ok:true};
    }catch(error){if(!withinTransaction)db.exec('ROLLBACK');throw error}
  }
  function bulkProducts(input){
    if(!input||!['publish','draft','delete','category','price'].includes(input.action)||!Array.isArray(input.products)||!input.products.length||input.products.length>5000)throw new Problem(422,'Выберите товары и действие.');
    const ids=new Set();for(const item of input.products){if(!item||typeof item.id!=='string'||!Number.isSafeInteger(item.version)||item.version<1||ids.has(item.id))throw new Problem(422,'Некорректный список выбранных товаров.');ids.add(item.id)}
    orders.expire();db.exec('BEGIN IMMEDIATE');
    try{
      const all=new Map(products(false,{expire:false}).map(p=>[p.id,p]));
      const chosen=input.products.map(item=>{const p=all.get(item.id);if(!p)throw new Problem(409,'Один из выбранных товаров удалён. Обновите список.');if(p.version!==item.version)throw new Problem(409,'Один из выбранных товаров изменён. Обновите список и выберите товары заново.');return p});
      if(input.action==='category'&&!categories().some(c=>c.id===input.category&&c.id!=='all'))throw new Problem(422,'Выберите категорию.');
      if(input.action==='price'&&(!['amount','percent'].includes(input.mode)||typeof input.amount!=='number'||!Number.isFinite(input.amount)||Math.abs(input.amount)>1000000))throw new Problem(422,'Укажите корректное изменение цены.');
      const historyBefore=snapshot(db,chosen.map(p=>p.id));
      let changed=0;
      for(const p of chosen){
        if(input.action==='delete'){deleteProduct(p.id,p.version,{withinTransaction:true});changed++}
        else if(input.action==='category'){saveProduct({...p,cat:input.category},p.id,{withinTransaction:true,returnProduct:false});changed++}
        else if(input.action==='price'){
          const variants=p.variants.map(v=>{const price=Math.round((input.mode==='percent'?v.price*(1+input.amount/100):v.price+input.amount)*100)/100;if(!Number.isFinite(price)||price<=0)throw new Problem(422,'Новая цена должна быть больше нуля.');return {...v,price,old:v.old}});
          saveProduct({...p,variants},p.id,{withinTransaction:true,returnProduct:false});changed++;
        }
        else{const status=input.action==='publish'?'published':'draft';if(p.status!==status){saveProduct({...p,status},p.id,{withinTransaction:true,returnProduct:false});changed++}}
      }
      if(input.action==='price')recordHistory(db,'bulk-price',historyBefore,snapshot(db,chosen.map(p=>p.id)));
      db.exec('COMMIT');return {ok:true,selected:chosen.length,changed};
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  function mergeProducts(input){
    if(!input||!Array.isArray(input.products)||input.products.length<2||input.products.length>100)throw new Problem(422,'Выберите от 2 до 100 товаров.');
    orders.expire();db.exec('BEGIN IMMEDIATE');
    try{
      const all=new Map(products(false,{expire:false}).map(p=>[p.id,p])),seen=new Set();
      const chosen=input.products.map(item=>{const p=all.get(item?.id);if(!p||seen.has(p.id)||p.version!==item.version)throw new Problem(409,'Список изменился. Обновите товары и выберите заново.');seen.add(p.id);return p});
      if(chosen.some(p=>p.cat!==chosen[0].cat))throw new Problem(422,'Объединяйте товары одной категории.');
      for(const p of chosen){if(db.prepare("SELECT 1 FROM import_products WHERE product_id=? AND environment='sandbox'").get(p.id))throw new Problem(422,'Тестовые товары нельзя объединять.');for(const v of p.variants)if(orders.reserved(v.sku))throw new Problem(409,'Сначала обработайте активные резервы выбранных товаров.');}
      const dimensions=input.dimensions;if(!Array.isArray(dimensions)||!dimensions.length||dimensions.length>5||new Set(dimensions).size!==dimensions.length||dimensions.some(k=>typeof k!=='string'||!k.trim()||k.length>60))throw new Problem(422,'Укажите от 1 до 5 характеристик.');
      const primary=chosen[0],attrs={...primary.attrs};dimensions.forEach(k=>delete attrs[k]);
      const variants=chosen.flatMap(p=>p.variants.map(v=>({...v,options:input.options?.[v.sku],images:v.images.length?v.images:p.images})));
      if(variants.some(v=>!v.options||Object.keys(v.options).sort().join('|')!==[...dimensions].sort().join('|')))throw new Problem(422,'Заполните характеристики каждого варианта.');
      const payload={...primary,name:input.name,attrs,variants,status:chosen.every(p=>p.status==='published')?'published':'draft'};
      validateProduct(payload,categories(),db);
      for(const p of chosen.slice(1))db.prepare('UPDATE variants SET product_id=? WHERE product_id=?').run(primary.id,p.id);
      saveProduct(payload,primary.id,{withinTransaction:true,returnProduct:false});
      const now=new Date().toISOString();for(const p of chosen){db.prepare('UPDATE products SET merge_protected=1 WHERE id=?').run(p.id);if(p.id!==primary.id)db.prepare("UPDATE products SET deleted_at=?,status='draft',version=version+1,updated_at=? WHERE id=?").run(now,now,p.id)}
      recordHistory(db,'merge',[],snapshot(db,[primary.id]));
      db.exec('COMMIT');return {ok:true,id:primary.id,variants:variants.length};
    }catch(error){db.exec('ROLLBACK');throw error}
  }
  function isPublicMedia(url) {
    return !!db.prepare(`SELECT 1 FROM products p,json_each(p.images) i WHERE p.deleted_at IS NULL AND p.status='published' AND i.value=?
      UNION ALL SELECT 1 FROM variants v JOIN products p ON p.id=v.product_id,json_each(v.images) i
      WHERE p.deleted_at IS NULL AND p.status='published' AND i.value=? LIMIT 1`).get(url,url);
  }
  const store={db,dataDir,uploadDir,categories,products,saveProduct,deleteProduct,bulkProducts,mergeProducts,isPublicMedia,orders,close:()=>db.close()};
  store.recovery=recoveryTools(store);
  store.imports=createImportStore(store,validateProduct);
  if(draftBundleDir)loadDraftBundle(store,draftBundleDir);
  if(massBundleDir)loadDraftBundle(store,massBundleDir,{slot:'mass'});
  if(publicationPlanPath)applyCatalogPublication(store,publicationPlanPath);
  updateCategories(db);
  return store;
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Problem(422, `Проверьте поле «${label}» (до ${max} символов).`,label);
  return value.trim();
}
function record(value, label, max = 30) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > max) throw new Problem(422, `Проверьте ${label}.`, label);
  const result = Object.create(null);
  for (const [key,val] of Object.entries(value)) {
    const name = text(key,label,60,true);
    if (['__proto__','prototype','constructor'].includes(name)) throw new Problem(422, 'Недопустимое название характеристики.');
    if (Object.hasOwn(result,name)) throw new Problem(422, 'Названия характеристик должны различаться.');
    result[name] = text(val,name,500,true);
  }
  return result;
}
function cents(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value<0 || value>1_000_000 || Math.abs(value*100-Math.round(value*100))>0.000001) throw new Problem(422, `Проверьте ${label}: число от 0 до 1 000 000, не более двух знаков после запятой.`, 'variants');
  return Math.round(value*100);
}
function photos(value, db) {
  if (!Array.isArray(value) || value.length>8 || new Set(value).size!==value.length) throw new Problem(422, 'Разрешено до 8 разных фотографий для товара или варианта.', 'images');
  return value.map(url=>{
    if (typeof url!=='string' || !db.prepare('SELECT 1 FROM media WHERE url=?').get(url)) throw new Problem(422, 'Фотография не найдена. Загрузите её заново.', 'images');
    return url;
  });
}
export function validateProduct(input, categories, db) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new Problem(422, 'Неверные данные товара.');
  const name = text(input.name,'Название',200,true), summary=text(input.summary??'','Описание',10000);
  if (!categories.some(c=>c.id===input.cat && c.id!=='all')) throw new Problem(422, 'Выберите категорию товара.', 'cat');
  if (!['draft','published'].includes(input.status)) throw new Problem(422, 'Неверный статус товара.');
  const attrs=record(input.attrs??{},'Характеристики');
  const images=photos(input.images??[],db);
  if (!Array.isArray(input.variants) || input.variants.length<1 || input.variants.length>100) throw new Problem(422,'Укажите от 1 до 100 вариантов товара.', 'variants');
  const seenSku=new Set(), combinations=new Set();let dimensionKeys;
  const variants=input.variants.map(v=>{
    if (!v || typeof v!=='object') throw new Problem(422,'Неверный вариант товара.');
    const sku=text(v.sku,'Артикул',64,true).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(sku) || seenSku.has(sku)) throw new Problem(422, 'Артикулы должны быть уникальными и содержать латинские буквы, цифры, точки, дефисы или подчёркивания.', 'variants');
    seenSku.add(sku);
    const options=record(v.options??{},'Варианты',5);
    const keys=Object.keys(options).sort();
    if (dimensionKeys && json(dimensionKeys)!==json(keys)) throw new Problem(422,'У всех вариантов должен быть одинаковый набор полей выбора.', 'variants');
    dimensionKeys=keys;
    if (keys.some(k=>Object.hasOwn(attrs,k))) throw new Problem(422, 'Характеристика товара не должна дублировать поле выбора варианта.', 'attrs');
    const combination=json(keys.map(k=>[k,options[k]]));
    if (combinations.has(combination)) throw new Problem(422,'Сочетания параметров вариантов должны различаться.', 'variants');
    combinations.add(combination);
    const priceCents=cents(v.price,'цену'),oldCents=cents(v.old??0,'старую цену');
    if (input.status==='published' && priceCents===0) throw new Problem(422,'Перед публикацией укажите цену больше нуля для каждого варианта.', 'variants');
    if (!Number.isSafeInteger(v.stock) || v.stock<0 || v.stock>1_000_000) throw new Problem(422,'Остаток — целое число от 0 до 1 000 000.', 'variants');
    const color=v.color??'#cad6e8';
    if (typeof color!=='string' || !/^#[a-f0-9]{6}$/i.test(color)) throw new Problem(422,'Проверьте цвет варианта.', 'variants');
    return {sku,name:Object.values(options).join(' · ')||'Стандартный',options,priceCents,oldCents,stock:v.stock,color,images:photos(v.images??[],db)};
  });
  return {name,cat:input.cat,summary,attrs,images,status:input.status,variants};
}
