// Local import engine. The official Emall HTTP adapter is intentionally not guessed here.
import { createHash,randomUUID } from 'node:crypto';
import { Problem } from './errors.mjs';
const stringify=value=>JSON.stringify(value);
const digest=value=>createHash('sha256').update(stringify(value)).digest('hex');
function text(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Problem(422,`Проверьте ${label}.`);return value.trim()}
function sourceKey(input){
 if(!input||input.provider!=='emall'||!['sandbox','production'].includes(input.environment))throw new Problem(422,'Укажите Emall и среду sandbox или production.');
 return {provider:'emall',environment:input.environment,account:text(input.account,'идентификатор каталога продавца',120)};
}
const equal=(left,right)=>digest(canonical(left))===digest(canonical(right));
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value}
function comparable(product){return {name:product.name,cat:product.cat,summary:product.summary,attrs:product.attrs,images:product.images||[],status:product.status,variants:product.variants.map(v=>({sku:v.sku,price:v.price,old:v.old||0,stock:v.stock,color:v.color||'#cad6e8',images:v.images||[],options:v.options})).sort((a,b)=>a.sku.localeCompare(b.sku,'en'))}}
export function createImportStore(store,validateProduct){
 const {db}=store;
 db.exec(`CREATE TABLE IF NOT EXISTS import_products(
  provider TEXT NOT NULL,environment TEXT NOT NULL,account TEXT NOT NULL,external_id TEXT NOT NULL,
  product_id TEXT NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,imported_at TEXT NOT NULL,
  PRIMARY KEY(provider,environment,account,external_id));
 CREATE TABLE IF NOT EXISTS import_variants(
  provider TEXT NOT NULL,environment TEXT NOT NULL,account TEXT NOT NULL,external_product_id TEXT NOT NULL,external_id TEXT NOT NULL,
  external_sku TEXT NOT NULL,sku TEXT NOT NULL UNIQUE COLLATE NOCASE REFERENCES variants(sku) ON DELETE CASCADE,
  source_stock INTEGER NOT NULL,imported_at TEXT NOT NULL,
  PRIMARY KEY(provider,environment,account,external_product_id,external_id));
 CREATE TABLE IF NOT EXISTS import_runs(id TEXT PRIMARY KEY,provider TEXT NOT NULL,environment TEXT NOT NULL,account TEXT NOT NULL,created_at TEXT NOT NULL,result TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(3);`);
 const scope=source=>[source.provider,source.environment,source.account];
 function build(records,input,{limit=5}={}){
  const source=sourceKey(input);
  if(!Array.isArray(records)||records.length>5000)throw new Problem(422,'Ожидается нормализованный каталог до 5000 товаров.');
  if(!Number.isSafeInteger(limit)||limit<1||limit>5000)throw new Problem(422,'Лимит импорта должен быть от 1 до 5000.');
  const chosen=records.slice(0,limit),ids=new Set(),locals=new Map(store.products(false,{expire:false}).map(p=>[p.id,p]));
  const plans=[];
  for(const record of chosen){
   if(!record||typeof record!=='object'||Array.isArray(record))throw new Problem(422,'Некорректный товар импорта.');
   const externalId=text(record.externalId,'ID товара источника');
   if(ids.has(externalId))throw new Problem(422,'В одной партии повторяется ID товара источника.');ids.add(externalId);
   const link=db.prepare('SELECT product_id FROM import_products WHERE provider=? AND environment=? AND account=? AND external_id=?').get(...scope(source),externalId);
   const current=link?locals.get(link.product_id):null;
   if(link&&!current)throw new Problem(409,'Связанный товар не найден. Восстановите связь импорта.');
   if(record.attrs!==undefined&&(!record.attrs||typeof record.attrs!=='object'||Array.isArray(record.attrs)))throw new Problem(422,'Характеристики должны быть словарём значений.');
   if(!Array.isArray(record.variants)||!record.variants.length)throw new Problem(422,`Нет вариантов у товара ${externalId}.`);
   const idsV=new Set(),warnings=[],links=[];
   const imported=record.variants.map(v=>{
    const remoteId=text(v?.externalId,'ID варианта источника');
    if(idsV.has(remoteId))throw new Problem(422,'В товаре повторяется ID варианта источника.');idsV.add(remoteId);
    if(!Number.isSafeInteger(v.stock)||v.stock<0||v.stock>1_000_000)throw new Problem(422,'Количество источника должно быть явным целым числом, а не отсутствующим значением.');
    const externalSku=v.externalSku===undefined||v.externalSku===''?'':text(v.externalSku,'артикул источника',200);
    const oldLink=db.prepare('SELECT sku FROM import_variants WHERE provider=? AND environment=? AND account=? AND external_product_id=? AND external_id=?').get(...scope(source),externalId,remoteId);
    const sku=oldLink?.sku||'EMALL-'+(source.environment==='sandbox'?'S-':'P-')+digest([...scope(source),externalId,remoteId]).slice(0,24).toUpperCase();
    const previous=current?.variants.find(value=>value.sku===sku);
    if(previous&&previous.stock!==v.stock)warnings.push({code:'LOCAL_STOCK_PRESERVED',externalVariantId:remoteId,sourceStock:v.stock,localStock:previous.stock});
    links.push({externalId:remoteId,externalSku,sku,sourceStock:v.stock});
    // A repeated import is not a multi-channel inventory synchronizer: preserve local sales/reserves.
    return {sku,options:v.options??previous?.options??{},price:v.price,old:v.old??previous?.old??0,stock:previous?previous.stock:v.stock,color:v.color??previous?.color??'#cad6e8',images:v.images??previous?.images??[]};
   });
   const importedSkus=new Set(imported.map(v=>v.sku));
   const retained=(current?.variants||[]).filter(v=>!importedSkus.has(v.sku));
   if(retained.length)warnings.push({code:'EXISTING_VARIANTS_RETAINED',count:retained.length});
   const payload={name:text(record.name,'название товара'),cat:current?.cat||record.cat,summary:record.summary??current?.summary??'',attrs:{...current?.attrs,...record.attrs},images:record.images??current?.images??[],status:current?.status||'draft',variants:[...imported,...retained],...(current?{version:current.version}:{})};
   const normalized=validateProduct(payload,store.categories(),db);
   Object.assign(payload,{name:normalized.name,cat:normalized.cat,summary:normalized.summary,attrs:normalized.attrs,images:normalized.images,variants:normalized.variants.map(v=>({sku:v.sku,options:v.options,price:v.priceCents/100,old:v.oldCents/100,stock:v.stock,color:v.color,images:v.images}))});
   if(!payload.images.length&&!payload.variants.some(v=>v.images.length))warnings.push({code:'NO_LOCAL_PHOTOS'});
   plans.push({externalId,productId:current?.id||null,action:!current?'create':equal(comparable(current),comparable(payload))?'unchanged':'update',payload,links,warnings});
  }
  return {source,selected:chosen.length,remaining:Math.max(0,records.length-chosen.length),plans};
 }
 function report(plan){return {source:plan.source,selected:plan.selected,remaining:plan.remaining,created:plan.plans.filter(p=>p.action==='create').length,updated:plan.plans.filter(p=>p.action==='update').length,unchanged:plan.plans.filter(p=>p.action==='unchanged').length,items:plan.plans.map(p=>({externalId:p.externalId,productId:p.productId,name:p.payload.name,action:p.action,variants:p.links.map(v=>({externalId:v.externalId,externalSku:v.externalSku,localSku:v.sku})),warnings:p.warnings}))}}
 function preview(records,source,options){return report(build(records,source,options))}
 function apply(records,source,options){
  store.orders.expire();db.exec('BEGIN IMMEDIATE');
  try{
   const plan=build(records,source,options),now=new Date().toISOString();
   for(const item of plan.plans){
    if(item.action!=='unchanged'){
     const saved=store.saveProduct(item.payload,item.productId||undefined,{withinTransaction:true,returnProduct:false});item.productId=saved.id;
    }
    db.prepare('INSERT INTO import_products VALUES(?,?,?,?,?,?) ON CONFLICT(provider,environment,account,external_id) DO UPDATE SET imported_at=excluded.imported_at').run(...scope(plan.source),item.externalId,item.productId,now);
    for(const v of item.links)db.prepare('INSERT INTO import_variants VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(provider,environment,account,external_product_id,external_id) DO UPDATE SET external_sku=excluded.external_sku,source_stock=excluded.source_stock,imported_at=excluded.imported_at')
     .run(...scope(plan.source),item.externalId,v.externalId,v.externalSku,v.sku,v.sourceStock,now);
   }
   const result={id:randomUUID(),...report(plan),appliedAt:now};
   db.prepare('INSERT INTO import_runs VALUES(?,?,?,?,?,?)').run(result.id,...scope(plan.source),now,stringify(result));
   db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 return {preview,apply};
}
