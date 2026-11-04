// Reads Emall, builds a portable draft bundle, verifies it in an isolated database.
// No writes to Emall or the live shop database; credentials never enter the bundle.
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,stat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createEmallClient,EmallError} from '../server/emall.mjs';
import {prepareEmallRecords,EmallAdapterError} from '../server/emall-adapter.mjs';
import {prepareEmallImages,EmallMediaError} from '../server/emall-media.mjs';
import {openStore,root} from '../server/store.mjs';
import {loadDraftBundle} from '../server/draft-bundle.mjs';

let staging,tempDatabase,store,preparedReview,sourceClient,savedIds=false,output=resolve(root,'var/emall-prepared');
try{
 const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  if(args[i]==='--output'&&args[i+1])output=resolve(args[++i]);
  else if(args[i]==='--saved-ids'&&!savedIds)savedIds=true;
  else throw new Error('INVALID_ARGUMENT');
 }
 if(await stat(output).then(()=>true,()=>false))throw new Error('OUTPUT_EXISTS');
 await mkdir(dirname(output),{recursive:true});staging=await mkdtemp(join(dirname(output),'.emall-stage-'));
 const seed=await readFile(join(root,'catalog-data.js'),'utf8');
 const categories=JSON.parse(seed.slice(seed.indexOf('window.catalogData = ')+'window.catalogData = '.length).trim().replace(/;$/,'')).categories;
 let categoryMap={};try{categoryMap=JSON.parse(await readFile(join(root,'data/emall-category-map.json'),'utf8'))}catch(error){if(error.code!=='ENOENT')throw new Error('CATEGORY_MAP_INVALID')}
 let selectedIds;
 if(savedIds){
  try{
   const manifest=JSON.parse(await readFile(join(root,'data/emall-drafts/manifest.json'),'utf8'));
   const source={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
   if(!manifest.source||Object.keys(manifest.source).length!==3||Object.entries(source).some(([key,value])=>manifest.source[key]!==value)||!Array.isArray(manifest.products)||manifest.products.length!==5)throw new Error();
   selectedIds=manifest.products.map(product=>{
    const id=product?.externalId;
    if(typeof id!=='string'||!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id)))throw new Error();
    return id;
   });
   if(new Set(selectedIds).size!==5)throw new Error();
  }catch{throw new Error('INVALID_MANIFEST')}
 }
 sourceClient=createEmallClient();
 const preparationClient=savedIds?{...sourceClient,listProducts:async()=>{
  const products=[];
  for(const id of selectedIds)products.push((await sourceClient.getProduct(id)).product);
  return {environment:'production',products,pagesRead:5,total:5};
 }}:sourceClient;
 const prepared=await prepareEmallRecords(preparationClient,{limit:5,categories,categoryMap});
 if(prepared.records.length!==5)throw new Error('EXPECTED_FIVE_PRODUCTS');
 preparedReview=prepared;
 const photos=await prepareEmallImages(prepared.imageJobs,{directory:staging,allowUnavailable:true});
 for(const product of prepared.records)product.images=photos.imagesByExternalId[product.externalId]||[];
 const manifest={version:1,source:{provider:'emall',environment:'production',account:'homeharmony-emall-main'},products:prepared.records,media:photos.media};
 await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
 await writeFile(join(staging,'review.json'),JSON.stringify({warnings:[...prepared.warnings,...photos.warnings]},null,2)+'\n','utf8');
 tempDatabase=await mkdtemp(join(tmpdir(),'homeharmony-verify-drafts-'));store=openStore(tempDatabase);
 loadDraftBundle(store,staging);
 const drafts=store.products().filter(p=>p.status==='draft'&&p.variants.some(v=>v.sourceManaged));
 if(drafts.length!==5||store.products(true).length!==14)throw new Error('DRAFT_VERIFICATION_FAILED');
 loadDraftBundle(store,staging);
 if(store.products().filter(p=>p.status==='draft'&&p.variants.some(v=>v.sourceManaged)).length!==5)throw new Error('DUPLICATE_VERIFICATION_FAILED');
 store.close();store=null;
 await rename(staging,output);staging=null;
 const report={prepared:5,photos:photos.media.length,warningCount:prepared.warnings.length+photos.warnings.length,published:0};
 console.log(JSON.stringify(report));
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,'## Черновики Emall\n\n- Подготовлено карточек: 5\n- Загружено фотографий: '+report.photos+'\n- Предупреждений для проверки: '+report.warningCount+'\n- Опубликовано на витрине: 0\n\nПакет проверен в отдельной базе. На рабочий магазин он применяется после сохранения в репозитории.\n','utf8');
}catch(error){
 const known=error instanceof EmallError||error instanceof EmallAdapterError||error instanceof EmallMediaError;
 const report={error:known?error.code:['INVALID_ARGUMENT','OUTPUT_EXISTS','CATEGORY_MAP_INVALID','INVALID_MANIFEST','EXPECTED_FIVE_PRODUCTS','DRAFT_VERIFICATION_FAILED','DUPLICATE_VERIFICATION_FAILED'].includes(error.message)?error.message:'PREPARATION_FAILED'};
 if(Number.isSafeInteger(error.categoryId))report.categoryId=error.categoryId;
 if(known&&typeof error.hostname==='string'&&/^[a-z0-9.-]+$/i.test(error.hostname))report.hostname=error.hostname;
 if(known&&Number.isInteger(error.status))report.status=error.status;
 if(error instanceof EmallMediaError&&error.imageDiagnostic)report.imageDiagnostic=error.imageDiagnostic;
 if(error instanceof EmallAdapterError&&error.code==='CATEGORY_UNMAPPED'&&error.categoryReview){
  const value=JSON.stringify(error.categoryReview,null,2),token=process.env.EMALL_API_TOKEN;
  const redacted=token?value.split(token).join('[redacted]'):value;
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output+'.diagnostic.json',redacted+'\n','utf8');
 }
 if(error instanceof EmallMediaError&&preparedReview){
  const imageSources=[];
  for(const record of preparedReview.records){
   try{
    const {product}=await sourceClient.getProduct(record.externalId);
    const fieldNames=Object.keys(product).filter(key=>/image|photo|media|gallery/i.test(key)&&!/secret|token|auth|pass|cookie|key/i.test(key)&&/^[a-z0-9_]{1,60}$/i.test(key)).slice(0,20);
    const images=(product.images||[]).filter(value=>{
     try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password}catch{return false}
    });
    imageSources.push({externalId:record.externalId,images,fieldNames});
   }catch(detailError){imageSources.push({externalId:record.externalId,error:detailError instanceof EmallError?detailError.code:'DETAIL_UNAVAILABLE',status:detailError instanceof EmallError?detailError.status:null,diagnostic:detailError instanceof EmallError?detailError.diagnostic:null})}
  }
  const value=JSON.stringify({kind:'image-preparation',records:preparedReview.records,imageJobs:preparedReview.imageJobs,warnings:preparedReview.warnings,imageDiagnostic:error.imageDiagnostic??null,imageSources},null,2);
  const token=process.env.EMALL_API_TOKEN,redacted=token?value.split(token).join('[redacted]'):value;
  await mkdir(dirname(output),{recursive:true});await writeFile(output+'.diagnostic.json',redacted+'\n','utf8');
 }
 console.error(JSON.stringify(report));process.exitCode=1;
}finally{
 store?.close();if(staging)await rm(staging,{recursive:true,force:true});if(tempDatabase)await rm(tempDatabase,{recursive:true,force:true});
}
