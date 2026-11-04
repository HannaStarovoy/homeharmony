// Converts a bounded, read-only Emall result into the local draft import contract.
// Images are handed to the media importer separately; remote URLs never enter records.
import {EmallError} from './emall.mjs';

const ERRORS={
 INVALID_CONFIG:'Некорректные настройки подготовки каталога Emall.',
 INVALID_PRODUCT:'Карточка Emall содержит некорректные обязательные данные.',
 PRICE_REQUIRED:'В карточке Emall отсутствует корректная цена в копейках.',
 STOCK_REQUIRED:'В карточке Emall отсутствует корректный явный остаток.',
 CATEGORY_UNMAPPED:'Для категории Emall не задано безопасное соответствие локальному каталогу.',
 READ_FAILED:'Не удалось прочитать каталог Emall.'
};
export class EmallAdapterError extends Error{
 constructor(code,categoryId){
  const safe=Object.hasOwn(ERRORS,code)?code:'INVALID_PRODUCT';
  super(ERRORS[safe]);this.name='EmallAdapterError';this.code=safe;
  if(Number.isSafeInteger(categoryId)&&categoryId>0)this.categoryId=categoryId;
 }
}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const has=(value,key)=>Object.hasOwn(value,key);
function sourceInteger(value,min=0,max=Number.MAX_SAFE_INTEGER){
 if(typeof value==='string'){if(!/^\d+$/.test(value))return null;value=Number(value)}
 return Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;
}
function dictionaryFailure(error){
 try{
  if(error instanceof EmallError){
   // Revalidate even typed errors before copying their fixed diagnostic fields.
   const safe=new EmallError(error.code,error.status,error.diagnostic);
   return {code:safe.code,status:safe.status,diagnostic:safe.diagnostic};
  }
 }catch{}
 return {code:'DICTIONARY_UNAVAILABLE',status:null,diagnostic:null};
}
function categoryUnmapped(categoryId,path=[],dictionaryError=null){
 const error=new EmallAdapterError('CATEGORY_UNMAPPED',categoryId);
 error.categoryReview={categoryId,path:path.slice(0,20)
  .filter(name=>typeof name==='string').map(plaintext)
  .filter(name=>!/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i.test(name))
  .map(name=>name.slice(0,200)),dictionaryError};
 return error;
}
const entityNames={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ndash:'–',mdash:'—',hellip:'…',laquo:'«',raquo:'»',copy:'©',reg:'®',trade:'™',bull:'•',middot:'·',euro:'€',times:'×'};
function decodeEntities(value){
 return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(match,key)=>{
  if(key[0]!=='#')return entityNames[key.toLowerCase()]??match;
  const code=key[1]?.toLowerCase()==='x'?Number.parseInt(key.slice(2),16):Number(key.slice(1));
  return Number.isInteger(code)&&code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):'';
 });
}
function plaintext(value){
 return decodeEntities(decodeEntities(value))
  .replace(/<!--[^]*?(?:-->|$)/g,'')
  .replace(/<(script|style|template|noscript)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/gi,'')
  .replace(/<\s*br\b[^>]*>/gi,'\n').replace(/<\/?(?:p|div|li|h[1-6]|ul|ol|tr|table|section|article)\b[^>]*>/gi,'\n')
  .replace(/<[^>]*>/g,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
  .replace(/\r\n?/g,'\n').replace(/[^\S\n]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
const title=value=>typeof value==='string'?plaintext(value).toLocaleLowerCase('ru-RU'):'';
const ROOTS=new Set(['accessories','cosmetics','household','food','beauty-health']);
const AMBIGUOUS=new Set(['headbands','masks','sets','sponges']);
function localCatalog(categories){
 if(!Array.isArray(categories)||!categories.length)throw new EmallAdapterError('INVALID_CONFIG');
 const byId=new Map();
 for(const category of categories){
  if(!object(category)||typeof category.id!=='string'||typeof category.name!=='string'||byId.has(category.id))throw new EmallAdapterError('INVALID_CONFIG');
  byId.set(category.id,category);
 }
 function approved(id){
  const seen=new Set();let category=byId.get(id);
  while(category&&!seen.has(category.id)){
   if(ROOTS.has(category.id))return true;
   seen.add(category.id);category=byId.get(category.parent);
  }
  return false;
 }
 return {byId,approved};
}
function sourceCategoryPaths(categories){
 const paths=new Map();let count=0;
 function visit(items,path=[],depth=0){
  if(!Array.isArray(items)||depth>20)throw new EmallAdapterError('INVALID_PRODUCT');
  for(const category of items){
   const id=sourceInteger(category?.id,1);
   if(!object(category)||id===null||typeof category.name!=='string'||!category.name.trim()||++count>10000||paths.has(id))throw new EmallAdapterError('INVALID_PRODUCT');
   const next=[...path,category.name];paths.set(id,next);
   if(category.children!==null&&category.children!==undefined)visit(category.children,next,depth+1);
  }
 }
 visit(categories);return paths;
}
function matchCategory(path,catalog){
 const sourceTitles=path.map(title),matches=[];
 for(let depth=0;depth<sourceTitles.length;depth++){
  const sourceTitle=sourceTitles[depth];
  const candidates=[...catalog.byId.values()].filter(local=>local.id!=='all'&&catalog.approved(local.id)&&(title(local.name)===sourceTitle||(local.id==='food'&&sourceTitle==='продукты')));
  for(const local of candidates){
   if(AMBIGUOUS.has(local.id)){
    const ancestors=[];let parent=catalog.byId.get(local.parent),seen=new Set();
    while(parent&&parent.id!=='all'&&!seen.has(parent.id)){seen.add(parent.id);ancestors.push(title(parent.name));parent=catalog.byId.get(parent.parent)}
    if(!sourceTitles.slice(0,depth).some(value=>ancestors.includes(value)))continue;
   }
   matches.push({id:local.id,depth});
  }
 }
 if(!matches.length)return null;
 const deepest=Math.max(...matches.map(match=>match.depth)),ids=new Set(matches.filter(match=>match.depth===deepest).map(match=>match.id));
 return ids.size===1?[...ids][0]:null;
}
function scalar(value){
 if(typeof value==='string')return plaintext(value);
 if(typeof value==='number'&&Number.isFinite(value))return String(value);
 if(typeof value==='boolean')return value?'Да':'Нет';
 return '';
}
function propertyDictionary(properties){
 if(!Array.isArray(properties))throw new EmallAdapterError('INVALID_PRODUCT');
 const dictionary=new Map();
 for(const entry of properties){
  const id=sourceInteger(entry?.id,1);
  if(!object(entry)||id===null||dictionary.has(id))throw new EmallAdapterError('INVALID_PRODUCT');
  const property=object(entry.property)?entry.property:{},name=scalar(entry.name)||scalar(property.name);
  if(!name||/^\d+$/.test(name))continue;
  const values=new Map(),conflictingValues=new Set(),items=property.values??entry.values;
  if(Array.isArray(items))for(const item of items){
   const valueId=sourceInteger(item?.id,0),label=scalar(item?.value);
   if(valueId!==null&&label){
    if(values.has(valueId)&&values.get(valueId)!==label)conflictingValues.add(valueId);
    values.set(valueId,label);
   }
  }
  for(const valueId of conflictingValues)values.delete(valueId);
  const type=typeof property.type?.name==='string'?property.type.name.trim().toLowerCase():'';
  dictionary.set(id,{name,type,values,conflictingValues,enumerated:['list','select','multiselect','multiselect_list','multi_select','multi_select_list'].includes(type)||values.size>0||conflictingValues.size>0});
 }
 return dictionary;
}
function sharedPropertyDictionary(dictionaryCache){
 const shared=new Map(),conflicts=new Set();
 for(const [categoryId,dictionary] of dictionaryCache)for(const [id,definition] of dictionary){
  if(conflicts.has(id))continue;
  const previous=shared.get(id);
  if(definition.conflictingValues.size||(previous&&(previous.name!==definition.name||previous.type!==definition.type||previous.enumerated!==definition.enumerated))){shared.delete(id);conflicts.add(id);continue}
  if(!previous){shared.set(id,{...definition,values:new Map(definition.values),fromCategoryIds:[categoryId]});continue}
  for(const [valueId,label] of definition.values){
   if(previous.values.has(valueId)&&previous.values.get(valueId)!==label){shared.delete(id);conflicts.add(id);break}
   previous.values.set(valueId,label);
  }
  if(!conflicts.has(id))previous.fromCategoryIds.push(categoryId);
 }
 return shared;
}

export async function prepareEmallRecords(client,{limit=5,categories,categoryMap={}}={}){
 if(!object(client)||typeof client.listProducts!=='function'||!Number.isSafeInteger(limit)||limit<1||limit>5000||!object(categoryMap))throw new EmallAdapterError('INVALID_CONFIG');
 const catalog=localCatalog(categories),overrides=new Map();
 for(const [sourceId,localId] of Object.entries(categoryMap)){
  const id=sourceInteger(sourceId,1);
  if(id===null||typeof localId!=='string'||!catalog.approved(localId)||(overrides.has(id)&&overrides.get(id)!==localId))throw new EmallAdapterError('INVALID_CONFIG');
  overrides.set(id,localId);
 }
 const warnings=[],records=[],imageJobs=[];
 const warn=(code,detail={})=>warnings.push({code,...detail});
 let response;
 try{response=await client.listProducts({limit})}catch{throw new EmallAdapterError('READ_FAILED')}
 if(!object(response)||!Array.isArray(response.products))throw new EmallAdapterError('INVALID_PRODUCT');
 const products=response.products.slice(0,limit),ids=new Set();
 for(const product of products){
  const id=sourceInteger(product?.id,1);
  if(!object(product)||id===null||String(product.id).length>200||ids.has(id))throw new EmallAdapterError('INVALID_PRODUCT');
  ids.add(id);
 }
 if(!products.length)return {records,imageJobs,warnings};
 let categoryPaths=new Map(),dictionaryError=null;
 try{
  const result=await client.getCatalogCategories();
  categoryPaths=sourceCategoryPaths(Array.isArray(result)?result:result?.categories);
 }catch(error){dictionaryError=dictionaryFailure(error);warn('CATEGORY_DICTIONARY_UNAVAILABLE')}
 const selections=products.map(product=>{
  const categoryId=sourceInteger(product.category_id,1);
  const path=categoryPaths.get(categoryId)??(typeof product.category_name==='string'?[product.category_name]:[]);
  return {categoryId,path,cat:categoryId===null?null:overrides.get(categoryId)??matchCategory(path,catalog)};
 });
 const unmapped=selections.filter(item=>!item.cat);
 if(unmapped.length){
  const error=categoryUnmapped(unmapped[0].categoryId,unmapped[0].path,dictionaryError);
  const unique=[...new Map(unmapped.map(item=>[item.categoryId,item])).values()];
  if(unique.length>1)error.categoryReview.unmapped=unique.slice(0,5).map(item=>{
   const reviewed=categoryUnmapped(item.categoryId,item.path,null).categoryReview;
   return {categoryId:reviewed.categoryId,path:reviewed.path};
  });
  throw error;
 }
 const dictionaryCache=new Map();
 for(const {categoryId} of selections){
  if(dictionaryCache.has(categoryId))continue;
  try{
   const result=await client.getCategoryProperties(categoryId);
   dictionaryCache.set(categoryId,propertyDictionary(Array.isArray(result)?result:result?.properties));
  }catch{dictionaryCache.set(categoryId,new Map());warn('PROPERTIES_UNAVAILABLE',{categoryId})}
 }
 // Only already selected categories contribute definitions. A global source ID
 // may fill an absent definition when all observed names, types and value IDs agree.
 const sharedDictionary=sharedPropertyDictionary(dictionaryCache);
 for(const [index,product] of products.entries()){
  const externalId=String(product.id),detail={externalId},categoryId=sourceInteger(product.category_id,1);
  const cat=selections[index].cat;
  const kopecks=sourceInteger(product.prices?.price,1,100_000_000);
  if(kopecks===null)throw new EmallAdapterError('PRICE_REQUIRED');
  const stock=sourceInteger(product.stock,0,1_000_000);
  if(stock===null)throw new EmallAdapterError('STOCK_REQUIRED');
  let oldKopecks=product.prices.old_price==null?0:sourceInteger(product.prices.old_price,0,100_000_000);
  if(oldKopecks===null)throw new EmallAdapterError('INVALID_PRODUCT');
  if(oldKopecks>0&&oldKopecks<=kopecks){oldKopecks=0;warn('OLD_PRICE_RESET',detail)}
  function bounded(value,max,field){
   if(value.length>max){warn('TEXT_TRUNCATED',{...detail,field});return value.slice(0,max).trim()}
   return value;
  }
  if(typeof product.name!=='string'||!plaintext(product.name))throw new EmallAdapterError('INVALID_PRODUCT');
  if(product.description!=null&&typeof product.description!=='string')throw new EmallAdapterError('INVALID_PRODUCT');
  if(product.inner_article!=null&&typeof product.inner_article!=='string')throw new EmallAdapterError('INVALID_PRODUCT');
  const name=bounded(plaintext(product.name),200,'name'),summary=bounded(plaintext(product.description??''),10000,'summary'),attrs={};
  function addAttribute(rawName,rawValue){
   let key=scalar(rawName),value=scalar(rawValue);
   if(!key||!value||/^\d+$/.test(key))return;
   key=bounded(key,60,'attribute-name');value=bounded(value,500,'attribute-value');
   if(['__proto__','prototype','constructor'].includes(key)||has(attrs,key)){warn('ATTRIBUTE_SKIPPED',detail);return}
   if(Object.keys(attrs).length>=30){warn('ATTRIBUTES_TRUNCATED',detail);return}
   attrs[key]=value;
   return true;
  }
  for(const [field,label] of Object.entries({composition:'Состав',manufacturer_name:'Производитель',importer_name:'Импортёр',storage_period:'Условия и сроки хранения',service_centres:'Сервисные центры'})){
   if(product[field]!=null){
    if(typeof product[field]==='string')addAttribute(label,product[field]);
    else warn('OPTIONAL_FIELD_SKIPPED',{...detail,field});
   }
  }
  const warrantyUnits={days:'дн.',months:'мес.',years:'г.'},warranty=sourceInteger(product.warranty_value,1);
  if(warranty!==null&&has(warrantyUnits,product.warranty_unit))addAttribute('Гарантия',warranty+' '+warrantyUnits[product.warranty_unit]);
  const dictionary=dictionaryCache.get(categoryId);
  if(product.properties!=null&&!(Array.isArray(product.properties)&&product.properties.length===0)){
   if(!object(product.properties))throw new EmallAdapterError('INVALID_PRODUCT');
   for(const [propertyId,raw] of Object.entries(product.properties)){
    if(raw===null||raw===undefined)continue;
    const id=sourceInteger(propertyId,1),ownDefinition=id===null?null:dictionary.get(id);
    const fallback=id!==null&&!ownDefinition?sharedDictionary.get(id):null,definition=ownDefinition??fallback;
    if(id!==null&&!definition){warn('PROPERTY_UNRESOLVED',{...detail,categoryId,propertyId:id});continue}
    const values=Array.isArray(raw)?raw:[raw],decoded=[];
    for(const value of values){
     if(value===null||value===undefined)continue;
     if(definition?.enumerated){
      const valueId=sourceInteger(value,0),label=valueId===null?'':definition.values.get(valueId);
      if(label)decoded.push(label);else warn('PROPERTY_VALUE_UNRESOLVED',{...detail,categoryId,propertyId:id});
     }else{
      const text=scalar(value);if(text)decoded.push(text);else warn('OPTIONAL_FIELD_SKIPPED',{...detail,field:'properties'});
     }
    }
    if(addAttribute(definition?.name??propertyId,[...new Set(decoded)].join(', '))&&fallback){
     warn('PROPERTY_RESOLVED_FROM_SELECTED_CATEGORY',{...detail,propertyId:id,fromCategoryIds:fallback.fromCategoryIds});
    }
   }
  }
  if(product.images!=null&&!Array.isArray(product.images))throw new EmallAdapterError('INVALID_PRODUCT');
  const urls=[];
  for(const url of product.images??[]){
   if(typeof url!=='string'||!url.trim())throw new EmallAdapterError('INVALID_PRODUCT');
   if(!urls.includes(url))urls.push(url);
  }
  if(!urls.length)warn('NO_SOURCE_IMAGES',detail);
  records.push({externalId,name,summary,cat,attrs,images:[],variants:[{externalId,externalSku:bounded(product.inner_article??'',200,'externalSku'),price:kopecks/100,old:oldKopecks/100,stock,options:{},images:[]}]});
  imageJobs.push({externalId,urls});
 }
 return {records,imageJobs,warnings};
}
