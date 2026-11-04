// Read-only review of the five already approved draft IDs; never imports or publishes.
import {readFile,writeFile,mkdir,mkdtemp,rename,rm,lstat} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEmallClient,EmallError} from '../server/emall.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const SOURCE={provider:'emall',environment:'production',account:'homeharmony-emall-main'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=process.env.EMALL_API_TOKEN;
const integer=value=>typeof value==='string'&&/^\d+$/.test(value)?Number(value):value;
function boundedInteger(value,min=0){const result=integer(value);if(!Number.isSafeInteger(result)||result<min)throw new Error('INVALID_AUDIT_DATA');return result}
function plain(value,max=500){
 if(typeof value!=='string')return null;
 if(token)value=value.split(token).join('[redacted]');
 return value.replace(/<(script|style|template)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi,'')
  .replace(/<[^>]*>/g,'').replace(/[\x00-\x1f\x7f]/g,' ')
  .replace(/https?:\/\/[^\s<>]+/gi,'[link omitted]').trim().slice(0,max);
}
function optionalId(value){const id=integer(value);return Number.isSafeInteger(id)&&id>0?id:null}
function stockBreakdown(product){
 const result={};
 for(const key of ['warehouse_stock','available_stock','reserved'])if(Object.hasOwn(product,key)&&product[key]!==null)result[key]=boundedInteger(product[key]);
 return result;
}
function rawValue(value){
 const values=Array.isArray(value)?value:[value];
 if(values.length>50)throw new Error('AUDIT_LIMIT_EXCEEDED');
 return values.map(item=>{
  if(item===null||typeof item==='boolean')return item;
  if(typeof item==='number'&&Number.isFinite(item))return item;
  if(typeof item==='string')return plain(item);
  // Arbitrary objects and their keys must never enter the review artifact.
  return '[unsupported value]';
 });
}
function definition(entry,selectedIds){
 const property=object(entry.property)?entry.property:{},items=property.values??entry.values;
 if(items!==undefined&&!Array.isArray(items))throw new Error('INVALID_AUDIT_DATA');
 if((items?.length??0)>10000)throw new Error('AUDIT_LIMIT_EXCEEDED');
 const values=(items??[]).filter(item=>object(item)&&selectedIds.has(optionalId(item.id)))
  .map(item=>({id:optionalId(item.id),value:typeof item.value==='string'?plain(item.value):typeof item.value==='number'&&Number.isFinite(item.value)?String(item.value):null}));
 if(values.length>100)throw new Error('AUDIT_LIMIT_EXCEEDED');
 return {id:boundedInteger(entry.id,1),name:plain(entry.name,200)||plain(property.name,200),propertyId:optionalId(entry.property_id),nestedPropertyId:optionalId(property.id),type:plain(property.type?.name,60),values};
}
function savedSnapshot(product){
 if(!object(product)||!Array.isArray(product.variants)||product.variants.length!==1)throw new Error('INVALID_MANIFEST');
 const variant=product.variants[0],price=variant.price,old=variant.old??0;
 if(typeof price!=='number'||!Number.isFinite(price)||Math.abs(price*100-Math.round(price*100))>0.000001||typeof old!=='number'||!Number.isFinite(old)||Math.abs(old*100-Math.round(old*100))>0.000001)throw new Error('INVALID_MANIFEST');
 return {priceCents:boundedInteger(Math.round(price*100),1),oldPriceCents:boundedInteger(Math.round(old*100)),stock:boundedInteger(variant.stock)};
}
async function exists(path){try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
let staging,output=resolve(root,'var/emall-review');
try{
 const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){
  if(args[i]==='--output'&&args[i+1])output=resolve(args[++i]);else throw new Error('INVALID_ARGUMENT');
 }
 if(await exists(output))throw new Error('OUTPUT_EXISTS');
 const manifest=JSON.parse(await readFile(join(root,'data/emall-drafts/manifest.json'),'utf8'));
 if(!object(manifest.source)||Object.entries(SOURCE).some(([key,value])=>manifest.source[key]!==value)||!Array.isArray(manifest.products)||manifest.products.length!==5)throw new Error('INVALID_MANIFEST');
 const ids=manifest.products.map(product=>boundedInteger(product.externalId,1));
 if(new Set(ids).size!==5)throw new Error('INVALID_MANIFEST');
 const saved=manifest.products.map(savedSnapshot),client=createEmallClient(),products=[],dictionaryCache=new Map();
 let unresolvedProperties=0,differenceCount=0;
 for(const [index,id] of ids.entries()){
  const {product}=await client.getProduct(id),{product:short}=await client.getProductInfo(id);
  const categoryId=boundedInteger(product.category_id,1);
  if(!dictionaryCache.has(categoryId)){
   const {properties}=await client.getCategoryProperties(categoryId);
   if(!Array.isArray(properties)||properties.length>100)throw new Error('AUDIT_LIMIT_EXCEEDED');
   dictionaryCache.set(categoryId,properties);
  }
  const sourceProperties=product.properties===null||Array.isArray(product.properties)?{}:product.properties??{};
  if(!object(sourceProperties)||Object.keys(sourceProperties).length>100)throw new Error('AUDIT_LIMIT_EXCEEDED');
  const selectedIds=new Set(Object.values(sourceProperties).flatMap(value=>rawValue(value).map(optionalId)).filter(id=>id!==null));
  const definitions=dictionaryCache.get(categoryId).map(entry=>definition(entry,selectedIds));
  const properties=Object.entries(sourceProperties).map(([key,value])=>{
   const propertyId=optionalId(key),matched=definitions.find(entry=>entry.id===propertyId&&entry.name&&!/^\d+$/.test(entry.name))??null;
   if(!matched&&value!==null)unresolvedProperties++;
   return {propertyId,sourceKey:propertyId===null?plain(key,60):String(propertyId),raw:rawValue(value),resolved:matched!==null,definition:matched};
  });
  const current={detail:{priceCents:boundedInteger(product.prices?.price,1),oldPriceCents:product.prices?.old_price==null?0:boundedInteger(product.prices.old_price),stock:boundedInteger(product.stock)},short:{rawPrice:boundedInteger(short.product_price?.price,1),stock:boundedInteger(short.product_stock)}};
  current.detail.normalizedOldPriceCents=current.detail.oldPriceCents>current.detail.priceCents?current.detail.oldPriceCents:0;
  const differences=[];
  for(const field of ['priceCents','oldPriceCents','stock']){
   const value=field==='oldPriceCents'?current.detail.normalizedOldPriceCents:current.detail[field];
   if(saved[index][field]!==value)differences.push({field:'detail.'+field,saved:saved[index][field],current:value});
  }
  if(current.short.stock!==current.detail.stock)differences.push({field:'short.stock',detail:current.detail.stock,current:current.short.stock});
  if(current.short.rawPrice!==current.detail.priceCents)differences.push({field:'short.rawPrice',detailPriceCents:current.detail.priceCents,current:current.short.rawPrice});
  differenceCount+=differences.length;
  products.push({externalId:String(id),categoryId,saved:saved[index],current,stockBreakdown:{detail:stockBreakdown(product),short:stockBreakdown(short)},differences,properties,propertyDictionary:definitions});
 }
 const review={version:1,source:SOURCE,checkedAt:new Date().toISOString(),stockMeaning:'not-confirmed',shortPriceUnit:'not-separately-documented',products};
 await mkdir(dirname(output),{recursive:true});staging=await mkdtemp(join(dirname(output),'.emall-review-'));
 // Only selected scalar fields have been retained. Redact defensively once more.
 const serialized=JSON.stringify(review,null,2),redacted=token?serialized.split(token).join('[redacted]'):serialized;
 await writeFile(join(staging,'review.json'),redacted+'\n',{mode:0o600});
 if(await exists(output))throw new Error('OUTPUT_EXISTS');
 await rename(staging,output);staging=null;
 console.log(JSON.stringify({reviewed:5,differenceCount,unresolvedProperties,imported:0,published:0}));
 if(process.env.GITHUB_STEP_SUMMARY)await writeFile(process.env.GITHUB_STEP_SUMMARY,'## Проверка пяти черновиков Emall\n\n- Проверено карточек: 5\n- Расхождений: '+differenceCount+'\n- Нерасшифрованных свойств: '+unresolvedProperties+'\n- Изменено товаров: 0\n- Опубликовано: 0\n\nСмысл резервов для читаемых остатков и отдельная единица цены short/info документацией не подтверждены.\n');
}catch(error){
 const known=error instanceof EmallError,code=known?new EmallError(error.code).code:['INVALID_ARGUMENT','OUTPUT_EXISTS','INVALID_MANIFEST','INVALID_AUDIT_DATA','AUDIT_LIMIT_EXCEEDED'].includes(error.message)?error.message:'REVIEW_FAILED';
 const report={error:code};
 if(known){const safe=new EmallError(error.code,error.status,error.diagnostic);report.status=safe.status;if(safe.diagnostic)report.diagnostic=safe.diagnostic}
 console.error(JSON.stringify(report));process.exitCode=1;
}finally{if(staging)await rm(staging,{recursive:true,force:true})}
