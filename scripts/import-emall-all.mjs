// Read-only source import; writes a reviewed local draft bundle, never publishes.
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createEmallClient,EmallError} from '../server/emall.mjs';
import {prepareEmallRecords} from '../server/emall-adapter.mjs';
import {prepareEmallImages} from '../server/emall-media.mjs';
import {openStore,root} from '../server/store.mjs';
import {loadDraftBundle} from '../server/draft-bundle.mjs';
let staging,store,verification;
try{
 const args=process.argv.slice(2);let output=resolve(root,'var/emall-all'),limit=5000,resume=null;
 for(let i=0;i<args.length;i++){if(args[i]==='--output'&&args[i+1])output=resolve(args[++i]);else if(args[i]==='--resume'&&args[i+1])resume=resolve(args[++i]);else if(args[i]==='--limit'&&/^\d+$/.test(args[i+1]||''))limit=Number(args[++i]);else throw Error('INVALID_ARGUMENT')}
 if(!Number.isSafeInteger(limit)||limit<1||limit>5000)throw Error('INVALID_ARGUMENT');
 const fs=await import('node:fs/promises');try{await fs.lstat(output);throw Error('OUTPUT_EXISTS')}catch(e){if(e.code!=='ENOENT')throw e}
 const client=createEmallClient(),listed=await client.listProducts({limit});
 if(listed.total>listed.products.length)throw Error('CATALOG_LIMIT_EXCEEDED');
 const seed=await readFile(join(root,'catalog-data.js'),'utf8');
 const categories=JSON.parse(seed.slice(seed.indexOf('window.catalogData = ')+'window.catalogData = '.length).trim().replace(/;$/,'')).categories;
 const categoryMap=JSON.parse(await readFile(join(root,'data/emall-category-map.json'),'utf8'));
 const tree=await client.getCatalogCategories(),cache=new Map();
 const dictionaries={getCatalogCategories:async()=>tree,getCategoryProperties:async id=>{if(!cache.has(id))cache.set(id,await client.getCategoryProperties(id));return cache.get(id)}};
 await mkdir(resolve(output,'..'),{recursive:true});staging=await mkdtemp(join(resolve(output,'..'),'.emall-all-'));
 const products=[],media=new Map(),warnings=[],skipped=[];
 if(resume){
  verification=await mkdtemp(join(tmpdir(),'homeharmony-resume-check-'));store=openStore(verification);loadDraftBundle(store,resume,{slot:'mass'});store.close();store=null;await rm(verification,{recursive:true,force:true});verification=null;
  const previous=JSON.parse(await readFile(join(resume,'manifest.json'),'utf8')),review=JSON.parse(await readFile(join(resume,'review.json'),'utf8'));
  const currentIds=new Set(listed.products.map(p=>String(p.id)));products.push(...previous.products.filter(p=>currentIds.has(p.externalId)));
  const references=new Set(products.flatMap(p=>[...(p.images||[]),...p.variants.flatMap(v=>v.images||[])]));
  await mkdir(join(staging,'media'),{recursive:true});
  for(const item of previous.media)if(references.has(item.url)){await copyFile(join(resume,'media',item.file),join(staging,'media',item.file));media.set(item.url,item)}
  warnings.push(...(review.warnings||[]).filter(w=>!w.externalId||currentIds.has(w.externalId)));
 }
 const restoredIds=new Set(products.map(p=>p.externalId));
 for(const product of listed.products){
  if(restoredIds.has(String(product.id)))continue;
  let prepared,photos;
  try{
   prepared=await prepareEmallRecords({...dictionaries,listProducts:async()=>({products:[product]})},{limit:1,categories,categoryMap});
   try{photos=await prepareEmallImages(prepared.imageJobs,{directory:staging,allowUnavailable:true})}
   catch(photoError){
    if(photoError.code!=='NO_VALID_PHOTOS')throw photoError;
    let extra=[];
    try{const detail=await client.getProduct(product.id);extra=(detail.product.images||[]).filter(url=>!prepared.imageJobs[0].urls.includes(url))}catch{}
    if(!extra.length)throw photoError;
    photos=await prepareEmallImages([{externalId:String(product.id),urls:extra}],{directory:staging,allowUnavailable:true});
    prepared.warnings.push({code:'DETAIL_PHOTOS_USED',externalId:String(product.id)});
   }
   const record=prepared.records[0];if(!photos.imagesByExternalId[record.externalId]?.length)throw Error('NO_VALID_PHOTOS');
   record.images=photos.imagesByExternalId[record.externalId];products.push(record);
   for(const item of photos.media)media.set(item.url,item);
   warnings.push(...prepared.warnings,...photos.warnings);
  }catch(e){
   if(!['CATEGORY_UNMAPPED','PRICE_REQUIRED','STOCK_REQUIRED','INVALID_PRODUCT','NO_VALID_PHOTOS','HOST_NOT_ALLOWED','INVALID_SOURCE_URL'].includes(e.code||e.message))throw e;
   skipped.push({externalId:String(product.id),code:e.code||e.message,...(e.categoryReview?{categoryReview:e.categoryReview}:{})});
  }
  if((products.length+skipped.length)%25===0)console.error(JSON.stringify({processed:products.length+skipped.length,total:listed.products.length}));
 }
 if(!products.length){await writeFile(join(staging,'review.json'),JSON.stringify({received:listed.products.length,prepared:0,skipped,warnings},null,2)+'\n');await rename(staging,output);staging=null;throw Error('NO_IMPORTABLE_PRODUCTS')}
 const manifest={version:1,source:{provider:'emall',environment:'production',account:'homeharmony-emall-main'},products,media:[...media.values()]};
 await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 const review=JSON.stringify({received:listed.products.length,prepared:products.length,skipped,warnings},null,2);
 await writeFile(join(staging,'review.json'),(process.env.EMALL_API_TOKEN?review.split(process.env.EMALL_API_TOKEN).join('[redacted]'):review)+'\n');
 verification=await mkdtemp(join(tmpdir(),'homeharmony-verify-all-'));store=openStore(verification);loadDraftBundle(store,staging);loadDraftBundle(store,staging);
 if(store.products().filter(p=>p.variants.some(v=>v.sourceManaged)).length!==products.length||store.products(true).length!==14)throw Error('VERIFICATION_FAILED');
 store.close();store=null;await rename(staging,output);staging=null;
 const summary={received:listed.products.length,prepared:products.length,skipped:skipped.length,photos:media.size,published:0};
 console.log(JSON.stringify(summary));
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,'## Массовый импорт Emall\n\nПолучено товаров: '+summary.received+'\n\nПодготовлено карточек: '+summary.prepared+'\n\nПропущено: '+summary.skipped+'\n\nФотографий: '+summary.photos+'\n\nНовые товары подготовлены как черновики. Для применения на компьютере скачайте пакет emall-all.\n');
}catch(e){console.error(JSON.stringify({...(e instanceof EmallError?{status:e.status,diagnostic:e.diagnostic}:{}),error:['OUTPUT_EXISTS','INVALID_ARGUMENT','CATALOG_LIMIT_EXCEEDED','NO_IMPORTABLE_PRODUCTS','VERIFICATION_FAILED','TOKEN_MISSING','HTTP_ERROR','NETWORK','PAGINATION_ERROR','INVALID_RESPONSE','RESPONSE_TOO_LARGE','INVALID_CONFIG'].includes(e.code||e.message)?e.code||e.message:'IMPORT_FAILED'}));process.exitCode=1}
finally{store?.close();if(staging)await rm(staging,{recursive:true,force:true});if(verification)await rm(verification,{recursive:true,force:true})}
