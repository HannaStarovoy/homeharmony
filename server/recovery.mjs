import {randomUUID} from 'node:crypto';
import {Problem} from './errors.mjs';
export function initRecovery(db){db.exec(`CREATE TABLE IF NOT EXISTS product_history(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created_at TEXT NOT NULL,undone INTEGER NOT NULL DEFAULT 0)`)}
export function snapshot(db,ids){return ids.map(id=>({product:db.prepare('SELECT * FROM products WHERE id=?').get(id),variants:db.prepare('SELECT v.*,d.title AS item_title FROM variants v LEFT JOIN variant_details d ON d.sku=v.sku WHERE v.product_id=? ORDER BY v.position').all(id)})).filter(x=>x.product)}
export function recordHistory(db,kind,before,after){db.prepare('INSERT INTO product_history(kind,before_json,after_json,created_at) VALUES(?,?,?,?)').run(kind,JSON.stringify(before),JSON.stringify(after),new Date().toISOString())}
export function recoveryTools(store){
 const {db,orders}=store;
 function transaction(fn){orders.expire();db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
 function current(id,version,deleted=false){const p=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!p||!!p.deleted_at!==deleted)throw new Problem(404,'Товар не найден.');if(!Number.isSafeInteger(version)||p.version!==version)throw new Problem(409,'Товар изменился. Обновите список.');return p}
 function list(){
  const trash=db.prepare('SELECT id,name,version,deleted_at FROM products WHERE deleted_at IS NOT NULL AND EXISTS(SELECT 1 FROM variants WHERE product_id=products.id) ORDER BY deleted_at DESC').all();
  const history=db.prepare('SELECT * FROM product_history ORDER BY id DESC LIMIT 200').all().map(row=>{
   const before=JSON.parse(row.before_json),after=JSON.parse(row.after_json),old=new Map(before.flatMap(x=>x.variants.map(v=>[v.sku,v])));
   const changes=after.flatMap(x=>x.variants.filter(v=>{const prev=old.get(v.sku);return prev&&(prev.price_cents!==v.price_cents||prev.old_cents!==v.old_cents||prev.stock!==v.stock)}).map(v=>({name:v.item_title||x.product.name,sku:v.sku,before:{price:old.get(v.sku).price_cents/100,old:old.get(v.sku).old_cents/100,stock:old.get(v.sku).stock},after:{price:v.price_cents/100,old:v.old_cents/100,stock:v.stock}})));
   return {id:row.id,kind:row.kind,time:row.created_at,undone:!!row.undone,names:after.map(x=>x.product.name),changes};
  });
  const last=db.prepare("SELECT id,undone FROM product_history WHERE kind='bulk-price' ORDER BY id DESC LIMIT 1").get();return {trash,history,lastPrice: last&&!last.undone?last.id:null};
 }
 function restore(input){return transaction(()=>{const p=current(input?.id,input?.version,true),before=snapshot(db,[p.id]);if(!before[0].variants.length)throw new Problem(409,'Варианты этой карточки уже объединены с другой моделью.');db.prepare("UPDATE products SET deleted_at=NULL,status='draft',version=version+1,updated_at=? WHERE id=?").run(new Date().toISOString(),p.id);recordHistory(db,'restore',before,snapshot(db,[p.id]));return {ok:true}})}
 function split(input){return transaction(()=>{
  const p=current(input?.id,input?.version),before=snapshot(db,[p.id]),variants=before[0].variants;if(variants.length<2)throw new Problem(422,'У товара только один вариант.');if(variants.some(v=>orders.reserved(v.sku)>0))throw new Problem(409,'Сначала обработайте активные резервы этой модели.');
  const ids=[];for(const [i,v] of variants.entries()){
   const id=i?randomUUID():p.id,options=Object.values(JSON.parse(v.options)).join(' · '),detail=db.prepare('SELECT * FROM variant_details WHERE sku=?').get(v.sku),name=detail?.title||(p.name+' — '+(options||v.name||v.sku)).slice(0,200),images=JSON.parse(v.images).length?v.images:p.images;
   if(i){const row={...p,id,name,images,summary:detail?.description??p.summary,attrs:detail?.attrs??p.attrs,version:1,merge_protected:1,updated_at:new Date().toISOString()};const keys=Object.keys(row);db.prepare('INSERT INTO products('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]))}
   else db.prepare('UPDATE products SET name=?,images=?,summary=?,attrs=?,version=version+1,merge_protected=1,updated_at=? WHERE id=?').run(name,images,detail?.description??p.summary,detail?.attrs??p.attrs,new Date().toISOString(),id);
   db.prepare('UPDATE variants SET product_id=?,position=0 WHERE sku=?').run(id,v.sku);db.prepare('DELETE FROM variant_details WHERE sku=?').run(v.sku);ids.push(id);
  }
  recordHistory(db,'split',before,snapshot(db,ids));return {ok:true,count:ids.length};
 })}
 function undoPrice(input){return transaction(()=>{
  const last=db.prepare("SELECT * FROM product_history WHERE kind='bulk-price' ORDER BY id DESC LIMIT 1").get();if(!last||last.undone||last.id!==input?.id)throw new Problem(409,'Последняя операция изменилась. Обновите историю.');
  const before=JSON.parse(last.before_json),after=JSON.parse(last.after_json);for(const row of after){current(row.product.id,row.product.version);for(const v of row.variants){const owner=db.prepare('SELECT product_id FROM variants WHERE sku=?').get(v.sku);if(owner?.product_id!==row.product.id)throw new Problem(409,'Состав товаров изменился. Отмена невозможна.')}}
  const previous=snapshot(db,after.map(x=>x.product.id));for(const row of before){for(const v of row.variants)db.prepare('UPDATE variants SET price_cents=?,old_cents=? WHERE sku=? AND product_id=?').run(v.price_cents,v.old_cents,v.sku,row.product.id);db.prepare('UPDATE products SET version=version+1,updated_at=? WHERE id=?').run(new Date().toISOString(),row.product.id)}
  db.prepare('UPDATE product_history SET undone=1 WHERE id=?').run(last.id);recordHistory(db,'undo-price',previous,snapshot(db,before.map(x=>x.product.id)));return {ok:true};
 })}
 return {list,restore,split,undoPrice};
}
