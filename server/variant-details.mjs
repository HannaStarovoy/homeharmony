export function initVariantDetails(db){db.exec('CREATE TABLE IF NOT EXISTS variant_details(sku TEXT PRIMARY KEY REFERENCES variants(sku) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT,attrs TEXT)')}
export function migrateVariantDetails(db){
 initVariantDetails(db);if(db.prepare('SELECT 1 FROM migrations WHERE version=6').get())return;
 const origins=new Map(),importNames=new Map();
 for(const row of db.prepare('SELECT before_json,after_json FROM product_history ORDER BY id').all())for(const batch of [JSON.parse(row.before_json),JSON.parse(row.after_json)])for(const item of batch)if(item.variants.length===1)origins.set(item.variants[0].sku,item.product);
 for(const row of db.prepare('SELECT result FROM import_runs ORDER BY created_at').all())for(const item of JSON.parse(row.result).items||[])if(item.productId&&item.name)importNames.set(item.productId,item.name);
 const variants=db.prepare(`SELECT v.*,p.name AS parent_name,p.summary,p.attrs AS parent_attrs,p.id AS parent_id,original.id AS original_id,original.name AS original_name,original.summary AS original_summary,original.attrs AS original_attrs FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN import_variants iv ON iv.sku=v.sku LEFT JOIN import_products ip ON ip.provider=iv.provider AND ip.environment=iv.environment AND ip.account=iv.account AND ip.external_id=iv.external_product_id LEFT JOIN products original ON original.id=ip.product_id WHERE p.deleted_at IS NULL AND p.merge_protected=1 AND (SELECT count(*) FROM variants WHERE product_id=p.id)>1`).all();
 db.exec('BEGIN IMMEDIATE');try{
  for(const v of variants){const old=origins.get(v.sku),title=old?.name||(v.original_id!==v.parent_id?v.original_name:importNames.get(v.original_id))||v.parent_name,description=old?.summary??v.original_summary??v.summary,attrs=JSON.parse(old?.attrs||v.original_attrs||v.parent_attrs);for(const key of Object.keys(JSON.parse(v.options)))delete attrs[key];db.prepare('INSERT OR IGNORE INTO variant_details VALUES(?,?,?,?)').run(v.sku,title,description,JSON.stringify(attrs))}
  db.prepare('INSERT INTO migrations VALUES(6)').run();db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}
