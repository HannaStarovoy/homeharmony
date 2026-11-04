// Versioned, normalized catalog data only. Loading never contacts Emall or publishes a product.
import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const SOURCE={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
const MAX_IMAGE_BYTES=10*1024*1024,MAX_BUNDLE_BYTES=512*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
function invalid(message){throw new Error('Invalid Emall draft bundle: '+message)}
function keys(value,allowed,label){
 if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid(label+' has an unsupported shape.');
}
function text(value,max,label){if(typeof value!=='string'||!value.trim()||value.length>max)invalid(label+' must be a nonempty string.');return value.trim()}
function dictionary(value={},max,label){
 if(!object(value)||Object.keys(value).length>max)invalid(label+' must be a dictionary.');
 const result=Object.create(null);
 for(const [key,valueText] of Object.entries(value)){
  const name=text(key,60,label);
  if(['__proto__','prototype','constructor'].includes(name)||Object.hasOwn(result,name))invalid(label+' has an invalid key.');
  result[name]=text(valueText,500,label);
 }
 return result;
}
function images(value=[],declared,used){
 if(!Array.isArray(value)||value.length>8||new Set(value).size!==value.length)invalid('photos must contain at most eight distinct local URLs.');
 for(const url of value){if(typeof url!=='string'||!declared.has(url))invalid('a photo is not declared in local media.');used.add(url)}
}
function money(value,label){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1_000_000||Math.abs(value*100-Math.round(value*100))>0.000001)invalid(label+' must be a valid price.');return value}
function validateProducts(products,media,store){
 if(!Array.isArray(products)||products.length<1||products.length>5000)invalid('expected one to 5000 products.');
 const declared=new Set(media.map(item=>item.url)),used=new Set(),ids=new Set(),categories=new Set(store.categories().filter(c=>c.id!=='all').map(c=>c.id));
 for(const product of products){
  keys(product,['externalId','name','cat','summary','attrs','images','status','variants'],'product');
  const id=text(product.externalId,200,'product ID');if(ids.has(id))invalid('product IDs repeat.');ids.add(id);
  text(product.name,200,'product name');
  if(!categories.has(product.cat))invalid('product category does not exist.');
  if(product.summary!==undefined&&(typeof product.summary!=='string'||product.summary.length>10000))invalid('product summary is invalid.');
  if(product.status!==undefined&&product.status!=='draft')invalid('bundle products must be drafts.');
  const attrs=dictionary(product.attrs,30,'attributes');images(product.images,declared,used);
  if(!Array.isArray(product.variants)||product.variants.length<1||product.variants.length>100)invalid('expected one to 100 variants.');
  const variantIds=new Set(),combinations=new Set();let dimensions;
  for(const variant of product.variants){
   keys(variant,['externalId','externalSku','options','price','old','stock','color','images'],'variant');
   const variantId=text(variant.externalId,200,'variant ID');if(variantIds.has(variantId))invalid('variant IDs repeat.');variantIds.add(variantId);
   if(variant.externalSku!==undefined&&variant.externalSku!=='')text(variant.externalSku,200,'source article');
   const options=dictionary(variant.options,5,'variant options'),names=Object.keys(options).sort(),signature=JSON.stringify(names);
   if(dimensions!==undefined&&dimensions!==signature)invalid('variant dimensions must agree.');dimensions=signature;
   if(names.some(name=>Object.hasOwn(attrs,name)))invalid('attributes duplicate variant options.');
   const combination=JSON.stringify(names.map(name=>[name,options[name]]));if(combinations.has(combination))invalid('variant combinations repeat.');combinations.add(combination);
   money(variant.price,'price');const old=money(variant.old??0,'old price');if(old&&old<=variant.price)invalid('old price must exceed price.');
   if(!Number.isSafeInteger(variant.stock)||variant.stock<0||variant.stock>1_000_000)invalid('stock must be an explicit nonnegative integer.');
   if(variant.color!==undefined&&(typeof variant.color!=='string'||!/^#[a-f0-9]{6}$/i.test(variant.color)))invalid('variant color is invalid.');
   images(variant.images,declared,used);
  }
 }
 if(used.size!==declared.size)invalid('media contains an unreferenced photo.');
}
function optionalStat(path){try{return lstatSync(path)}catch(error){if(error.code==='ENOENT')return null;throw error}}
function directory(path,label){
 const stat=optionalStat(path);
 if(!stat?.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path))invalid(label+' must be a directory without symlinks.');
}
function readRegular(path,max,label){
 const stat=optionalStat(path);
 if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>max)invalid(label+' must be a bounded regular file without symlinks.');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const opened=fstatSync(fd);if(!opened.isFile()||opened.size>max)invalid(label+' is not a bounded regular file.');
  const bytes=readFileSync(fd);if(bytes.length!==opened.size)invalid(label+' changed while reading.');return bytes;
 }finally{closeSync(fd)}
}
// Sharp writes static WebP. Read its RIFF frame dimensions synchronously; the producer decodes
// and normalizes source images before committing them, and the content hash fixes these bytes.
function webpSize(bytes){
 if(bytes.length<20||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)+8!==bytes.length)invalid('photo is not a complete WebP file.');
 let size=null,canvas=null,position=12;
 while(position<bytes.length){
  if(position+8>bytes.length)invalid('WebP chunk is truncated.');
  const type=bytes.toString('ascii',position,position+4),length=bytes.readUInt32LE(position+4),start=position+8,end=start+length;
  if(end+(length%2)>bytes.length)invalid('WebP chunk exceeds its file.');
  if(type==='VP8X'){
   if(canvas||position!==12||length!==10||(bytes[start]&0xc3)!==0)invalid('WebP must be a static image.');
   canvas={width:bytes.readUIntLE(start+4,3)+1,height:bytes.readUIntLE(start+7,3)+1};
  }else if(type==='VP8 '){
   if(size||length<10||(bytes[start]&1)||bytes.toString('hex',start+3,start+6)!=='9d012a')invalid('WebP frame is invalid.');
   size={width:bytes.readUInt16LE(start+6)&0x3fff,height:bytes.readUInt16LE(start+8)&0x3fff};
  }else if(type==='VP8L'){
   if(size||length<5||bytes[start]!==0x2f||(bytes[start+4]>>5)!==0)invalid('lossless WebP frame is invalid.');
   const bits=bytes.readUInt32LE(start+1);size={width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};
  }else if(type!=='ALPH')invalid('WebP contains unsupported metadata or animation.');
  position=end+(length%2);
 }
 if(!size||size.width<1||size.height<1||size.width>2000||size.height>2000||(canvas&&(canvas.width!==size.width||canvas.height!==size.height)))invalid('WebP dimensions are invalid.');
 return size;
}
function referenced(db,url){return !!db.prepare(`SELECT 1 FROM products p,json_each(p.images) i WHERE i.value=?
 UNION ALL SELECT 1 FROM variants v,json_each(v.images) i WHERE i.value=? LIMIT 1`).get(url,url)}
