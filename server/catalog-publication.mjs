// Applies the owner's explicit, versioned publication decision once, after draft import.
import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync} from 'node:fs';

const SOURCE={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function invalid(message){throw new Error('Invalid catalog publication: '+message)}
function keys(value,allowed,label){
 if(!object(value)||Object.keys(value).length!==allowed.length||Object.keys(value).some(key=>!allowed.includes(key)))invalid(label+' has an unsupported shape.');
}
function readPlan(path){
 let stat;
 try{stat=lstatSync(path)}catch(error){if(error.code==='ENOENT')return null;throw error}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024)invalid('plan must be a bounded regular file without symlinks.');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 let bytes;
 try{
  const opened=fstatSync(fd);if(!opened.isFile()||opened.size>64*1024)invalid('plan must be a bounded regular file.');
  bytes=readFileSync(fd);if(bytes.length!==opened.size)invalid('plan changed while reading.');
 }finally{closeSync(fd)}
 let plan;try{plan=JSON.parse(bytes.toString('utf8'))}catch{invalid('plan must contain valid JSON.')}
 keys(plan,['version','id','source','externalIds'],'plan');
 if(plan.version!==1||plan.id!=='emall-first-five-2026-11-04')invalid('unsupported decision.');
 keys(plan.source,['provider','environment','account'],'source');
 if(Object.entries(SOURCE).some(([key,value])=>plan.source[key]!==value))invalid('only the approved production catalog can be published.');
 if(!Array.isArray(plan.externalIds)||plan.externalIds.length!==5||new Set(plan.externalIds).size!==5||plan.externalIds.some(id=>typeof id!=='string'||!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))))invalid('expected five distinct canonical source IDs.');
 return {version:1,id:plan.id,source:SOURCE,externalIds:[...plan.externalIds].sort()};
}

export function applyCatalogPublication(store,planPath){
 const plan=readPlan(planPath);if(!plan)return {applied:false,reason:'missing'};
 const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex'),{db}=store;
 const tableExists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_publications'").get();
 const marker=tableExists?db.prepare('SELECT digest FROM catalog_publications WHERE id=?').get(plan.id):null;
 if(marker){
  if(marker.digest!==digest)invalid('an existing decision cannot be changed.');
  return {applied:false,reason:'already-applied',id:plan.id};
 }
 if(db.isTransaction)invalid('publication requires its own transaction.');
 db.exec('BEGIN IMMEDIATE');
 try{
  const products=new Map(store.products(false,{expire:false}).map(product=>[product.id,product]));
  const selected=plan.externalIds.map(externalId=>{
   const link=db.prepare('SELECT product_id FROM import_products WHERE provider=? AND environment=? AND account=? AND external_id=?').get(SOURCE.provider,SOURCE.environment,SOURCE.account,externalId);
   const product=link&&products.get(link.product_id);
   if(!product)invalid('an approved source product is missing.');
   return product;
  });
  if(new Set(selected.map(product=>product.id)).size!==5)invalid('source links do not identify five distinct products.');
  let published=0;
  for(const product of selected){
   if(product.status==='published')continue;
   // saveProduct enforces the same validation, source and reservation rules as admin publication.
   store.saveProduct({...product,status:'published'},product.id,{withinTransaction:true,returnProduct:false});published++;
  }
  db.exec('CREATE TABLE IF NOT EXISTS catalog_publications(id TEXT PRIMARY KEY,digest TEXT NOT NULL,applied_at TEXT NOT NULL)');
  db.prepare('INSERT INTO catalog_publications VALUES(?,?,?)').run(plan.id,digest,new Date().toISOString());
  db.exec('COMMIT');
  return {applied:true,id:plan.id,published,alreadyPublished:5-published};
 }catch(error){db.exec('ROLLBACK');throw error}
}
