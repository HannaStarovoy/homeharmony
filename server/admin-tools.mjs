import {randomUUID} from 'node:crypto';
import {Problem} from './errors.mjs';
import {snapshot,recordHistory} from './recovery.mjs';
export function createAdminTools(store){
 const {db,orders}=store;
 db.exec('CREATE TABLE IF NOT EXISTS saved_views(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,filters TEXT NOT NULL,created_at TEXT NOT NULL)');
 const listViews=()=>db.prepare('SELECT * FROM saved_views ORDER BY name COLLATE NOCASE').all().map(row=>({...row,filters:JSON.parse(row.filters)}));
 function saveView(input){
  if(typeof input?.name!=='string'||!input.name.trim()||input.name.length>80)throw new Problem(422,'Назовите подборку (до 80 символов).');
  const f=input.filters;if(!f||typeof f!=='object'||Array.isArray(f)||typeof f.search!=='string'||f.search.length>200||!['all','draft','published'].includes(f.status)||!store.categories().some(c=>c.id===f.category)||!['new','changed','name','price-asc','price-desc','stock-asc','stock-desc'].includes(f.sort)||!Number.isInteger(f.threshold)||f.threshold<0||f.threshold>1000000||typeof f.review!=='boolean'||typeof f.lowStock!=='boolean')throw new Problem(422,'Некорректные фильтры подборки.');
  if(db.prepare('SELECT 1 FROM saved_views WHERE name=?').get(input.name.trim()))throw new Problem(409,'Подборка с таким названием уже есть.');
  const filters={search:f.search,status:f.status,category:f.category,sort:f.sort,threshold:f.threshold,review:f.review,lowStock:f.lowStock},id=randomUUID();db.prepare('INSERT INTO saved_views VALUES(?,?,?,?)').run(id,input.name.trim(),JSON.stringify(filters),new Date().toISOString());return {id};
 }
 function deleteView(id){if(typeof id!=='string'||!db.prepare('DELETE FROM saved_views WHERE id=?').run(id).changes)throw new Problem(404,'Подборка не найдена.');return {ok:true}}
 function saveRows(input){
  if(!Array.isArray(input?.edits)||!input.edits.length||input.edits.length>5000)throw new Problem(422,'Укажите изменённые строки.');
  orders.expire();db.exec('BEGIN IMMEDIATE');try{
   const all=new Map(store.products(false,{expire:false}).map(p=>[p.id,p])),groups=new Map(),seen=new Set();
   for(const edit of input.edits){const p=all.get(edit?.productId);if(!p||!Number.isSafeInteger(edit.version)||edit.version!==p.version)throw new Problem(409,'Один из товаров уже изменён. Обновите список перед сохранением.');if(typeof edit.sku!=='string'||seen.has(edit.sku)||!p.variants.some(v=>v.sku===edit.sku))throw new Problem(422,'Проверьте артикулы изменённых строк.');seen.add(edit.sku);if(!groups.has(p.id))groups.set(p.id,new Map());groups.get(p.id).set(edit.sku,{price:edit.price,old:edit.old,stock:edit.stock})}
   const ids=[...groups.keys()],before=snapshot(db,ids);for(const [id,edits] of groups){const p=all.get(id);store.saveProduct({...p,variants:p.variants.map(v=>edits.has(v.sku)?{...v,...edits.get(v.sku)}:v)},id,{withinTransaction:true,returnProduct:false})}
   recordHistory(db,'inline-batch',before,snapshot(db,ids));db.exec('COMMIT');return {ok:true,rows:seen.size};
  }catch(error){db.exec('ROLLBACK');throw error}
 }
 return {listViews,saveView,deleteView,saveRows};
}