function validateExisting(store,item){
 const row=store.db.prepare('SELECT * FROM media WHERE url=?').get(item.url);
 if(row&&(row.filename!==item.filename||row.width!==item.width||row.height!==item.height||row.bytes!==item.bytes))invalid('registered media conflicts with its immutable content.');
 if(store.db.prepare('SELECT 1 FROM media WHERE filename=? AND url<>?').get(item.filename,item.url))invalid('a media filename belongs to another URL.');
 const path=join(store.uploadDir,item.filename),stat=optionalStat(path);
 if(stat){const existing=readRegular(path,MAX_IMAGE_BYTES,'existing upload');if(hash(existing)!==item.sha256||existing.length!==item.bytes)invalid('an existing upload conflicts with its immutable content.');}
 return {row,path,exists:!!stat};
}

export function loadDraftBundle(store,directoryPath,{slot='default'}={}){
 if(!['default','mass'].includes(slot))invalid('unsupported bundle slot.');
 const markerTable=slot==='mass'?'emall_mass_versions':'draft_bundle_versions';
 const bundleDir=resolve(directoryPath),manifestPath=join(bundleDir,'manifest.json');
 if(!optionalStat(manifestPath))return {applied:false,reason:'missing'};
 directory(bundleDir,'bundle');
 let manifest;
 try{manifest=JSON.parse(readRegular(manifestPath,32*1024*1024,'manifest').toString('utf8'))}catch(error){if(error instanceof SyntaxError)invalid('manifest is not valid JSON.');throw error}
 keys(manifest,['version','source','products','media'],'manifest');
 if(manifest.version!==1)invalid('unsupported version.');
 keys(manifest.source,['provider','environment','account'],'source');
 if(Object.entries(SOURCE).some(([key,value])=>manifest.source[key]!==value))invalid('source must identify the production HomeHarmony catalog.');
 if(!Array.isArray(manifest.media)||manifest.media.length>40000)invalid('media must be a bounded array.');
 if(manifest.media.length)directory(join(bundleDir,'media'),'bundle media');
 const seen=new Set(),loaded=[];let total=0;
 for(const item of manifest.media){
  keys(item,['url','file','sha256','width','height','bytes'],'media item');
  if(typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256)||item.file!==item.sha256+'.webp'||item.url!=='/uploads/emall-'+item.sha256+'.webp'||seen.has(item.url))invalid('media must use distinct content-addressed local filenames.');
  seen.add(item.url);
  if(!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>MAX_IMAGE_BYTES||!Number.isSafeInteger(item.width)||!Number.isSafeInteger(item.height))invalid('media metadata is invalid.');
  total+=item.bytes;if(total>MAX_BUNDLE_BYTES)invalid('media exceeds the bundle size limit.');
  const bytes=readRegular(join(bundleDir,'media',item.file),MAX_IMAGE_BYTES,'bundle photo');
  if(bytes.length!==item.bytes||hash(bytes)!==item.sha256)invalid('media size or SHA-256 does not match its bytes.');
  const dimensions=webpSize(bytes);if(dimensions.width!==item.width||dimensions.height!==item.height)invalid('media dimensions do not match its WebP frame.');
  loaded.push({...item,filename:'emall-'+item.sha256+'.webp',content:bytes});
 }
 validateProducts(manifest.products,manifest.media,store);
 directory(resolve(store.uploadDir),'upload');
 for(const item of loaded)Object.assign(item,validateExisting(store,item));
 const digestHash=createHash('sha256').update(JSON.stringify(canonical(manifest)));
 for(const item of [...loaded].sort((a,b)=>a.url.localeCompare(b.url)))digestHash.update('\0'+item.url+'\0').update(item.content);
 const digest=digestHash.digest('hex'),scope=Object.values(SOURCE),db=store.db;
 const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(markerTable);
 const unchanged=exists&&db.prepare(`SELECT digest FROM ${markerTable} WHERE provider=? AND environment=? AND account=?`).get(...scope)?.digest===digest;
 if(!unchanged)db.exec(`CREATE TABLE IF NOT EXISTS ${markerTable}(
  provider TEXT NOT NULL,environment TEXT NOT NULL,account TEXT NOT NULL,digest TEXT NOT NULL,applied_at TEXT NOT NULL,
  PRIMARY KEY(provider,environment,account));`);
 const addedRows=[],addedFiles=[];
 try{
  for(const item of loaded){
   if(!item.exists){
    try{writeFileSync(item.path,item.content,{flag:'wx',mode:0o600});addedFiles.push(item)}catch(error){
     if(error.code!=='EEXIST')throw error;
     validateExisting(store,item);
    }
   }
   if(!item.row){db.prepare('INSERT INTO media(url,filename,width,height,bytes) VALUES(?,?,?,?,?)').run(item.url,item.filename,item.width,item.height,item.bytes);addedRows.push(item)}
  }
  if(unchanged)return {applied:false,reason:'unchanged',digest};
  const result=store.imports.apply(manifest.products,SOURCE,{limit:manifest.products.length,beforeCommit:()=>{
   db.prepare(`INSERT INTO ${markerTable} VALUES(?,?,?,?,?)
    ON CONFLICT(provider,environment,account) DO UPDATE SET digest=excluded.digest,applied_at=excluded.applied_at`).run(...scope,digest,new Date().toISOString());
  }});
  return {applied:true,digest,...result};
 }catch(error){
  // Only remove resources created by this attempt, and only while no saved product uses them.
  for(const item of addedRows)if(!referenced(db,item.url))db.prepare('DELETE FROM media WHERE url=? AND filename=?').run(item.url,item.filename);
  for(const item of addedFiles)if(!referenced(db,item.url)&&!db.prepare('SELECT 1 FROM media WHERE filename=?').get(item.filename)){
   try{unlinkSync(item.path)}catch(cleanupError){if(cleanupError.code!=='ENOENT')throw new AggregateError([error,cleanupError],'Draft bundle failed and its new upload could not be removed.');}
  }
  throw error;
 }
}
